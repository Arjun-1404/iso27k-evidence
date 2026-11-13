-- Evidence Portal: core schema (stage 1)
-- Security model: the application connects as the non-owner role "portal_app". Row-level security (RLS)
-- is enabled on every table. The application tells the database WHO is acting by setting one session
-- variable, app.user_id (from the verified login session). The database derives org, tenant and role
-- from the users table, so a bug in the application cannot claim a different org or role by itself.

-- ---------------------------------------------------------------- tables
CREATE TABLE licences (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  max_tenants           int  NOT NULL CHECK (max_tenants >= 0),
  max_auditor_users     int  NOT NULL CHECK (max_auditor_users >= 1),
  max_users_per_tenant  int  NOT NULL CHECK (max_users_per_tenant >= 1),
  valid_until           date,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orgs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id        uuid NOT NULL REFERENCES licences(id),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  storage_provider  text NOT NULL DEFAULT 'google_drive' CHECK (storage_provider IN ('google_drive', 'sharepoint')),
  allowed_domains   text[] NOT NULL CHECK (cardinality(allowed_domains) >= 1),
  exception_emails  text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  allowed_domains   text[] NOT NULL CHECK (cardinality(allowed_domains) >= 1),
  exception_emails  text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  storage_root_id   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id),
  tenant_id     uuid,
  email         text NOT NULL,
  full_name     text,
  role          text NOT NULL CHECK (role IN
                  ('org_admin', 'lead_auditor', 'auditor', 'read_only', 'dashboard_only',
                   'tenant_lead', 'contributor', 'viewer', 'tenant_dashboard')),
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (tenant_id, org_id) REFERENCES tenants (id, org_id),
  CONSTRAINT users_scope CHECK (
    (tenant_id IS NULL) = (role IN ('org_admin', 'lead_auditor', 'auditor', 'read_only', 'dashboard_only'))
  )
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE storage_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id),
  provider       text NOT NULL CHECK (provider IN ('google_drive', 'sharepoint')),
  account_label  text,
  token_ref      text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE auditor_assignments (
  org_id     uuid NOT NULL REFERENCES orgs(id),
  user_id    uuid NOT NULL,
  tenant_id  uuid NOT NULL,
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (user_id, org_id)   REFERENCES users (id, org_id),
  FOREIGN KEY (tenant_id, org_id) REFERENCES tenants (id, org_id)
);

CREATE TABLE control_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES orgs(id),            -- NULL = platform default template
  framework   text NOT NULL,
  version     text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_controls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        uuid NOT NULL REFERENCES control_templates(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('clause', 'annex')),
  section            text NOT NULL,
  control_ref        text NOT NULL,
  title              text NOT NULL,
  default_evidence   text NOT NULL DEFAULT '',
  default_file_spec  jsonb NOT NULL DEFAULT '{}',
  sort_order         int  NOT NULL DEFAULT 0,
  UNIQUE (template_id, control_ref)
);

CREATE TABLE audits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id),
  tenant_id         uuid NOT NULL,
  template_id       uuid REFERENCES control_templates(id) ON DELETE SET NULL,
  template_version  text NOT NULL,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status            text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'closed')),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, org_id) REFERENCES tenants (id, org_id),
  UNIQUE (id, org_id, tenant_id)
);

-- One row per control per audit. The template text is COPIED here (snapshot), so later edits to a
-- template never change a live audit. Effective evidence text = COALESCE(evidence_override, base_evidence).
CREATE TABLE audit_controls (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  tenant_id             uuid NOT NULL,
  audit_id              uuid NOT NULL,
  template_control_id   uuid REFERENCES template_controls(id) ON DELETE SET NULL,
  kind                  text NOT NULL CHECK (kind IN ('clause', 'annex')),
  section               text NOT NULL,
  control_ref           text NOT NULL,
  title                 text NOT NULL,
  base_evidence         text NOT NULL DEFAULT '',
  base_file_spec        jsonb NOT NULL DEFAULT '{}',
  evidence_override     text CHECK (evidence_override IS NULL OR length(evidence_override) BETWEEN 1 AND 4000),
  file_spec_override    jsonb,
  applicable            boolean NOT NULL DEFAULT true,
  na_justification      text,
  status                text NOT NULL DEFAULT 'not_started' CHECK (status IN
                          ('not_started', 'awaiting_evidence', 'submitted', 'under_review', 'accepted', 'rejected')),
  due_date              date,
  folder_id             text,
  last_reminded_at      timestamptz,
  requirement_changed_at timestamptz,
  sort_order            int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (audit_id, org_id, tenant_id) REFERENCES audits (id, org_id, tenant_id) ON DELETE CASCADE,
  UNIQUE (audit_id, control_ref),
  UNIQUE (id, org_id, tenant_id),
  CONSTRAINT clauses_always_applicable CHECK (kind = 'annex' OR applicable),
  CONSTRAINT na_needs_justification CHECK (applicable OR length(btrim(COALESCE(na_justification, ''))) >= 3)
);

CREATE TABLE control_assignments (
  org_id            uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  audit_control_id  uuid NOT NULL,
  user_id           uuid NOT NULL,
  PRIMARY KEY (audit_control_id, user_id),
  FOREIGN KEY (audit_control_id, org_id, tenant_id) REFERENCES audit_controls (id, org_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id)
);

-- Metadata only. The evidence file itself lives in the auditor company's own Drive or SharePoint.
CREATE TABLE evidence_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  audit_control_id  uuid NOT NULL,
  provider_file_id  text NOT NULL,
  file_name         text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  size_bytes        bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  mime_type         text,
  hash_algo         text,
  provider_hash     text,
  provider_version  text,
  scan_status       text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'unscannable', 'skipped')),
  integrity_status  text NOT NULL DEFAULT 'unchecked' CHECK (integrity_status IN ('unchecked', 'verified', 'modified', 'missing')),
  uploaded_by       uuid,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (audit_control_id, org_id, tenant_id) REFERENCES audit_controls (id, org_id, tenant_id) ON DELETE CASCADE,
  UNIQUE (audit_control_id, provider_file_id)
);

CREATE TABLE comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  audit_control_id  uuid NOT NULL,
  author_id         uuid NOT NULL,
  type              text NOT NULL DEFAULT 'comment' CHECK (type IN ('comment', 'major', 'minor', 'ofi', 'observation')),
  body              text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (audit_control_id, org_id, tenant_id) REFERENCES audit_controls (id, org_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, org_id) REFERENCES users (id, org_id)
);

CREATE TABLE reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  audit_control_id  uuid NOT NULL,
  reviewer_id       uuid NOT NULL,
  decision          text NOT NULL CHECK (decision IN ('accept', 'reject', 'reopen')),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (audit_control_id, org_id, tenant_id) REFERENCES audit_controls (id, org_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id, org_id) REFERENCES users (id, org_id),
  CONSTRAINT reject_needs_reason CHECK (decision <> 'reject' OR length(btrim(COALESCE(reason, ''))) >= 3)
);

CREATE SEQUENCE audit_log_seq;
CREATE TABLE audit_log (
  seq         bigint PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id),
  tenant_id   uuid,
  actor_id    uuid,
  action      text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity      text,
  entity_id   text,
  change      jsonb,
  prev_hash   text NOT NULL,
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX audit_log_org_seq ON audit_log (org_id, seq);

-- ---------------------------------------------------------------- context helpers
CREATE FUNCTION ctx_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT org_id FROM users WHERE id = ctx_user_id() AND status = 'active' $$;

CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT tenant_id FROM users WHERE id = ctx_user_id() AND status = 'active' $$;

CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT role FROM users WHERE id = ctx_user_id() AND status = 'active' $$;

CREATE FUNCTION is_auditor_side() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(app_role() IN ('org_admin', 'lead_auditor', 'auditor', 'read_only', 'dashboard_only'), false) $$;

-- Can the acting user see this tenant at all? Tenant users: their own tenant only.
-- Auditor side: org admins see all tenants of their org, everyone else only tenants assigned to them.
CREATE FUNCTION can_see_tenant(tid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT EXISTS (
    SELECT 1
    FROM users u JOIN tenants t ON t.org_id = u.org_id
    WHERE u.id = ctx_user_id() AND u.status = 'active' AND t.id = tid
      AND ( (u.tenant_id IS NOT NULL AND u.tenant_id = t.id)
         OR (u.tenant_id IS NULL AND (u.role = 'org_admin' OR EXISTS (
               SELECT 1 FROM auditor_assignments aa WHERE aa.user_id = u.id AND aa.tenant_id = t.id))))
  )
$$;

CREATE FUNCTION tenant_active(tid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT can_see_tenant(tid) AND EXISTS (SELECT 1 FROM tenants WHERE id = tid AND status = 'active') $$;

-- Read access to a control and its children (files, comments, reviews).
-- Dashboard-only roles never read control detail; contributors only see controls assigned to them.
CREATE FUNCTION can_read_control(p_org uuid, p_tenant uuid, p_control uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT p_org = app_org()
     AND can_see_tenant(p_tenant)
     AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard')
     AND (app_role() <> 'contributor' OR EXISTS (
            SELECT 1 FROM control_assignments ca WHERE ca.audit_control_id = p_control AND ca.user_id = ctx_user_id()))
$$;

CREATE FUNCTION status_transition_ok(old_s text, new_s text, r text) RETURNS boolean LANGUAGE sql IMMUTABLE AS
$$
  SELECT CASE
    WHEN old_s = new_s THEN true
    WHEN r IN ('tenant_lead', 'contributor') THEN new_s = 'submitted' AND old_s IN ('not_started', 'awaiting_evidence', 'rejected')
    WHEN r IN ('auditor', 'lead_auditor', 'org_admin') THEN
         (old_s = 'not_started' AND new_s = 'awaiting_evidence')
      OR (old_s IN ('submitted', 'under_review') AND new_s IN ('under_review', 'accepted', 'rejected'))
      OR (old_s = 'accepted' AND new_s = 'under_review')
    ELSE false
  END
$$;

-- ---------------------------------------------------------------- triggers
-- Licence caps (serialised per org so two parallel requests cannot both slip under the limit).
CREATE FUNCTION enforce_licence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE lic licences%ROWTYPE; cnt int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text, 1));
  SELECT l.* INTO lic FROM licences l JOIN orgs o ON o.licence_id = l.id WHERE o.id = NEW.org_id;
  IF TG_OP = 'INSERT' AND lic.valid_until IS NOT NULL AND lic.valid_until < current_date THEN
    RAISE EXCEPTION 'LICENCE_EXPIRED: licence ended on %', lic.valid_until USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'tenants' THEN
    IF NEW.status = 'active' THEN
      SELECT count(*) INTO cnt FROM tenants WHERE org_id = NEW.org_id AND status = 'active' AND id <> NEW.id;
      IF cnt + 1 > lic.max_tenants THEN
        RAISE EXCEPTION 'LICENCE_LIMIT: tenants (max %)', lic.max_tenants USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'users' THEN
    IF NEW.status <> 'disabled' THEN
      IF NEW.tenant_id IS NULL THEN
        SELECT count(*) INTO cnt FROM users WHERE org_id = NEW.org_id AND tenant_id IS NULL AND status <> 'disabled' AND id <> NEW.id;
        IF cnt + 1 > lic.max_auditor_users THEN
          RAISE EXCEPTION 'LICENCE_LIMIT: auditor users (max %)', lic.max_auditor_users USING ERRCODE = 'P0001';
        END IF;
      ELSE
        SELECT count(*) INTO cnt FROM users WHERE tenant_id = NEW.tenant_id AND status <> 'disabled' AND id <> NEW.id;
        IF cnt + 1 > lic.max_users_per_tenant THEN
          RAISE EXCEPTION 'LICENCE_LIMIT: users per tenant (max %)', lic.max_users_per_tenant USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenants_licence BEFORE INSERT OR UPDATE OF status ON tenants FOR EACH ROW EXECUTE FUNCTION enforce_licence();
CREATE TRIGGER users_licence   BEFORE INSERT OR UPDATE OF status ON users   FOR EACH ROW EXECUTE FUNCTION enforce_licence();

-- Corporate-domain rule: auditor-side users must use the org's domains, tenant users the tenant's domains.
CREATE FUNCTION enforce_email_domain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE doms text[]; exc text[]; dom text;
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF NEW.email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'INVALID_EMAIL' USING ERRCODE = 'P0001';
  END IF;
  dom := split_part(NEW.email, '@', 2);
  IF NEW.tenant_id IS NULL THEN
    SELECT allowed_domains, exception_emails INTO doms, exc FROM orgs WHERE id = NEW.org_id;
  ELSE
    SELECT allowed_domains, exception_emails INTO doms, exc FROM tenants WHERE id = NEW.tenant_id;
  END IF;
  IF NOT (dom = ANY (SELECT lower(x) FROM unnest(doms) x))
     AND NOT (NEW.email = ANY (SELECT lower(x) FROM unnest(exc) x)) THEN
    RAISE EXCEPTION 'DOMAIN_NOT_ALLOWED: %', dom USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_email_domain BEFORE INSERT OR UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION enforce_email_domain();

CREATE FUNCTION users_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: id, org and tenant of a user cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_immutable BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_immutable();

-- Guard rules for audit_controls: which role may change which columns, and legal status transitions.
CREATE FUNCTION audit_controls_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r text := app_role(); has_ev boolean;
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

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.applicable AND NEW.applicable) THEN
        RAISE EXCEPTION 'NOT_APPLICABLE: status of a not-applicable control cannot change' USING ERRCODE = 'P0001';
      END IF;
      IF NOT status_transition_ok(OLD.status, NEW.status, r) THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: % to % is not allowed for role %', OLD.status, NEW.status, r USING ERRCODE = 'P0001';
      END IF;
      IF NEW.status IN ('submitted', 'accepted') THEN
        SELECT EXISTS (SELECT 1 FROM evidence_files WHERE audit_control_id = NEW.id) INTO has_ev;
        IF NOT has_ev THEN
          RAISE EXCEPTION 'EVIDENCE_REQUIRED: no evidence file is recorded for this control' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;

    IF NEW.last_reminded_at IS DISTINCT FROM OLD.last_reminded_at THEN
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
CREATE TRIGGER audit_controls_guard BEFORE UPDATE ON audit_controls FOR EACH ROW EXECUTE FUNCTION audit_controls_guard();

-- Tamper-evident audit log: each row stores the hash of the previous row of the same org.
CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text, 2));
  SELECT hash INTO prev FROM audit_log WHERE org_id = NEW.org_id ORDER BY seq DESC LIMIT 1;
  NEW.seq        := nextval('audit_log_seq');
  NEW.created_at := clock_timestamp();
  NEW.prev_hash  := COALESCE(prev, 'genesis');
  NEW.hash       := audit_log_hash(NEW.prev_hash, NEW.org_id, NEW.actor_id, NEW.action, NEW.entity, NEW.entity_id, NEW.change, NEW.created_at);
  RETURN NEW;
END
$$;

CREATE FUNCTION audit_log_hash(p_prev text, p_org uuid, p_actor uuid, p_action text, p_entity text, p_entity_id text, p_change jsonb, p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS
$$
  SELECT encode(sha256(convert_to(
    p_prev || '|' || p_org::text || '|' || COALESCE(p_actor::text, '') || '|' || p_action || '|' || COALESCE(p_entity, '') || '|' ||
    COALESCE(p_entity_id, '') || '|' || COALESCE(p_change::text, '') || '|' ||
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
$$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: audit log rows cannot be changed or deleted' USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Returns the seq of the first row whose hash does not match, or NULL when the chain is intact.
CREATE FUNCTION verify_audit_chain(p_org uuid) RETURNS bigint LANGUAGE plpgsql AS
$$
DECLARE rec record; expected_prev text := 'genesis'; expected_hash text;
BEGIN
  FOR rec IN SELECT * FROM audit_log WHERE org_id = p_org ORDER BY seq LOOP
    expected_hash := audit_log_hash(expected_prev, rec.org_id, rec.actor_id, rec.action, rec.entity, rec.entity_id, rec.change, rec.created_at);
    IF rec.prev_hash <> expected_prev OR rec.hash <> expected_hash THEN RETURN rec.seq; END IF;
    expected_prev := rec.hash;
  END LOOP;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------- business functions
-- Copies a template into a new audit for a tenant (runs with the caller's rights, so RLS applies).
CREATE FUNCTION create_audit(p_tenant uuid, p_template uuid, p_name text) RETURNS uuid LANGUAGE plpgsql AS
$$
DECLARE v_audit uuid; v_version text;
BEGIN
  SELECT version INTO v_version FROM control_templates WHERE id = p_template;
  IF v_version IS NULL THEN RAISE EXCEPTION 'TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO audits (org_id, tenant_id, template_id, template_version, name, created_by)
    VALUES (app_org(), p_tenant, p_template, v_version, p_name, ctx_user_id()) RETURNING id INTO v_audit;
  INSERT INTO audit_controls (org_id, tenant_id, audit_id, template_control_id, kind, section, control_ref, title,
                              base_evidence, base_file_spec, sort_order)
    SELECT app_org(), p_tenant, v_audit, tc.id, tc.kind, tc.section, tc.control_ref, tc.title,
           tc.default_evidence, tc.default_file_spec, tc.sort_order
    FROM template_controls tc WHERE tc.template_id = p_template ORDER BY tc.sort_order;
  RETURN v_audit;
END
$$;

-- Aggregate numbers only. This is the only thing dashboard-only roles can read.
CREATE FUNCTION dashboard_summary(p_audit uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE tid uuid; res jsonb;
BEGIN
  SELECT tenant_id INTO tid FROM audits WHERE id = p_audit AND org_id = app_org();
  IF tid IS NULL OR NOT can_see_tenant(tid) THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
    'total', count(*),
    'applicable', count(*) FILTER (WHERE applicable),
    'not_applicable', count(*) FILTER (WHERE NOT applicable),
    'accepted', count(*) FILTER (WHERE applicable AND status = 'accepted'),
    'overdue', count(*) FILTER (WHERE applicable AND status <> 'accepted' AND due_date < current_date),
    'completion_pct', COALESCE(round(100.0 * count(*) FILTER (WHERE applicable AND status = 'accepted')
                              / NULLIF(count(*) FILTER (WHERE applicable), 0), 1), 0),
    'by_status', (SELECT COALESCE(jsonb_object_agg(status, c), '{}'::jsonb)
                  FROM (SELECT status, count(*) c FROM audit_controls WHERE audit_id = p_audit AND applicable GROUP BY status) s),
    'by_section', (SELECT COALESCE(jsonb_agg(jsonb_build_object('section', section, 'applicable', a, 'accepted', x) ORDER BY o), '[]'::jsonb)
                   FROM (SELECT section, min(sort_order) o, count(*) FILTER (WHERE applicable) a,
                                count(*) FILTER (WHERE applicable AND status = 'accepted') x
                         FROM audit_controls WHERE audit_id = p_audit GROUP BY section) q)
  ) INTO res FROM audit_controls WHERE audit_id = p_audit;
  RETURN res;
END
$$;

-- ---------------------------------------------------------------- row-level security
ALTER TABLE licences             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_connections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditor_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_controls    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audits               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_controls       ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_files       ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;

CREATE POLICY licences_select ON licences FOR SELECT TO portal_app
  USING (id = (SELECT licence_id FROM orgs WHERE id = (SELECT app_org())));

CREATE POLICY orgs_select ON orgs FOR SELECT TO portal_app USING (id = (SELECT app_org()));
CREATE POLICY orgs_update ON orgs FOR UPDATE TO portal_app
  USING (id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin')
  WITH CHECK (id = (SELECT app_org()));

-- Deliberately does not call can_see_tenant(id): a freshly inserted row must already satisfy this policy
-- (INSERT ... RETURNING), and a function looking the row up in the table cannot see it yet.
CREATE POLICY tenants_select ON tenants FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND (
           (SELECT app_role()) = 'org_admin'
           OR id = (SELECT app_tenant())
           OR EXISTS (SELECT 1 FROM auditor_assignments aa WHERE aa.user_id = ctx_user_id() AND aa.tenant_id = tenants.id)));
CREATE POLICY tenants_insert ON tenants FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin');
CREATE POLICY tenants_update ON tenants FOR UPDATE TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin' AND can_see_tenant(id))
  WITH CHECK (org_id = (SELECT app_org()));

CREATE POLICY users_select ON users FOR SELECT TO portal_app
  USING (id = ctx_user_id()
         OR (org_id = (SELECT app_org())
             AND ((tenant_id IS NULL AND is_auditor_side()) OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id)))));
CREATE POLICY users_insert ON users FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND (
      (SELECT app_role()) = 'org_admin'
      OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id) AND (
            (SELECT app_role()) = 'lead_auditor'
            OR ((SELECT app_role()) = 'tenant_lead' AND tenant_id = (SELECT app_tenant())
                AND role IN ('contributor', 'viewer', 'tenant_dashboard'))))));
CREATE POLICY users_update ON users FOR UPDATE TO portal_app
  USING (org_id = (SELECT app_org()) AND (
      (SELECT app_role()) = 'org_admin'
      OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id) AND (
            (SELECT app_role()) = 'lead_auditor'
            OR ((SELECT app_role()) = 'tenant_lead' AND tenant_id = (SELECT app_tenant())
                AND role IN ('contributor', 'viewer', 'tenant_dashboard'))))))
  WITH CHECK (org_id = (SELECT app_org()) AND (
      (SELECT app_role()) = 'org_admin'
      OR (tenant_id IS NOT NULL AND can_see_tenant(tenant_id) AND (
            (SELECT app_role()) = 'lead_auditor'
            OR ((SELECT app_role()) = 'tenant_lead' AND tenant_id = (SELECT app_tenant())
                AND role IN ('contributor', 'viewer', 'tenant_dashboard'))))));

CREATE POLICY storage_connections_all ON storage_connections FOR ALL TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin')
  WITH CHECK (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin');

CREATE POLICY auditor_assignments_select ON auditor_assignments FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND ((SELECT app_role()) = 'org_admin' OR user_id = ctx_user_id()));
CREATE POLICY auditor_assignments_insert ON auditor_assignments FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin');
CREATE POLICY auditor_assignments_delete ON auditor_assignments FOR DELETE TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin');

CREATE POLICY control_templates_select ON control_templates FOR SELECT TO portal_app
  USING (is_auditor_side() AND (org_id IS NULL OR org_id = (SELECT app_org())));
CREATE POLICY control_templates_write ON control_templates FOR ALL TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor'))
  WITH CHECK (org_id = (SELECT app_org()) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor'));
CREATE POLICY template_controls_select ON template_controls FOR SELECT TO portal_app
  USING (EXISTS (SELECT 1 FROM control_templates t WHERE t.id = template_id));
CREATE POLICY template_controls_write ON template_controls FOR ALL TO portal_app
  USING (EXISTS (SELECT 1 FROM control_templates t WHERE t.id = template_id AND t.org_id = (SELECT app_org())
                 AND (SELECT app_role()) IN ('org_admin', 'lead_auditor')))
  WITH CHECK (EXISTS (SELECT 1 FROM control_templates t WHERE t.id = template_id AND t.org_id = (SELECT app_org())
                 AND (SELECT app_role()) IN ('org_admin', 'lead_auditor')));

CREATE POLICY audits_select ON audits FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND can_see_tenant(tenant_id) AND (SELECT app_role()) NOT IN ('dashboard_only', 'tenant_dashboard'));
CREATE POLICY audits_insert ON audits FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor'));
CREATE POLICY audits_update ON audits FOR UPDATE TO portal_app
  USING (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor'))
  WITH CHECK (org_id = (SELECT app_org()));

CREATE POLICY audit_controls_select ON audit_controls FOR SELECT TO portal_app
  USING (can_read_control(org_id, tenant_id, id));
CREATE POLICY audit_controls_insert ON audit_controls FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor'));
CREATE POLICY audit_controls_update ON audit_controls FOR UPDATE TO portal_app
  USING (can_read_control(org_id, tenant_id, id) AND tenant_active(tenant_id)
         AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'auditor', 'tenant_lead', 'contributor'))
  WITH CHECK (org_id = (SELECT app_org()) AND can_see_tenant(tenant_id));

CREATE POLICY control_assignments_select ON control_assignments FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND can_see_tenant(tenant_id)
         AND (SELECT app_role()) NOT IN ('dashboard_only', 'tenant_dashboard')
         AND ((SELECT app_role()) <> 'contributor' OR user_id = ctx_user_id()));
CREATE POLICY control_assignments_insert ON control_assignments FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.tenant_id = control_assignments.tenant_id));
CREATE POLICY control_assignments_delete ON control_assignments FOR DELETE TO portal_app
  USING (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead'));

CREATE POLICY evidence_files_select ON evidence_files FOR SELECT TO portal_app
  USING (can_read_control(org_id, tenant_id, audit_control_id));
CREATE POLICY evidence_files_insert ON evidence_files FOR INSERT TO portal_app
  WITH CHECK (uploaded_by = ctx_user_id() AND can_read_control(org_id, tenant_id, audit_control_id) AND tenant_active(tenant_id)
              AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead', 'contributor'));

CREATE POLICY comments_select ON comments FOR SELECT TO portal_app
  USING (can_read_control(org_id, tenant_id, audit_control_id));
CREATE POLICY comments_insert ON comments FOR INSERT TO portal_app
  WITH CHECK (author_id = ctx_user_id() AND can_read_control(org_id, tenant_id, audit_control_id) AND tenant_active(tenant_id)
              AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'auditor', 'tenant_lead', 'contributor')
              AND (type = 'comment' OR is_auditor_side()));

CREATE POLICY reviews_select ON reviews FOR SELECT TO portal_app
  USING (can_read_control(org_id, tenant_id, audit_control_id));
CREATE POLICY reviews_insert ON reviews FOR INSERT TO portal_app
  WITH CHECK (reviewer_id = ctx_user_id() AND can_read_control(org_id, tenant_id, audit_control_id) AND tenant_active(tenant_id)
              AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'auditor'));

CREATE POLICY audit_log_select ON audit_log FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor'));
CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND actor_id = ctx_user_id() AND (tenant_id IS NULL OR can_see_tenant(tenant_id)));

-- ---------------------------------------------------------------- privileges for the application role
GRANT USAGE ON SCHEMA public TO portal_app;
GRANT SELECT ON licences, orgs, tenants, users, storage_connections, auditor_assignments, control_templates, template_controls,
                audits, audit_controls, control_assignments, evidence_files, comments, reviews, audit_log TO portal_app;
GRANT UPDATE (name, storage_provider, allowed_domains, exception_emails) ON orgs TO portal_app;
GRANT INSERT, UPDATE ON tenants, users, audits, audit_controls TO portal_app;
GRANT INSERT, UPDATE, DELETE ON storage_connections, control_templates, template_controls TO portal_app;
GRANT INSERT, DELETE ON auditor_assignments, control_assignments TO portal_app;
GRANT INSERT ON evidence_files, comments, reviews, audit_log TO portal_app;
