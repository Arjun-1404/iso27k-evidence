-- Evidence Portal: let the server act on an org's connected storage on behalf of ordinary users (stage 7).
--
-- The problem: storage_connections is readable ONLY by an org admin (001's storage_connections_all
-- policy) — correctly, since token_ref is the encrypted credential for the auditor company's whole
-- Drive. But the people who actually upload evidence are tenant contributors, and the server needs that
-- credential to talk to Drive for them. Loosening the table's policy would let any role read the token
-- column; instead this narrow function hands the server exactly one thing — the caller's OWN org's
-- active connection for the org's chosen provider — and nothing about any other org.
--
-- Everything is derived from app.user_id inside the database (app_org(), app_role()), never from a
-- parameter, so there is no argument an attacker could change to name someone else's org. Roles that
-- never touch storage (the two dashboard-only roles) get nothing at all.

CREATE FUNCTION storage_credentials_for_caller()
RETURNS TABLE (out_connection_id uuid, out_provider text, out_token_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT sc.id, sc.provider, sc.token_ref
  FROM storage_connections sc
  JOIN orgs o ON o.id = sc.org_id AND o.storage_provider = sc.provider
  WHERE sc.org_id = app_org()
    AND sc.status = 'active'
    AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard')
$$;
COMMENT ON FUNCTION storage_credentials_for_caller() IS
  'The calling user''s own org''s active storage connection for the org''s configured provider. Zero rows when none, when the connection is revoked, or when the caller''s role never touches storage.';
GRANT EXECUTE ON FUNCTION storage_credentials_for_caller() TO portal_app;

-- When the provider rejects the stored refresh token (the admin revoked the app in their Google
-- account, or the account was removed), nothing will work until an admin reconnects. Recording that
-- fact lets the Integrations page say "reconnect" instead of every upload failing mysteriously.
-- Same shape as above: scoped to the caller's own org, derived inside the database. It can only move a
-- connection from 'active' to 'revoked' (never the reverse, never delete or alter the token), and the
-- audit entry is written here, attributed to whoever hit the failure.
CREATE FUNCTION storage_connection_flag_revoked(p_connection_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_org uuid := app_org(); v_conn uuid;
BEGIN
  IF v_org IS NULL THEN RETURN false; END IF;

  UPDATE storage_connections SET status = 'revoked'
  WHERE id = p_connection_id AND org_id = v_org AND status = 'active'
  RETURNING id INTO v_conn;

  IF v_conn IS NULL THEN RETURN false; END IF;

  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, ctx_user_id(), 'org.storage_revoked', 'storage_connection', v_conn::text,
          jsonb_build_object('reason', 'provider_rejected_credentials'));
  RETURN true;
END
$$;
GRANT EXECUTE ON FUNCTION storage_connection_flag_revoked(uuid) TO portal_app;
