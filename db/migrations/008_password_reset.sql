-- Evidence Portal: password reset (stage 9)
-- Same shape as the invite and OAuth flows (004, 005/006): the person asking is, by definition, NOT signed
-- in, so none of the row-level-security policies (which all key off ctx_user_id()) can apply. Rather than
-- loosen them, this adds a table the app role cannot touch at all, plus a few narrow SECURITY DEFINER
-- functions that each do exactly one step of the flow.
--
-- What the database enforces, so no application bug or caller can weaken it:
--   * a reset link lives for ONE HOUR (the app cannot ask for longer — it isn't even a parameter);
--   * a link works ONCE, and using it voids every other outstanding link for that account;
--   * an account gets at most THREE reset links per hour (so the "forgot password" form can't be used to
--     flood someone's inbox);
--   * only an active account that already has a password can be reset (an invited-but-never-signed-up
--     person uses "Resend invite"; a disabled account stays disabled);
--   * a successful reset clears any login lockout and REVOKES every session issued before it, so someone
--     who knew the old password is signed out too;
--   * both steps are written to the tamper-evident audit log.
-- Only a SHA-256 hash of the link's secret is stored; the secret itself exists only in the email.

ALTER TABLE users ADD COLUMN sessions_valid_after timestamptz;
-- (users has had a column-limited UPDATE grant since 004; this new column is deliberately NOT added to it,
--  so it can change only through password_reset_consume below.)

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE UNIQUE INDEX password_resets_token_hash_uq ON password_resets (token_hash);
CREATE INDEX password_resets_user_created ON password_resets (user_id, created_at);

-- Closed to the app role entirely: no policies and no grants. The functions below (which run as the
-- table's owner) are the only way in.
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

-- Step 1: someone asked for a reset. Returns the address to email, or nothing — and "nothing" covers every
-- reason not to send (no such account, not active, no password yet, throttled), so the caller cannot tell
-- them apart and neither can anyone watching the HTTP response.
CREATE FUNCTION password_reset_request(p_email text, p_token_hash text) RETURNS TABLE (out_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid; v_org uuid; v_addr text; v_recent int;
BEGIN
  -- Housekeeping so the table can't grow without bound; the audit log keeps the permanent record.
  DELETE FROM password_resets WHERE expires_at < now() - interval '7 days';

  SELECT u.id, u.org_id, u.email INTO v_user, v_org, v_addr
  FROM users u
  WHERE lower(u.email) = lower(p_email) AND u.status = 'active' AND u.password_hash IS NOT NULL;
  IF v_user IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO v_recent FROM password_resets WHERE user_id = v_user AND created_at > now() - interval '1 hour';
  IF v_recent >= 3 THEN RETURN; END IF;

  INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (v_user, p_token_hash, now() + interval '1 hour');
  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_user, 'user.password_reset_requested', 'user', v_user::text, '{}'::jsonb);

  out_email := v_addr;
  RETURN NEXT;
END
$$;

-- Step 2: the link was used. Verifies it, spends it, sets the new password, voids the account's other
-- links, clears any lockout and revokes older sessions — all in one atomic step, so a link can never be
-- "half used". Returns the user id, or NULL for an unknown, expired or already-used link (deliberately not
-- saying which).
CREATE FUNCTION password_reset_consume(p_token_hash text, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid; v_org uuid;
BEGIN
  UPDATE password_resets SET used_at = now()
  WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v_user;
  IF v_user IS NULL THEN RETURN NULL; END IF;

  UPDATE users SET password_hash = p_password_hash, failed_login_count = 0, locked_until = NULL, sessions_valid_after = now()
  WHERE id = v_user AND status = 'active' AND password_hash IS NOT NULL
  RETURNING org_id INTO v_org;
  IF v_org IS NULL THEN RETURN NULL; END IF; -- the account was disabled after the link was sent

  UPDATE password_resets SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;

  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_user, 'user.password_reset', 'user', v_user::text, '{}'::jsonb);
  RETURN v_user;
END
$$;

-- Is a session token that was issued at p_issued_at still good? No if the account is gone or not active,
-- or if the password was reset after the token was issued. Compared at one-second resolution because that
-- is all a token's issue time carries; a session created in the very same second as a reset is let through.
-- Returns only a yes/no, so it reveals nothing about when anyone's password changed.
CREATE FUNCTION auth_session_valid(p_user_id uuid, p_issued_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT COALESCE(
    (SELECT u.status = 'active' AND (u.sessions_valid_after IS NULL OR p_issued_at >= date_trunc('second', u.sessions_valid_after))
     FROM users u WHERE u.id = p_user_id),
    false)
$$;

GRANT EXECUTE ON FUNCTION password_reset_request(text, text) TO portal_app;
GRANT EXECUTE ON FUNCTION password_reset_consume(text, text) TO portal_app;
GRANT EXECUTE ON FUNCTION auth_session_valid(uuid, timestamptz) TO portal_app;
