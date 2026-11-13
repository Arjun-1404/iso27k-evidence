-- Evidence Portal: more places to keep the evidence than Google Drive.
--
-- An organisation chooses ONE storage for its evidence: Google Drive (as before), a folder on the server's own disk
-- ('local'), or an S3-compatible object store ('s3'). SharePoint has had its place in these lists since the start and
-- is built later. The choice is orgs.storage_provider; the details of each choice live in storage_connections.

ALTER TABLE orgs DROP CONSTRAINT orgs_storage_provider_check;
ALTER TABLE orgs ADD CONSTRAINT orgs_storage_provider_check
  CHECK (storage_provider IN ('google_drive', 'sharepoint', 'local', 's3'));

ALTER TABLE storage_connections DROP CONSTRAINT storage_connections_provider_check;
ALTER TABLE storage_connections ADD CONSTRAINT storage_connections_provider_check
  CHECK (provider IN ('google_drive', 'sharepoint', 'local', 's3'));

-- Why the choice is locked once evidence exists: every evidence file is recorded as "file X in the storage", and X means
-- nothing in a different storage. Switching afterwards would leave the recorded evidence pointing at files that are not
-- there, which is exactly what an auditor must never be able to cause by accident. Before the first file is recorded,
-- switching is free, and the folders made in the old storage (which mean nothing in the new one) are forgotten so they
-- are created afresh. Enforced here in the database, so no route or script can get around it.
--
-- SECURITY DEFINER because forgetting the folders touches rows the caller (an org admin) could not otherwise change,
-- and counting the evidence has to see every file of the organisation. Nothing is accepted as a parameter: the
-- organisation is the row being changed.
CREATE FUNCTION orgs_storage_provider_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF NEW.storage_provider IS DISTINCT FROM OLD.storage_provider THEN
    IF EXISTS (SELECT 1 FROM evidence_files WHERE org_id = OLD.id) THEN
      RAISE EXCEPTION 'STORAGE_PROVIDER_LOCKED: This organisation already has evidence recorded in its current storage, so the storage can''t be changed any more.';
    END IF;
    UPDATE tenants SET storage_root_id = NULL WHERE org_id = OLD.id AND storage_root_id IS NOT NULL;
    -- A closed audit cycle is frozen (014) and can't hold new evidence anyway, so its folders are left alone.
    UPDATE audit_controls ac SET folder_id = NULL
    WHERE ac.org_id = OLD.id AND ac.folder_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM audits a WHERE a.id = ac.audit_id AND a.status <> 'closed');
    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
    VALUES (OLD.id, ctx_user_id(), 'org.storage_provider_changed', 'org', OLD.id::text,
            jsonb_build_object('from', OLD.storage_provider, 'to', NEW.storage_provider));
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER orgs_storage_provider_guard BEFORE UPDATE OF storage_provider ON orgs
  FOR EACH ROW EXECUTE FUNCTION orgs_storage_provider_guard();

-- Finishing a Google Drive connection (006) also makes Drive the organisation's storage, if it is still free to choose.
-- If evidence already lives elsewhere the connection is saved but not switched to, and the Integrations page says so.
CREATE OR REPLACE FUNCTION oauth_complete_connection(p_state_hash text, p_token_ref text, p_account_label text DEFAULT NULL)
RETURNS TABLE (out_org_id uuid, out_actor_id uuid, out_provider text, out_connection_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_org uuid; v_actor uuid; v_provider text; v_conn uuid;
BEGIN
  UPDATE oauth_states SET consumed_at = now()
  WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL
  RETURNING oauth_states.org_id, oauth_states.actor_id, oauth_states.provider INTO v_org, v_actor, v_provider;

  IF v_org IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO storage_connections (org_id, provider, token_ref, account_label, status)
  VALUES (v_org, v_provider, p_token_ref, p_account_label, 'active')
  ON CONFLICT (org_id, provider) DO UPDATE SET token_ref = EXCLUDED.token_ref, account_label = EXCLUDED.account_label, status = 'active'
  RETURNING id INTO v_conn;

  IF NOT EXISTS (SELECT 1 FROM evidence_files WHERE org_id = v_org) THEN
    UPDATE orgs SET storage_provider = v_provider WHERE id = v_org AND storage_provider <> v_provider;
  END IF;

  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_actor, 'org.storage_connected', 'storage_connection', v_conn::text, jsonb_build_object('provider', v_provider));

  RETURN QUERY SELECT v_org, v_actor, v_provider, v_conn;
END
$$;
