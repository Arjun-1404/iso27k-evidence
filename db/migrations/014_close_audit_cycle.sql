-- Evidence Portal: closing an audit cycle (stage 14)
--
-- A finished audit should stay exactly as it was signed off. Closing a cycle makes it read-only:
--   * no control of it can change (status, applicability, requirements, due date, reminders, storage folder),
--   * no evidence can be recorded or removed, no comment or review added, no control assigned or unassigned,
--   * the cycle itself cannot be renamed.
-- What still works on a closed cycle: reading everything, the dashboard, and the evidence integrity check's
-- detection (it can still flag a stored file that changed or went missing afterwards; a malware scan result
-- can still arrive for a file recorded before closing).
--
-- Only audit_close() and audit_reopen() change the status. Both are limited to lead auditors and organisation
-- admins, both write to the tamper-evident audit log themselves (so a close or reopen can never go unlogged),
-- and reopening needs a reason.
--
-- The lock is in the database (triggers), so it holds whichever way a change arrives: through the web app,
-- through a future API route, or through a script. Whole-audit removal by a database administrator (deleting the
-- audit itself) is not affected: only changes to pieces of a closed audit are refused.
-- Additive to 001–013; none of those files is edited.

ALTER TABLE audits ADD COLUMN closed_at timestamptz;
ALTER TABLE audits ADD COLUMN closed_by uuid;

-- Nothing could close an audit before this migration, but make the constraint safe regardless.
UPDATE audits SET closed_at = created_at WHERE status = 'closed' AND closed_at IS NULL;
ALTER TABLE audits ADD CONSTRAINT audits_closed_consistent CHECK ((status = 'closed') = (closed_at IS NOT NULL));

-- The application role may no longer write the status (or the closing time/person) directly: only the two
-- functions below do. It keeps what it used: creating an audit (through create_audit) and renaming one.
REVOKE INSERT, UPDATE ON audits FROM portal_app;
GRANT INSERT (org_id, tenant_id, template_id, template_version, name, created_by) ON audits TO portal_app;
GRANT UPDATE (name) ON audits TO portal_app;

-- ---------------------------------------------------------------- the lock
-- A closed cycle's own row can only leave the closed state (reopen), never change while closed (e.g. be renamed).
CREATE FUNCTION audits_closed_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'closed' THEN
    RAISE EXCEPTION 'AUDIT_CLOSED: This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audits_closed_guard BEFORE UPDATE ON audits FOR EACH ROW EXECUTE FUNCTION audits_closed_guard();

-- Refuses any change to the pieces of a closed cycle. SECURITY DEFINER so that the lookup is not hidden by
-- row-level security from, say, a contributor who cannot read the audits table.
-- Both the old and the new row are checked on UPDATE, so a row cannot be moved out of (or into) a closed cycle.
-- A row removed because its parent was removed (a whole control or audit deleted) is not refused: by then the
-- parent no longer exists, so there is nothing to find.
CREATE FUNCTION audit_closed_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_old jsonb; v_new jsonb; v_closed boolean;
BEGIN
  -- Scan results and integrity flags on an already recorded file may still arrive (evidence_files_guard
  -- already limits an update to exactly those two columns).
  IF TG_TABLE_NAME = 'evidence_files' AND TG_OP = 'UPDATE' THEN RETURN NEW; END IF;

  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;

  SELECT EXISTS (
    SELECT 1
    FROM audits a
    WHERE a.status = 'closed'
      AND a.id IN (
        SELECT CASE WHEN TG_TABLE_NAME = 'audit_controls'
                    THEN (r.j ->> 'audit_id')::uuid
                    ELSE (SELECT ac.audit_id FROM audit_controls ac WHERE ac.id = (r.j ->> 'audit_control_id')::uuid)
               END
        FROM (VALUES (v_old), (v_new)) AS r (j)
        WHERE r.j IS NOT NULL)
  ) INTO v_closed;

  IF v_closed THEN
    RAISE EXCEPTION 'AUDIT_CLOSED: This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- Named so that it runs before the other guards on these tables (triggers fire in name order): the answer
-- "this audit is closed" is more useful than a complaint about a status transition.
CREATE TRIGGER audit_closed_lock BEFORE INSERT OR UPDATE OR DELETE ON audit_controls
  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();
CREATE TRIGGER audit_closed_lock BEFORE INSERT OR UPDATE OR DELETE ON control_assignments
  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();
CREATE TRIGGER audit_closed_lock BEFORE INSERT OR UPDATE OR DELETE ON evidence_files
  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();
CREATE TRIGGER audit_closed_lock BEFORE INSERT OR UPDATE OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();
CREATE TRIGGER audit_closed_lock BEFORE INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();

-- ---------------------------------------------------------------- closing and reopening
-- Looks up the audit the way the audits table's own read rule does (own organisation, a client the caller can
-- see, not a dashboard-only role), then checks the role. An audit the caller cannot see is "not found"; one they can see but may not close is "forbidden".
CREATE FUNCTION audit_close(p_audit uuid) RETURNS void
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

CREATE FUNCTION audit_reopen(p_audit uuid, p_reason text) RETURNS void
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

GRANT EXECUTE ON FUNCTION audit_close(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION audit_reopen(uuid, text) TO portal_app;
