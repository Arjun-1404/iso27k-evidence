-- Evidence Portal: two-step sign-in with an authenticator app (TOTP) and one-time recovery codes (stage 10)
--
-- Same shape as the password-reset work (008): the secrets live in tables the application's database role
-- cannot touch at all (row-level security on, no policies, no grants), and a few narrow SECURITY DEFINER
-- functions each do exactly one step. The database never sees the authenticator secret itself — only the
-- application's AES-GCM ciphertext of it — and never a recovery code, only a hash.
--
-- What the database enforces, so no application bug can weaken it:
--   * a code works ONCE: the time step of the last accepted code is remembered, and the same step (or an older
--     one) is refused afterwards — checked and updated atomically under a row lock, so two simultaneous
--     requests with one code cannot both succeed;
--   * FIVE wrong attempts lock two-step verification for the account for 15 minutes — wrong authenticator
--     codes, wrong recovery codes and replays all count — and while locked even a correct code is refused;
--   * a recovery code works once, and belongs to one account;
--   * only an active account can complete a second step, and only if it has finished enrolling;
--   * turning it on always comes with recovery codes (an account can't be left with no way back in);
--   * only an organisation admin can reset SOMEONE ELSE's two-step sign-in (never their own — that takes their
--     password and a code), only inside their own organisation, and a reset ends the target's sessions;
--   * every change (on, off, recovery codes regenerated or used, lock-out, admin reset) is written to the
--     tamper-evident audit log.

CREATE TABLE user_mfa (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc      text NOT NULL,           -- the app's AES-GCM ciphertext of the authenticator secret
  created_at      timestamptz NOT NULL DEFAULT now(),
  enabled_at      timestamptz,             -- NULL while enrolment is pending (not yet proven with a code)
  last_used_step  bigint,                  -- time step of the last accepted code: a code works once
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until    timestamptz
);
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);
CREATE UNIQUE INDEX mfa_recovery_codes_uq ON mfa_recovery_codes (user_id, code_hash);
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
-- (Neither table has policies or grants for the app role: the functions below are the only way in.)

-- --- sign-in time (nobody is signed in yet, so these take the user id the application has already proven by
--     the password step and a short-lived token) ---------------------------------------------------------------

-- Same lookup as auth_lookup_by_email, by id, for the second sign-in step and for "confirm your password".
CREATE FUNCTION auth_lookup_by_id(p_id uuid) RETURNS TABLE (
  id uuid, org_id uuid, tenant_id uuid, email text, role text, status text, password_hash text, failed_login_count int, locked_until timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT id, org_id, tenant_id, email, role, status, password_hash, failed_login_count, locked_until FROM users WHERE id = p_id $$;

CREATE FUNCTION mfa_is_enabled(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = p_user_id AND enabled_at IS NOT NULL) $$;

-- What the application needs to check a code: the encrypted secret, and whether the account is locked right now.
-- Nothing for an account that isn't active or hasn't finished enrolling.
CREATE FUNCTION mfa_login_state(p_user_id uuid) RETURNS TABLE (secret_enc text, locked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT m.secret_enc, (m.locked_until IS NOT NULL AND m.locked_until > now())
  FROM user_mfa m JOIN users u ON u.id = m.user_id
  WHERE m.user_id = p_user_id AND m.enabled_at IS NOT NULL AND u.status = 'active'
$$;

-- The one place a second step is decided. The application works out which time step (if any) the typed
-- authenticator code matches, or hashes the typed recovery code, and passes the result; this function decides
-- whether it is acceptable and keeps the books (replay protection, single-use recovery codes, lock-out).
-- Returns true if the second step is complete, false for anything else (and counts a failure).
CREATE FUNCTION mfa_complete_login(p_user_id uuid, p_step bigint, p_recovery_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v user_mfa%ROWTYPE; v_org uuid; v_code uuid; v_failed int;
BEGIN
  -- The row lock serialises attempts on one account, so "check, then record" can't be raced.
  SELECT m.* INTO v FROM user_mfa m JOIN users u ON u.id = m.user_id
  WHERE m.user_id = p_user_id AND m.enabled_at IS NOT NULL AND u.status = 'active'
  FOR UPDATE OF m;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Locked: refuse without touching anything, so locking can't be extended by hammering it and a correct code
  -- doesn't get used up while the lock holds.
  IF v.locked_until IS NOT NULL AND v.locked_until > now() THEN RETURN false; END IF;

  IF p_step IS NOT NULL AND (v.last_used_step IS NULL OR p_step > v.last_used_step) THEN
    UPDATE user_mfa SET last_used_step = p_step, failed_attempts = 0, locked_until = NULL WHERE user_id = p_user_id;
    RETURN true;
  END IF;

  IF p_recovery_hash IS NOT NULL THEN
    UPDATE mfa_recovery_codes SET used_at = now()
    WHERE user_id = p_user_id AND code_hash = p_recovery_hash AND used_at IS NULL
    RETURNING id INTO v_code;
    IF v_code IS NOT NULL THEN
      UPDATE user_mfa SET failed_attempts = 0, locked_until = NULL WHERE user_id = p_user_id;
      SELECT org_id INTO v_org FROM users WHERE id = p_user_id;
      INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
      VALUES (v_org, p_user_id, 'user.mfa_recovery_code_used', 'user', p_user_id::text, '{}'::jsonb);
      RETURN true;
    END IF;
  END IF;

  -- Anything else — wrong code, a replayed code, a used or unknown recovery code — is a failed attempt.
  UPDATE user_mfa
  SET failed_attempts = failed_attempts + 1,
      locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
  WHERE user_id = p_user_id
  RETURNING failed_attempts INTO v_failed;
  IF v_failed >= 5 THEN
    SELECT org_id INTO v_org FROM users WHERE id = p_user_id;
    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
    VALUES (v_org, p_user_id, 'user.mfa_locked', 'user', p_user_id::text, '{}'::jsonb);
  END IF;
  RETURN false;
END
$$;

-- --- signed-in management (these act for the signed-in user, taken from the session, never from a parameter) ---

-- Start (or restart) enrolment with a fresh secret. Refused if two-step sign-in is already on.
CREATE FUNCTION mfa_begin_enrollment(p_secret_enc text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid := ctx_user_id();
BEGIN
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = v_user AND status = 'active') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: You must be signed in to do that.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'MFA_ALREADY_ENABLED: Two-step sign-in is already turned on for this account.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO user_mfa (user_id, secret_enc) VALUES (v_user, p_secret_enc)
  ON CONFLICT (user_id) DO UPDATE
    SET secret_enc = EXCLUDED.secret_enc, created_at = now(), last_used_step = NULL, failed_attempts = 0, locked_until = NULL;
END
$$;

-- The signed-in user's pending (not yet confirmed) secret, so the first code can be checked.
CREATE FUNCTION mfa_enrollment_secret() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT secret_enc FROM user_mfa WHERE user_id = ctx_user_id() AND enabled_at IS NULL $$;

-- Finish enrolment: the first code was right (for time step p_step), so turn it on and store the recovery codes
-- (as hashes). False if there is nothing pending.
CREATE FUNCTION mfa_confirm_enrollment(p_step bigint, p_recovery_hashes text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid := ctx_user_id(); v_org uuid; v_done uuid;
BEGIN
  IF coalesce(cardinality(p_recovery_hashes), 0) = 0 THEN
    RAISE EXCEPTION 'MFA_NEEDS_RECOVERY_CODES: Two-step sign-in cannot be turned on without recovery codes.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE user_mfa m SET enabled_at = now(), last_used_step = p_step, failed_attempts = 0, locked_until = NULL
  FROM users u
  WHERE m.user_id = v_user AND m.enabled_at IS NULL AND u.id = m.user_id AND u.status = 'active'
  RETURNING m.user_id, u.org_id INTO v_done, v_org;
  IF v_done IS NULL THEN RETURN false; END IF;
  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT v_user, h FROM unnest(p_recovery_hashes) AS h;
  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_user, 'user.mfa_enabled', 'user', v_user::text, '{}'::jsonb);
  RETURN true;
END
$$;

-- Is it on, and how many unused recovery codes are left? Always one row (false, 0 for anyone without it).
CREATE FUNCTION mfa_status() RETURNS TABLE (enabled boolean, recovery_remaining int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = ctx_user_id() AND enabled_at IS NOT NULL),
         (SELECT count(*)::int FROM mfa_recovery_codes WHERE user_id = ctx_user_id() AND used_at IS NULL)
$$;

-- Turn it off for the signed-in user (also cancels an enrolment that was never confirmed). True only if it was on.
CREATE FUNCTION mfa_disable() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid := ctx_user_id(); v_org uuid; v_was boolean;
BEGIN
  DELETE FROM user_mfa WHERE user_id = v_user RETURNING (enabled_at IS NOT NULL) INTO v_was;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  IF v_was THEN
    SELECT org_id INTO v_org FROM users WHERE id = v_user;
    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
    VALUES (v_org, v_user, 'user.mfa_disabled', 'user', v_user::text, '{}'::jsonb);
  END IF;
  RETURN v_was;
END
$$;

-- Replace the signed-in user's recovery codes with a fresh set; the old ones stop working.
CREATE FUNCTION mfa_replace_recovery_codes(p_recovery_hashes text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid := ctx_user_id(); v_org uuid;
BEGIN
  IF coalesce(cardinality(p_recovery_hashes), 0) = 0 THEN
    RAISE EXCEPTION 'MFA_NEEDS_RECOVERY_CODES: Two-step sign-in cannot be left without recovery codes.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN RETURN false; END IF;
  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT v_user, h FROM unnest(p_recovery_hashes) AS h;
  SELECT org_id INTO v_org FROM users WHERE id = v_user;
  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_user, 'user.mfa_recovery_codes_regenerated', 'user', v_user::text, '{}'::jsonb);
  RETURN true;
END
$$;

-- An organisation admin switches off SOMEONE ELSE's two-step sign-in (a lost or stolen phone). Never one's own
-- (that goes through "turn off", which needs the password and a code), and only inside the admin's own
-- organisation. Also ends every session the person already has. True if they had it on.
CREATE FUNCTION mfa_admin_reset(p_target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_actor uuid := ctx_user_id(); v_org uuid; v_role text; v_target_org uuid; v_was boolean;
BEGIN
  SELECT org_id, role INTO v_org, v_role FROM users WHERE id = v_actor AND status = 'active';
  IF v_role IS DISTINCT FROM 'org_admin' THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only an organisation admin can reset someone else''s two-step sign-in.' USING ERRCODE = 'P0001';
  END IF;
  IF p_target = v_actor THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: To turn off your own two-step sign-in, use Security settings (it needs your password and a code).' USING ERRCODE = 'P0001';
  END IF;
  SELECT org_id INTO v_target_org FROM users WHERE id = p_target;
  IF v_target_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: You don''t have access to do that.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM user_mfa WHERE user_id = p_target RETURNING (enabled_at IS NOT NULL) INTO v_was;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM mfa_recovery_codes WHERE user_id = p_target;
  IF v_was THEN
    UPDATE users SET sessions_valid_after = now() WHERE id = p_target;
    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
    VALUES (v_org, v_actor, 'user.mfa_reset', 'user', p_target::text, '{}'::jsonb);
  END IF;
  RETURN v_was;
END
$$;

-- Who in the organisation has two-step sign-in on? Only an organisation admin gets an answer (everyone else gets
-- no rows), and only about their own organisation. Yes/no only — never anything about the secrets.
CREATE FUNCTION mfa_org_status() RETURNS TABLE (user_id uuid, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT u.id, EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL)
  FROM users u
  WHERE u.org_id = (SELECT a.org_id FROM users a WHERE a.id = ctx_user_id() AND a.status = 'active' AND a.role = 'org_admin')
$$;

GRANT EXECUTE ON FUNCTION auth_lookup_by_id(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_login_state(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_complete_login(uuid, bigint, text) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_begin_enrollment(text) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_enrollment_secret() TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_confirm_enrollment(bigint, text[]) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_status() TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_disable() TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_replace_recovery_codes(text[]) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_admin_reset(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_org_status() TO portal_app;
