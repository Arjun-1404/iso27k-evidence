-- Evidence Portal: complete an OAuth connection (stage 6, continued)
-- Deliberately a SEPARATE function from oauth_state_consume (005), not that function plus a second
-- "write using this org_id" call: a function that accepted org_id as a bare parameter would let ANY
-- caller who can execute SQL as portal_app overwrite any org's storage connection just by naming its
-- id — the state token would no longer be the thing that actually authorizes the write. Consuming the
-- state and writing the connection happen in the same atomic step instead, so org_id is derived
-- entirely from the verified, single-use token and is never accepted as trusted input. The audit log
-- entry is written here too, for the identical reason: a general-purpose "log this for org X" function
-- open to an unauthenticated caller would itself be a way to forge log entries for any org, so logging
-- only ever happens as a side effect of this same verified, atomic step — never as its own callable
-- primitive. (The ordinary, authenticated audit-log path everywhere else in the app still requires
-- actor_id = ctx_user_id(), enforced by audit_log's own RLS policy — this function doesn't change that.)

-- The RETURNS TABLE columns below are named out_* rather than org_id/provider/actor_id on purpose:
-- PL/pgSQL turns RETURNS TABLE columns into implicitly-declared variables in scope for the whole
-- function body, and this function's own INSERT ... ON CONFLICT (org_id, provider) target list needs
-- bare, unqualified column names — naming the OUT columns the same thing makes that reference
-- genuinely ambiguous. actor_id is returned too so the caller (the HTTP callback) can attribute the
-- audit log entry to whoever started the flow without a second round trip to re-read the now-consumed
-- state row.
CREATE FUNCTION oauth_complete_connection(p_state_hash text, p_token_ref text, p_account_label text DEFAULT NULL)
RETURNS TABLE (out_org_id uuid, out_actor_id uuid, out_provider text, out_connection_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_org uuid; v_actor uuid; v_provider text; v_conn uuid;
BEGIN
  UPDATE oauth_states SET consumed_at = now()
  WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL
  RETURNING oauth_states.org_id, oauth_states.actor_id, oauth_states.provider INTO v_org, v_actor, v_provider;

  IF v_org IS NULL THEN
    RETURN; -- unknown, expired, or already-used state — empty result, same as oauth_state_consume
  END IF;

  INSERT INTO storage_connections (org_id, provider, token_ref, account_label, status)
  VALUES (v_org, v_provider, p_token_ref, p_account_label, 'active')
  ON CONFLICT (org_id, provider) DO UPDATE SET token_ref = EXCLUDED.token_ref, account_label = EXCLUDED.account_label, status = 'active'
  RETURNING id INTO v_conn;

  -- The existing audit_log_chain trigger (001) fires on this INSERT exactly as it would for any other
  -- one, so the hash chain stays correct with no special handling needed here.
  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_actor, 'org.storage_connected', 'storage_connection', v_conn::text, jsonb_build_object('provider', v_provider));

  RETURN QUERY SELECT v_org, v_actor, v_provider, v_conn;
END
$$;
COMMENT ON FUNCTION oauth_complete_connection(text, text, text) IS
  'Returns one row (out_org_id, out_actor_id, out_provider, out_connection_id) on success, zero rows for an unknown, expired, or already-used state.';
GRANT EXECUTE ON FUNCTION oauth_complete_connection(text, text, text) TO portal_app;
