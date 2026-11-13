-- Evidence Portal: built-in email + password authentication (stage 5, open-source pivot)
-- Auth0/OIDC (TokenVerifier) remains supported as an alternative — this migration adds a second,
-- self-contained option so the project can be cloned and run with no external identity provider.
--
-- The hard part: login happens BEFORE we know who is asking, so it cannot go through the normal
-- row-level-security path (every policy in 001 keys off ctx_user_id(), which is unset at login time —
-- RLS would correctly return zero rows for everything). Rather than add a broad bypass role, this adds
-- a small number of narrowly-scoped SECURITY DEFINER functions — the same pattern 001 already uses for
-- app_org(), can_see_tenant(), dashboard_summary() — each doing exactly one auth-related lookup or
-- write and nothing else. Everything else in the schema keeps enforcing RLS exactly as before.

ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN invite_token_hash text;
ALTER TABLE users ADD COLUMN invite_token_expires_at timestamptz;
ALTER TABLE users ADD COLUMN failed_login_count int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until timestamptz;
CREATE UNIQUE INDEX users_invite_token_hash_uq ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- 001 granted UPDATE on ALL columns of users (there was no password column yet to worry about). That
-- grant would now let any org admin set someone else's password_hash directly through the ordinary
-- RLS path, bypassing the invite-token flow entirely. Narrow it to the columns that should ever be
-- settable that way; password_hash, failed_login_count and locked_until are reachable ONLY through the
-- SECURITY DEFINER functions below. Creating an invite token itself stays on the ordinary authenticated
-- path (an admin/lead/tenant_lead inviting someone) — the users_update RLS policy already encodes
-- exactly who may do that for whom.
REVOKE UPDATE ON users FROM portal_app;
GRANT UPDATE (email, full_name, role, status, invite_token_hash, invite_token_expires_at) ON users TO portal_app;

-- --- unauthenticated lookups and writes, each scoped to exactly what the auth flow needs -----------

CREATE FUNCTION auth_lookup_by_email(p_email text) RETURNS TABLE (
  id uuid, org_id uuid, tenant_id uuid, role text, status text, password_hash text, failed_login_count int, locked_until timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT id, org_id, tenant_id, role, status, password_hash, failed_login_count, locked_until FROM users WHERE lower(email) = lower(p_email) $$;

CREATE FUNCTION auth_lookup_by_invite_token(p_token_hash text) RETURNS TABLE (
  id uuid, email text, status text, invite_token_expires_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT id, email, status, invite_token_expires_at FROM users WHERE invite_token_hash = p_token_hash $$;

CREATE FUNCTION auth_record_login_failure(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  UPDATE users SET failed_login_count = failed_login_count + 1,
                    locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
  WHERE id = p_user_id
$$;

CREATE FUNCTION auth_record_login_success(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = p_user_id $$;

-- Verifies the invite token (and that it has not expired) and sets the password in one atomic step,
-- so a token can never be "partially" consumed. Returns the user id on success, NULL otherwise — the
-- caller cannot distinguish "wrong token" from "expired token" from this alone, which is deliberate:
-- a login/invite endpoint should never give an attacker more detail than it has to.
CREATE FUNCTION auth_complete_invite(p_token_hash text, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_id uuid;
BEGIN
  UPDATE users SET password_hash = p_password_hash, status = 'active', invite_token_hash = NULL, invite_token_expires_at = NULL,
                    failed_login_count = 0, locked_until = NULL
  WHERE invite_token_hash = p_token_hash AND invite_token_expires_at > now()
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION auth_lookup_by_email(text) TO portal_app;
GRANT EXECUTE ON FUNCTION auth_lookup_by_invite_token(text) TO portal_app;
GRANT EXECUTE ON FUNCTION auth_record_login_failure(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION auth_record_login_success(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION auth_complete_invite(text, text) TO portal_app;
