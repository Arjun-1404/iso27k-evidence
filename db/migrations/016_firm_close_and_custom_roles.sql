-- Evidence Portal: closing a control from the firm's side, and custom roles.
--
-- Two things the audit firm needs, both enforced here in the database (the web app and the API are only the way
-- people reach these rules; a bug in either cannot get around them).
--
-- 1. THE FIRM CAN CLOSE A CONTROL WITHOUT WAITING FOR THE CLIENT.
--    Until now a control could only become "accepted" after the client had uploaded evidence and submitted it. That is
--    right for evidence the client holds, but an auditor often gets the proof some other way (an interview, something
--    seen on site, a document already held), and a control that is not applicable needs nothing from the client at all
--    (those were already hidden from the client; marking one so is done with the applicability setting, unchanged).
--    The new review decision "close" lets an organisation admin, lead auditor or auditor move a control that has not
--    been submitted (not started, awaiting evidence or rejected, or one put back under review that has no file) straight
--    to accepted. A written reason is required;
--    it is kept on the review and is shown in the control's comment thread, so the client can see why.
--
-- 2. CUSTOM ROLES.
--    A custom role is one of the built-in roles with some of its abilities taken away, and a name of the firm's own
--    ("Junior auditor": an auditor who can review but not send reminders). It can only ever do LESS than the built-in
--    role it is based on, never more: every row-level-security rule in this database is written in terms of the built-in
--    roles, and each person's built-in role is still what those rules see. The custom role adds a second check,
--    app_allows(), in the few places where an ability can be switched off. Because it can only narrow, it cannot be used
--    to give anyone access they would not otherwise have.
--
-- Abilities that can be taken away (and who has them to start with):
--   review         accept, reject or close a control                                      lead auditor, auditor
--   remind         send a "evidence still needed" reminder                                lead auditor, auditor
--   applicability  mark a control applicable or not applicable                            lead auditor
--   due_dates      set or clear a control's due date                                      lead auditor
--   requirements   change what evidence a control asks for                                lead auditor
--   assign_controls hand a control to one of the client's people                          lead auditor, client lead
--   manage_people  invite, switch off or switch on people                                 lead auditor (clients' people), client lead
--   comment        add a comment to a control                                             lead auditor, auditor, client lead, contributor
--   close_cycle    close or reopen an audit cycle                                         lead auditor
--   upload         add evidence and submit it                                             client lead, contributor
-- (The organisation admin is deliberately not customisable: it is the owner role, and a custom role that could also edit
-- custom roles could give itself its abilities back.)

-- ------------------------------------------------------------------------------------------------ reviews: "close"
ALTER TABLE reviews DROP CONSTRAINT reviews_decision_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_decision_check CHECK (decision IN ('accept', 'reject', 'reopen', 'close'));
ALTER TABLE reviews DROP CONSTRAINT reject_needs_reason;
ALTER TABLE reviews ADD CONSTRAINT reject_needs_reason CHECK (decision NOT IN ('reject', 'close') OR length(btrim(COALESCE(reason, ''))) >= 3);

-- ---------------------------------------------------------------------------------------------- custom roles
CREATE TABLE custom_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id),
  name        text NOT NULL CONSTRAINT custom_roles_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  description text CONSTRAINT custom_roles_description_check CHECK (description IS NULL OR length(description) <= 500),
  base_role   text NOT NULL CONSTRAINT custom_roles_base_check CHECK (base_role IN ('lead_auditor', 'auditor', 'tenant_lead', 'contributor')),
  denied      text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  -- Only abilities the base role really has can be taken away (taking away one it never had would mean nothing).
  CONSTRAINT custom_roles_denied_fit_base CHECK (denied <@ CASE base_role
    WHEN 'lead_auditor' THEN ARRAY['review', 'remind', 'applicability', 'due_dates', 'requirements', 'assign_controls', 'manage_people', 'comment', 'close_cycle']
    WHEN 'auditor'      THEN ARRAY['review', 'remind', 'comment']
    WHEN 'tenant_lead'  THEN ARRAY['upload', 'assign_controls', 'manage_people', 'comment']
    WHEN 'contributor'  THEN ARRAY['upload', 'comment']
  END)
);
CREATE UNIQUE INDEX custom_roles_name_uq ON custom_roles (org_id, lower(btrim(name)));

-- The base of a role, and the organisation it belongs to, never change (people are tied to the base through users.role).
CREATE FUNCTION custom_roles_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.base_role <> OLD.base_role THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the organisation and the base role of a custom role cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_roles_immutable BEFORE UPDATE ON custom_roles FOR EACH ROW EXECUTE FUNCTION custom_roles_immutable();

ALTER TABLE users ADD COLUMN custom_role_id uuid;
ALTER TABLE users ADD CONSTRAINT users_custom_role_fk FOREIGN KEY (custom_role_id, org_id) REFERENCES custom_roles (id, org_id);

-- A person with a custom role has the base role of it as their built-in role (so every existing rule keeps applying to them).
CREATE FUNCTION users_custom_role_matches() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF NEW.custom_role_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM custom_roles cr WHERE cr.id = NEW.custom_role_id AND cr.org_id = NEW.org_id AND cr.base_role = NEW.role) THEN
    RAISE EXCEPTION 'INVALID_CUSTOM_ROLE: that custom role is not based on this person''s role' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_custom_role_matches BEFORE INSERT OR UPDATE OF role, custom_role_id ON users FOR EACH ROW EXECUTE FUNCTION users_custom_role_matches();

-- Only the audit firm hands out custom roles. Without this a client lead (who may invite and edit their own contributors)
-- could clear the restriction the firm put on one of them.
CREATE FUNCTION users_custom_role_who() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF app_role() IS NOT NULL AND app_role() NOT IN ('org_admin', 'lead_auditor')
     AND ((TG_OP = 'INSERT' AND NEW.custom_role_id IS NOT NULL)
          OR (TG_OP = 'UPDATE' AND NEW.custom_role_id IS DISTINCT FROM OLD.custom_role_id)) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: only the audit firm can give someone a custom role' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_custom_role_who BEFORE INSERT OR UPDATE OF custom_role_id ON users FOR EACH ROW EXECUTE FUNCTION users_custom_role_who();

ALTER TABLE custom_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_roles_select ON custom_roles FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND is_auditor_side());
CREATE POLICY custom_roles_write ON custom_roles FOR ALL TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin')
  WITH CHECK (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_roles TO portal_app;

GRANT SELECT (custom_role_id) ON users TO portal_app;
GRANT INSERT (custom_role_id) ON users TO portal_app;
GRANT UPDATE (custom_role_id) ON users TO portal_app;

-- Has the person making this request kept this ability? True unless their custom role took it away. Used only as an
-- extra condition next to the existing role checks, so it can narrow what a role may do and never widen it.
CREATE FUNCTION app_allows(perm text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT NOT EXISTS (
    SELECT 1 FROM users u JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id
    WHERE u.id = ctx_user_id() AND u.status = 'active' AND perm = ANY (cr.denied))
$$;

-- What the web app needs to know about the person signed in, to hide what they can't do (the rules above are what
-- actually stop them; hiding a button is only courtesy).
CREATE FUNCTION app_access() RETURNS TABLE (out_role text, out_custom_role_id uuid, out_custom_role_name text, out_denied text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT u.role, cr.id, cr.name, COALESCE(cr.denied, ARRAY[]::text[])
  FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id
  WHERE u.id = ctx_user_id() AND u.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION app_allows(text) TO portal_app;
GRANT EXECUTE ON FUNCTION app_access() TO portal_app;

-- ------------------------------------------------------------------- policies: the ability checks, added as one more condition
DROP POLICY reviews_insert ON reviews;
CREATE POLICY reviews_insert ON reviews FOR INSERT TO portal_app
  WITH CHECK (reviewer_id = ctx_user_id() AND can_read_control(org_id, tenant_id, audit_control_id) AND tenant_active(tenant_id)
              AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'auditor') AND app_allows('review'));

DROP POLICY comments_insert ON comments;
CREATE POLICY comments_insert ON comments FOR INSERT TO portal_app
  WITH CHECK (author_id = ctx_user_id() AND can_read_control(org_id, tenant_id, audit_control_id) AND tenant_active(tenant_id)
              AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'auditor', 'tenant_lead', 'contributor')
              AND (type = 'comment' OR is_auditor_side()) AND app_allows('comment'));

DROP POLICY evidence_files_insert ON evidence_files;
CREATE POLICY evidence_files_insert ON evidence_files FOR INSERT TO portal_app
  WITH CHECK (uploaded_by = ctx_user_id() AND can_read_control(org_id, tenant_id, audit_control_id) AND tenant_active(tenant_id)
              AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead', 'contributor') AND app_allows('upload'));

DROP POLICY control_assignments_insert ON control_assignments;
CREATE POLICY control_assignments_insert ON control_assignments FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')
              AND app_allows('assign_controls')
              AND EXISTS (SELECT 1 FROM users u
                          WHERE u.id = user_id
                            AND u.tenant_id = control_assignments.tenant_id
                            AND u.role IN ('contributor', 'tenant_lead')
                            AND u.status <> 'disabled'));
DROP POLICY control_assignments_delete ON control_assignments;
CREATE POLICY control_assignments_delete ON control_assignments FOR DELETE TO portal_app
  USING (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')
         AND app_allows('assign_controls'));

DROP POLICY users_insert ON users;
CREATE POLICY users_insert ON users FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND app_allows('manage_people') AND (
      (SELECT app_role()) = 'org_admin'
      OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id) AND (
            (SELECT app_role()) = 'lead_auditor'
            OR ((SELECT app_role()) = 'tenant_lead' AND tenant_id = (SELECT app_tenant())
                AND role IN ('contributor', 'viewer', 'tenant_dashboard'))))));
DROP POLICY users_update ON users;
CREATE POLICY users_update ON users FOR UPDATE TO portal_app
  USING (org_id = (SELECT app_org()) AND app_allows('manage_people') AND (
      (SELECT app_role()) = 'org_admin'
      OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id) AND (
            (SELECT app_role()) = 'lead_auditor'
            OR ((SELECT app_role()) = 'tenant_lead' AND tenant_id = (SELECT app_tenant())
                AND role IN ('contributor', 'viewer', 'tenant_dashboard'))))))
  WITH CHECK (org_id = (SELECT app_org()) AND app_allows('manage_people') AND (
      (SELECT app_role()) = 'org_admin'
      OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id) AND (
            (SELECT app_role()) = 'lead_auditor'
            OR ((SELECT app_role()) = 'tenant_lead' AND tenant_id = (SELECT app_tenant())
                AND role IN ('contributor', 'viewer', 'tenant_dashboard'))))));

-- ---------------------------------------------------------------------------------------- the controls guard
-- Which role may change which column, and which status changes are legal. Two additions to the version in 001:
--   * the firm's "close" (see the top of this file): a not-yet-submitted control goes to accepted, with no evidence file
--     needed, but only when a "close" review (with its reason) was written in this same transaction;
--   * the ability checks (app_allows) on the changes that can be switched off.
CREATE OR REPLACE FUNCTION audit_controls_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r text := app_role(); has_ev boolean; closing boolean := false;
BEGIN
  IF r IS NOT NULL THEN
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.audit_id <> OLD.audit_id
       OR NEW.kind <> OLD.kind OR NEW.section <> OLD.section OR NEW.control_ref <> OLD.control_ref OR NEW.title <> OLD.title
       OR NEW.base_evidence <> OLD.base_evidence OR NEW.base_file_spec <> OLD.base_file_spec
       OR NEW.template_control_id IS DISTINCT FROM OLD.template_control_id THEN
      RAISE EXCEPTION 'IMMUTABLE_COLUMN: control identity and template snapshot cannot be changed' USING ERRCODE = 'P0001';
    END IF;

    IF r IN ('tenant_lead', 'contributor') THEN
      IF (NEW.applicable, NEW.na_justification, NEW.evidence_override, NEW.file_spec_override, NEW.due_date, NEW.last_reminded_at)
         IS DISTINCT FROM (OLD.applicable, OLD.na_justification, OLD.evidence_override, OLD.file_spec_override, OLD.due_date, OLD.last_reminded_at) THEN
        RAISE EXCEPTION 'FORBIDDEN_COLUMN: tenant users can only submit evidence' USING ERRCODE = 'P0001';
      END IF;
    ELSIF r = 'auditor' THEN
      IF (NEW.applicable, NEW.na_justification, NEW.evidence_override, NEW.file_spec_override, NEW.due_date)
         IS DISTINCT FROM (OLD.applicable, OLD.na_justification, OLD.evidence_override, OLD.file_spec_override, OLD.due_date) THEN
        RAISE EXCEPTION 'FORBIDDEN_COLUMN: auditors cannot change applicability, requirements or due dates' USING ERRCODE = 'P0001';
      END IF;
    ELSIF r NOT IN ('lead_auditor', 'org_admin') THEN
      RAISE EXCEPTION 'FORBIDDEN_ROLE: role % cannot modify controls', r USING ERRCODE = 'P0001';
    END IF;

    -- Abilities a custom role may have taken away.
    IF (NEW.applicable, NEW.na_justification) IS DISTINCT FROM (OLD.applicable, OLD.na_justification) AND NOT app_allows('applicability') THEN
      RAISE EXCEPTION 'FORBIDDEN_PERMISSION: your role does not allow changing whether a control applies' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.due_date IS DISTINCT FROM OLD.due_date AND NOT app_allows('due_dates') THEN
      RAISE EXCEPTION 'FORBIDDEN_PERMISSION: your role does not allow changing due dates' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.evidence_override, NEW.file_spec_override) IS DISTINCT FROM (OLD.evidence_override, OLD.file_spec_override) AND NOT app_allows('requirements') THEN
      RAISE EXCEPTION 'FORBIDDEN_PERMISSION: your role does not allow changing what evidence a control asks for' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.applicable AND NEW.applicable) THEN
        RAISE EXCEPTION 'NOT_APPLICABLE: status of a not-applicable control cannot change' USING ERRCODE = 'P0001';
      END IF;

      -- The firm closing a control that was never submitted: legal only with a "close" review written in this transaction
      -- (a review's created_at is the transaction's start time, so an older review cannot be reused).
      closing := NEW.status = 'accepted' AND OLD.status IN ('not_started', 'awaiting_evidence', 'rejected', 'under_review')
                 AND r IN ('org_admin', 'lead_auditor', 'auditor')
                 AND EXISTS (SELECT 1 FROM reviews rv WHERE rv.audit_control_id = NEW.id AND rv.decision = 'close'
                             AND rv.reviewer_id = ctx_user_id() AND rv.created_at = now());

      IF NOT closing AND NOT status_transition_ok(OLD.status, NEW.status, r) THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: % to % is not allowed for role %', OLD.status, NEW.status, r USING ERRCODE = 'P0001';
      END IF;
      IF r IN ('org_admin', 'lead_auditor', 'auditor') AND NEW.status IN ('under_review', 'accepted', 'rejected') AND NOT app_allows('review') THEN
        RAISE EXCEPTION 'FORBIDDEN_PERMISSION: your role does not allow reviewing controls' USING ERRCODE = 'P0001';
      END IF;
      IF r IN ('tenant_lead', 'contributor') AND NEW.status = 'submitted' AND NOT app_allows('upload') THEN
        RAISE EXCEPTION 'FORBIDDEN_PERMISSION: your role does not allow submitting evidence' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.status IN ('submitted', 'accepted') AND NOT closing THEN
        SELECT EXISTS (SELECT 1 FROM evidence_files WHERE audit_control_id = NEW.id) INTO has_ev;
        IF NOT has_ev THEN
          RAISE EXCEPTION 'EVIDENCE_REQUIRED: no evidence file is recorded for this control' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;

    IF NEW.last_reminded_at IS DISTINCT FROM OLD.last_reminded_at THEN
      IF NOT app_allows('remind') THEN
        RAISE EXCEPTION 'FORBIDDEN_PERMISSION: your role does not allow sending reminders' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.status NOT IN ('not_started', 'awaiting_evidence', 'rejected') THEN
        RAISE EXCEPTION 'REMINDER_NOT_ALLOWED: evidence is not outstanding' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.last_reminded_at IS NOT NULL AND OLD.last_reminded_at > now() - interval '24 hours' THEN
        RAISE EXCEPTION 'REMINDER_RATE_LIMIT: a reminder was already sent in the last 24 hours' USING ERRCODE = 'P0001';
      END IF;
      NEW.last_reminded_at := now();
    END IF;
  END IF;

  IF (NEW.evidence_override, NEW.file_spec_override) IS DISTINCT FROM (OLD.evidence_override, OLD.file_spec_override)
     AND OLD.status IN ('submitted', 'under_review', 'accepted') THEN
    NEW.requirement_changed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ------------------------------------------------------------------------- closing and reopening an audit cycle
-- The same two functions as in 014, with the close_cycle ability check added after the role check.
CREATE OR REPLACE FUNCTION audit_close(p_audit uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_actor uuid := ctx_user_id(); a audits%ROWTYPE; v_applicable int; v_accepted int;
BEGIN
  SELECT * INTO a FROM audits WHERE id = p_audit AND org_id = app_org() AND can_see_tenant(tenant_id)
    AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Audit not found or not visible to you.' USING ERRCODE = 'P0001';
  END IF;
  IF app_role() NOT IN ('org_admin', 'lead_auditor') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only a lead auditor or an organisation admin can close or reopen an audit cycle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT app_allows('close_cycle') THEN
    RAISE EXCEPTION 'FORBIDDEN_PERMISSION: Your role does not allow closing or reopening an audit cycle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT tenant_active(a.tenant_id) THEN
    RAISE EXCEPTION 'TENANT_INACTIVE: This client is archived, so its audits can''t be changed. Restore the client first.' USING ERRCODE = 'P0001';
  END IF;
  IF a.status = 'closed' THEN
    RAISE EXCEPTION 'AUDIT_ALREADY_CLOSED: This audit cycle is already closed.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) FILTER (WHERE applicable), count(*) FILTER (WHERE applicable AND status = 'accepted')
    INTO v_applicable, v_accepted FROM audit_controls WHERE audit_id = a.id;

  UPDATE audits SET status = 'closed', closed_at = now(), closed_by = v_actor WHERE id = a.id;

  INSERT INTO audit_log (org_id, tenant_id, actor_id, action, entity, entity_id, change)
  VALUES (a.org_id, a.tenant_id, v_actor, 'audit.closed', 'audit', a.id::text,
          jsonb_build_object('name', a.name, 'applicableControls', v_applicable, 'acceptedControls', v_accepted));
END
$$;

CREATE OR REPLACE FUNCTION audit_reopen(p_audit uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_actor uuid := ctx_user_id(); a audits%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO a FROM audits WHERE id = p_audit AND org_id = app_org() AND can_see_tenant(tenant_id)
    AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Audit not found or not visible to you.' USING ERRCODE = 'P0001';
  END IF;
  IF app_role() NOT IN ('org_admin', 'lead_auditor') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only a lead auditor or an organisation admin can close or reopen an audit cycle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT app_allows('close_cycle') THEN
    RAISE EXCEPTION 'FORBIDDEN_PERMISSION: Your role does not allow closing or reopening an audit cycle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT tenant_active(a.tenant_id) THEN
    RAISE EXCEPTION 'TENANT_INACTIVE: This client is archived, so its audits can''t be changed. Restore the client first.' USING ERRCODE = 'P0001';
  END IF;
  IF a.status <> 'closed' THEN
    RAISE EXCEPTION 'AUDIT_NOT_CLOSED: This audit cycle isn''t closed.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'VALIDATION: Say why you are reopening this audit cycle (3 to 1000 characters). It is written to the audit log.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE audits SET status = 'in_progress', closed_at = NULL, closed_by = NULL WHERE id = a.id;

  INSERT INTO audit_log (org_id, tenant_id, actor_id, action, entity, entity_id, change)
  VALUES (a.org_id, a.tenant_id, v_actor, 'audit.reopened', 'audit', a.id::text,
          jsonb_build_object('name', a.name, 'reason', v_reason, 'closedAt', a.closed_at, 'closedBy', a.closed_by));
END
$$;
