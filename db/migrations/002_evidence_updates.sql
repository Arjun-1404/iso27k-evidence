-- Evidence Portal: evidence status updates (stage 2)
-- Stage 1 only granted INSERT on evidence_files (recording a new upload). The integrity-check feature
-- needs to update two columns on an EXISTING row after the fact: scan_status (an async scan worker
-- finishing later) and integrity_status (a scheduled job comparing the stored hash to the provider's
-- current one). Added as its own migration, additive to 001, rather than editing an already-shipped one.

GRANT UPDATE (scan_status, integrity_status) ON evidence_files TO portal_app;

CREATE POLICY evidence_files_update ON evidence_files FOR UPDATE TO portal_app
  USING (can_read_control(org_id, tenant_id, audit_control_id) AND is_auditor_side())
  WITH CHECK (org_id = (SELECT app_org()));

-- Belt and braces: nothing but those two columns can change through this policy, even if a future
-- GRANT is widened by mistake — the identity and content columns of an evidence row are permanent.
CREATE FUNCTION evidence_files_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.audit_control_id <> OLD.audit_control_id
     OR NEW.provider_file_id <> OLD.provider_file_id OR NEW.file_name <> OLD.file_name
     OR NEW.provider_hash IS DISTINCT FROM OLD.provider_hash OR NEW.provider_version IS DISTINCT FROM OLD.provider_version
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.uploaded_at <> OLD.uploaded_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: only scan_status and integrity_status can be updated on an evidence file' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER evidence_files_guard BEFORE UPDATE ON evidence_files FOR EACH ROW EXECUTE FUNCTION evidence_files_guard();
