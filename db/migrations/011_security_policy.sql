-- Evidence Portal: changing your own password while signed in, and an organisation-wide two-step policy (stage 11)
--
-- Same shape as 008 (password reset) and 010 (two-step sign-in): nothing here is a loosened row-level-security
-- policy. Each step is one narrow SECURITY DEFINER function, and the new setting can be changed only through them.
--
-- What the database enforces, so no application bug can weaken it:
--   * changing your own password (auth_change_password) acts only for the signed-in person (taken from the session,
--     never from a parameter); works only if the stored hash is still the one the application just verified (so a
--     proof of the old password cannot be reused after the password changed in between); stores nothing but a
--     bcrypt hash; clears any lock-out; and REVOKES every session issued before the change (the caller is handed the
--     moment of revocation, so it can issue the one fresh session the person is using right now); audited;
--   * the organisation's two-step policy is one of off / staff / everyone, and ONLY an organisation admin can change
--     it — and only once their own two-step sign-in is on, so switching it on can never lock out the person who did;
--     every change is written to the tamper-evident audit log;
--   * someone the policy covers cannot turn their own two-step sign-in off (an admin reset, which makes them enrol
--     again, is the one way it ends);
--   * the policy covers only accounts that sign in with a password held here. An account that signs in through an
--     organisation's single sign-on has no local password; its two-step sign-in is the provider's job, and the
--     policy leaves it alone rather than locking it out of a setup it can never complete.

ALTER TABLE orgs ADD COLUMN mfa_policy text NOT NULL DEFAULT 'off' CHECK (mfa_policy IN ('off', 'staff', 'everyone'));
-- (orgs has had a column-limited UPDATE grant since 001; this column is deliberately NOT added to it, so it can
--  change only through org_set_mfa_policy below.)

-- ---- changing your own password -------------------------------------------------------------------------------------

-- p_old_hash is the stored hash the application just verified the typed password against; p_new_hash is the bcrypt
-- hash of the new one. Returns the moment sessions older than this were revoked, or NULL if nothing was changed
-- (the account is not active, has no password here, or its hash is no longer p_old_hash).
CREATE FUNCTION auth_change_password(p_old_hash text, p_new_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid := ctx_user_id(); v_org uuid; v_after timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: You must be signed in to do that.' USING ERRCODE = 'P0001';
  END IF;
  -- Never let a bug (or anyone holding this role) blank out or downgrade a password: only a real bcrypt hash goes in.
  IF p_new_hash IS NULL OR p_new_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'VALIDATION: The new password must be stored as a bcrypt hash.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE users
  SET password_hash = p_new_hash, failed_login_count = 0, locked_until = NULL, sessions_valid_after = now()
  WHERE id = v_user AND status = 'active' AND password_hash IS NOT NULL AND password_hash = p_old_hash
  RETURNING org_id, sessions_valid_after INTO v_org, v_after;
  IF v_org IS NULL THEN RETURN NULL; END IF;

  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_user, 'user.password_changed', 'user', v_user::text, '{}'::jsonb);
  RETURN v_after;
END
$$;

-- ---- the organisation's two-step policy -----------------------------------------------------------------------------

-- Does the policy cover this account (required), and has it set two-step sign-in up (enabled)? One row for a known
-- account, none for an unknown one. Used by the application on every signed-in request, and by mfa_disable below.
-- 'staff' covers the organisation's own people (no tenant); 'everyone' covers clients too. Disabled accounts and
-- accounts without a password held here are never covered.
CREATE FUNCTION mfa_requirement(p_user_id uuid) RETURNS TABLE (required boolean, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT (u.status = 'active' AND u.password_hash IS NOT NULL
          AND (o.mfa_policy = 'everyone' OR (o.mfa_policy = 'staff' AND u.tenant_id IS NULL))),
         EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL)
  FROM users u JOIN orgs o ON o.id = u.org_id
  WHERE u.id = p_user_id
$$;

-- The policy and how far along people are, for an organisation admin (everyone else gets no rows), about their own
-- organisation only. Counts cover active people who sign in with a password held here — the only people the policy
-- can apply to — as numbers, never names.
CREATE FUNCTION mfa_policy_get() RETURNS TABLE (out_policy text, out_staff_total int, out_staff_enrolled int, out_all_total int, out_all_enrolled int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM users WHERE id = ctx_user_id() AND status = 'active' AND role = 'org_admin';
  IF v_org IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT (SELECT o.mfa_policy FROM orgs o WHERE o.id = v_org),
         (count(*) FILTER (WHERE p.tenant_id IS NULL))::int,
         (count(*) FILTER (WHERE p.tenant_id IS NULL AND p.on_))::int,
         count(*)::int,
         (count(*) FILTER (WHERE p.on_))::int
  FROM (
    SELECT u.tenant_id, EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL) AS on_
    FROM users u WHERE u.org_id = v_org AND u.status = 'active' AND u.password_hash IS NOT NULL
  ) p;
END
$$;

-- Sets the policy. True if it changed, false if it already was that. Only an organisation admin, and only for their
-- own organisation; and never switched ON by an admin who has not turned two-step sign-in on for themselves.
CREATE FUNCTION org_set_mfa_policy(p_policy text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_actor uuid := ctx_user_id(); v_org uuid; v_role text; v_old text;
BEGIN
  SELECT org_id, role INTO v_org, v_role FROM users WHERE id = v_actor AND status = 'active';
  IF v_role IS DISTINCT FROM 'org_admin' THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only an organisation admin can change the two-step sign-in policy.' USING ERRCODE = 'P0001';
  END IF;
  IF p_policy IS NULL OR p_policy NOT IN ('off', 'staff', 'everyone') THEN
    RAISE EXCEPTION 'VALIDATION: The policy must be off, staff or everyone.' USING ERRCODE = 'P0001';
  END IF;
  IF p_policy <> 'off' AND NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_actor AND enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'MFA_ADMIN_NEEDS_MFA: Turn on two-step sign-in for your own account first, so you cannot lock yourself out.' USING ERRCODE = 'P0001';
  END IF;

  SELECT mfa_policy INTO v_old FROM orgs WHERE id = v_org;
  IF v_old = p_policy THEN RETURN false; END IF;
  UPDATE orgs SET mfa_policy = p_policy WHERE id = v_org;
  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_actor, 'org.mfa_policy_changed', 'org', v_org::text, jsonb_build_object('from', v_old, 'to', p_policy));
  RETURN true;
END
$$;

-- 010's mfa_disable, now refusing for someone the policy covers who has two-step sign-in on. (Cancelling an
-- enrolment that was never confirmed still works: nothing is being switched off.) Everything else is unchanged.
CREATE OR REPLACE FUNCTION mfa_disable() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_user uuid := ctx_user_id(); v_org uuid; v_was boolean; v_required boolean;
BEGIN
  SELECT r.required INTO v_required FROM mfa_requirement(v_user) r;
  IF coalesce(v_required, false) AND EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'MFA_REQUIRED_BY_POLICY: Your organisation requires two-step sign-in, so it cannot be turned off.' USING ERRCODE = 'P0001';
  END IF;

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

GRANT EXECUTE ON FUNCTION auth_change_password(text, text) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_requirement(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION mfa_policy_get() TO portal_app;
GRANT EXECUTE ON FUNCTION org_set_mfa_policy(text) TO portal_app;
