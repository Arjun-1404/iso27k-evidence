-- Evidence Portal: OAuth state tokens (stage 6, Drive/SharePoint "Connect" flow)
-- An OAuth authorization flow has the same awkward shape as the invite-accept flow: the browser starts
-- out authenticated (an org admin clicks "Connect"), but the CALLBACK leg — when the provider redirects
-- the browser back with a code — carries no session at all, just a `state` value we handed out earlier.
-- Same pattern as 004's invite tokens: a random, hashed, single-use, expiring token, looked up through a
-- narrow SECURITY DEFINER function rather than a broad RLS bypass.

CREATE TABLE oauth_states (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id),
  actor_id    uuid NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('google_drive', 'sharepoint')),
  state_hash  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE UNIQUE INDEX oauth_states_state_hash_uq ON oauth_states (state_hash);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

-- Starting a flow is an ordinary authenticated action (an org admin clicking "Connect"), so it goes
-- through normal RLS — org_id is derived from the caller's own row, same as every other org-scoped
-- insert in this schema, never trusted from the client.
CREATE POLICY oauth_states_insert ON oauth_states FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND actor_id = ctx_user_id() AND (SELECT app_role()) = 'org_admin');
CREATE POLICY oauth_states_select ON oauth_states FOR SELECT TO portal_app
  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin');

GRANT INSERT, SELECT ON oauth_states TO portal_app;

-- The callback itself: verifies the state (exists, not expired, not already used), consumes it
-- atomically, and hands back just enough to proceed — which org and provider this was for. Runs with
-- no session context (the browser redirect from the provider carries none), so RLS would otherwise
-- filter this to nothing, same reasoning as auth_complete_invite in 004.
CREATE FUNCTION oauth_state_consume(p_state_hash text) RETURNS TABLE (org_id uuid, actor_id uuid, provider text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  RETURN QUERY
    UPDATE oauth_states SET consumed_at = now()
    WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL
    RETURNING oauth_states.org_id, oauth_states.actor_id, oauth_states.provider;
END
$$;
GRANT EXECUTE ON FUNCTION oauth_state_consume(text) TO portal_app;
