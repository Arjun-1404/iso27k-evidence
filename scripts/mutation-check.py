#!/usr/bin/env python3
"""Tests the tests: deliberately breaks one security rule at a time and confirms the test suite notices.
Two kinds of breakage: database rules (a copy of the migrations is changed) and application code
(a copy of the whole project is changed, so the real source tree is never touched). A mutation that the suite does NOT catch means a missing test.

Every run includes ALL migration files unchanged except the one being mutated — later migrations
depend on earlier ones (004 adds columns to tables 001 creates; 003 drops a NOT NULL column 001
defined), so a temp directory missing any file breaks every fixture and makes every mutation look
"caught" for the wrong reason (a broken test setup, not a detected vulnerability)."""
import os, re, shutil, subprocess, sys, tempfile

MIGRATIONS_DIR = "db/migrations"
ALL_MIGRATIONS = sorted(f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql"))

MUTATIONS = [
  # --- 015: more places to keep the evidence [storage-options] ---
  ("015_storage_providers.sql", "the storage can be changed after evidence exists [storage-options]", "IF EXISTS (SELECT 1 FROM evidence_files WHERE org_id = OLD.id) THEN", "IF false THEN"),
  ("015_storage_providers.sql", "tenants keep folders from the storage that was left [storage-options]", "UPDATE tenants SET storage_root_id = NULL WHERE org_id = OLD.id AND storage_root_id IS NOT NULL;", ""),
  ("015_storage_providers.sql", "open audits keep control folders from the storage that was left [storage-options]", "WHERE ac.org_id = OLD.id AND ac.folder_id IS NOT NULL", "WHERE ac.org_id = OLD.id AND false"),
  ("015_storage_providers.sql", "closed audits lose their folders when the storage changes [storage-options]", "AND EXISTS (SELECT 1 FROM audits a WHERE a.id = ac.audit_id AND a.status <> 'closed')", "AND true"),
  ("015_storage_providers.sql", "a change of storage is logged without what it changed from and to [storage-options]", "jsonb_build_object('from', OLD.storage_provider, 'to', NEW.storage_provider)", "'{}'::jsonb"),
  ("015_storage_providers.sql", "connecting Drive after evidence exists tries to switch the org anyway [storage-options]", "IF NOT EXISTS (SELECT 1 FROM evidence_files WHERE org_id = v_org) THEN", "IF true THEN"),
  ("015_storage_providers.sql", "S3 is not accepted as a storage choice [storage-options]", "CHECK (storage_provider IN ('google_drive', 'sharepoint', 'local', 's3'))", "CHECK (storage_provider IN ('google_drive', 'sharepoint', 'local'))"),
  # file, name, old, new
  ("001_core.sql", "cross-tenant read: drop the tenant check in can_read_control", "     AND can_see_tenant(p_tenant)\n", ""),
  ("001_core.sql", "tenant users can list every tenant of the org", "OR id = (SELECT app_tenant())", "OR true"),
  ("001_core.sql", "dashboard-only roles can read control detail", "app_role() NOT IN ('dashboard_only', 'tenant_dashboard')\n     AND (app_role() <> 'contributor'", "app_role() NOT IN ('nobody')\n     AND (app_role() <> 'contributor'"),
  ("001_core.sql", "contributors see every control, not only assigned ones", "(app_role() <> 'contributor' OR EXISTS (", "(true OR EXISTS ("),
  ("001_core.sql", "email domain trigger removed", "CREATE TRIGGER users_email_domain BEFORE INSERT OR UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION enforce_email_domain();", ""),
  ("001_core.sql", "status transitions not enforced", "IF NOT status_transition_ok(OLD.status, NEW.status, r) THEN", "IF false THEN"),
  ("001_core.sql", "reminder rate limit removed", "IF OLD.last_reminded_at IS NOT NULL AND OLD.last_reminded_at > now() - interval '24 hours' THEN", "IF false THEN"),
  ("001_core.sql", "not-applicable justification no longer required", "CONSTRAINT na_needs_justification CHECK (applicable OR length(btrim(COALESCE(na_justification, ''))) >= 3)", "CONSTRAINT na_needs_justification CHECK (true)"),
  ("001_core.sql", "audit log: actor can be forged", "AND actor_id = ctx_user_id() AND (tenant_id IS NULL OR can_see_tenant(tenant_id))", "AND (tenant_id IS NULL OR can_see_tenant(tenant_id))"),
  ("001_core.sql", "audit log: hash chain not linked", "NEW.prev_hash  := COALESCE(prev, 'genesis');", "NEW.prev_hash  := 'genesis';"),
  ("001_core.sql", "tenant users can post findings (major/minor/OFI)", "AND (type = 'comment' OR is_auditor_side()));", ");"),
  ("001_core.sql", "storage tokens readable by lead auditors", "CREATE POLICY storage_connections_all ON storage_connections FOR ALL TO portal_app\n  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) = 'org_admin')", "CREATE POLICY storage_connections_all ON storage_connections FOR ALL TO portal_app\n  USING (org_id = (SELECT app_org()) AND (SELECT app_role()) IN ('org_admin','lead_auditor'))"),
  # Note: the evidence_files_guard trigger's immutability check (provider_hash, provider_version, ...)
  # is deliberate defense in depth on top of the column-restricted GRANT in 002 — the GRANT alone
  # already blocks the app role from touching those columns, so a single-point mutation of the trigger
  # alone is never observable here (the GRANT catches it first) and isn't included in this harness.
  # tests/11-evidence-immutability.test.ts asserts the GRANT-level protection directly instead.
  ("002_evidence_updates.sql", "evidence integrity status editable by any role, not just auditor-side", "can_read_control(org_id, tenant_id, audit_control_id) AND is_auditor_side())", "can_read_control(org_id, tenant_id, audit_control_id))"),
  ("004_builtin_auth.sql", "login lockout never engages, however many attempts fail", "locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END", "locked_until = locked_until"),
  ("004_builtin_auth.sql", "an expired invite token is still accepted", "WHERE invite_token_hash = p_token_hash AND invite_token_expires_at > now()", "WHERE invite_token_hash = p_token_hash"),
  ("004_builtin_auth.sql", "a consumed invite token remains usable (not cleared after accept)", "invite_token_hash = NULL, invite_token_expires_at = NULL,", "invite_token_expires_at = NULL,"),
  # --- 005/006: the Drive "Connect" (OAuth) flow ---
  ("005_oauth_state.sql", "an expired OAuth state is still accepted", "WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL", "WHERE state_hash = p_state_hash AND consumed_at IS NULL"),
  ("005_oauth_state.sql", "an OAuth state can be replayed (single-use not enforced)", "WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL", "WHERE state_hash = p_state_hash AND expires_at > now()"),
  ("005_oauth_state.sql", "any role (not just org admins) can start an OAuth flow", "actor_id = ctx_user_id() AND (SELECT app_role()) = 'org_admin')", "actor_id = ctx_user_id())"),
  ("006_oauth_complete_connection.sql", "completing a connection accepts an expired state", "WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL\n  RETURNING oauth_states.org_id", "WHERE state_hash = p_state_hash AND consumed_at IS NULL\n  RETURNING oauth_states.org_id"),
  ("006_oauth_complete_connection.sql", "completing a connection can be replayed with a used state", "WHERE state_hash = p_state_hash AND expires_at > now() AND consumed_at IS NULL\n  RETURNING oauth_states.org_id", "WHERE state_hash = p_state_hash AND expires_at > now()\n  RETURNING oauth_states.org_id"),
  # --- 007: per-org storage credentials ---
  ("007_storage_credentials.sql", "storage credentials are not limited to the caller's own org", "WHERE sc.org_id = app_org()", "WHERE true"),
  ("007_storage_credentials.sql", "dashboard-only roles can obtain storage credentials", "AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard')", "AND true"),
  ("007_storage_credentials.sql", "a revoked connection's credentials are still handed out", "AND sc.status = 'active'\n    AND app_role()", "AND app_role()"),
  ("007_storage_credentials.sql", "credentials returned for a provider the org didn't choose", "JOIN orgs o ON o.id = sc.org_id AND o.storage_provider = sc.provider", "JOIN orgs o ON o.id = sc.org_id"),
  ("007_storage_credentials.sql", "a user can flag ANOTHER org's connection as revoked", "WHERE id = p_connection_id AND org_id = v_org AND status = 'active'", "WHERE id = p_connection_id AND status = 'active'"),
  # --- 008: password reset ---
  ("008_password_reset.sql", 'a reset link can be used more than once', 'token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()', 'token_hash = p_token_hash AND expires_at > now()'),
  ("008_password_reset.sql", 'an expired reset link is still accepted', 'token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()', 'token_hash = p_token_hash AND used_at IS NULL'),
  ("008_password_reset.sql", 'reset links live for a day instead of an hour', "p_token_hash, now() + interval '1 hour')", "p_token_hash, now() + interval '1 day')"),
  ("008_password_reset.sql", 'no limit on reset links per account', 'IF v_recent >= 3 THEN RETURN; END IF;', 'IF false THEN RETURN; END IF;'),
  ("008_password_reset.sql", 'accounts that are invited, disabled or have no password can request a reset', "WHERE lower(u.email) = lower(p_email) AND u.status = 'active' AND u.password_hash IS NOT NULL;", 'WHERE lower(u.email) = lower(p_email);'),
  ("008_password_reset.sql", 'reset email lookup is case-sensitive', 'lower(u.email) = lower(p_email)', 'u.email = p_email'),
  ("008_password_reset.sql", "using one reset link does not void the account's other links", '  UPDATE password_resets SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;\n', ''),
  ("008_password_reset.sql", 'a reset does not revoke existing sessions', ', locked_until = NULL, sessions_valid_after = now()', ', locked_until = NULL'),
  ("008_password_reset.sql", 'a reset does not clear a login lockout', 'SET password_hash = p_password_hash, failed_login_count = 0, locked_until = NULL, sessions_valid_after = now()', 'SET password_hash = p_password_hash, sessions_valid_after = now()'),
  ("008_password_reset.sql", 'a disabled account can be reset', "WHERE id = v_user AND status = 'active' AND password_hash IS NOT NULL\n  RETURNING org_id", 'WHERE id = v_user\n  RETURNING org_id'),
  ("008_password_reset.sql", 'session check lets disabled accounts through', "SELECT u.status = 'active' AND (u.sessions_valid_after IS NULL", 'SELECT (u.sessions_valid_after IS NULL'),
  ("008_password_reset.sql", 'session check ignores the reset marker', "(u.sessions_valid_after IS NULL OR p_issued_at >= date_trunc('second', u.sessions_valid_after))", 'true'),
  ("008_password_reset.sql", 'a completed reset is not audited', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_user, 'user.password_reset', 'user', v_user::text, '{}'::jsonb);\n", ''),
  ("008_password_reset.sql", 'a reset request is not audited', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_user, 'user.password_reset_requested', 'user', v_user::text, '{}'::jsonb);\n", ''),
  ("008_password_reset.sql", 'the app role can read reset links directly', 'GRANT EXECUTE ON FUNCTION password_reset_request(text, text) TO portal_app;', 'GRANT SELECT ON password_resets TO portal_app;\nGRANT EXECUTE ON FUNCTION password_reset_request(text, text) TO portal_app;'),
  ("008_password_reset.sql", 'the app role can set password hashes directly', 'GRANT EXECUTE ON FUNCTION password_reset_request(text, text) TO portal_app;', 'GRANT UPDATE (password_hash) ON users TO portal_app;\nGRANT EXECUTE ON FUNCTION password_reset_request(text, text) TO portal_app;'),
  # --- 009: the app role and the secret columns of users ---
  ("009_users_column_privileges.sql", 'the app role can read every column of users again', "GRANT SELECT (id, org_id, tenant_id, email, full_name, role, status, created_at) ON users TO portal_app;", "GRANT SELECT ON users TO portal_app;"),
  ("009_users_column_privileges.sql", 'the app role can read password hashes', "role, status, created_at) ON users TO portal_app;", "role, status, created_at, password_hash) ON users TO portal_app;"),
  ("009_users_column_privileges.sql", 'the app role can read invite token hashes', "role, status, created_at) ON users TO portal_app;", "role, status, created_at, invite_token_hash) ON users TO portal_app;"),
  ("009_users_column_privileges.sql", 'the app role can insert into every column of users again', "GRANT INSERT (org_id, tenant_id, email, full_name, role, status, invite_token_hash, invite_token_expires_at) ON users TO portal_app;", "GRANT INSERT ON users TO portal_app;"),
  ("009_users_column_privileges.sql", 'the app role can create a user with a chosen password hash', "invite_token_hash, invite_token_expires_at) ON users TO portal_app;", "invite_token_hash, invite_token_expires_at, password_hash) ON users TO portal_app;"),
  # --- 010: two-step sign-in (MFA) ---
  ('010_mfa.sql', 'an authenticator code can be replayed', 'IF p_step IS NOT NULL AND (v.last_used_step IS NULL OR p_step > v.last_used_step) THEN', 'IF p_step IS NOT NULL THEN'),
  ('010_mfa.sql', 'an older authenticator code is accepted', '(v.last_used_step IS NULL OR p_step > v.last_used_step)', '(v.last_used_step IS NULL OR p_step <> v.last_used_step)'),
  ('010_mfa.sql', 'simultaneous attempts are not serialised (no row lock)', 'FOR UPDATE OF m;', ';'),
  ('010_mfa.sql', 'wrong attempts never lock the account', "WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'", "WHEN false THEN now() + interval '15 minutes'"),
  ('010_mfa.sql', 'the lock needs six wrong attempts, not five', 'WHEN failed_attempts + 1 >= 5 THEN now()', 'WHEN failed_attempts + 1 >= 6 THEN now()'),
  ('010_mfa.sql', 'the lock lasts one minute instead of fifteen', "THEN now() + interval '15 minutes'", "THEN now() + interval '1 minute'"),
  ('010_mfa.sql', 'a locked account still accepts a correct code', '  IF v.locked_until IS NOT NULL AND v.locked_until > now() THEN RETURN false; END IF;\n', ''),
  ('010_mfa.sql', 'a successful code does not clear the failure count', 'SET last_used_step = p_step, failed_attempts = 0, locked_until = NULL WHERE user_id = p_user_id;\n    RETURN true;', 'SET last_used_step = p_step, locked_until = NULL WHERE user_id = p_user_id;\n    RETURN true;'),
  ('010_mfa.sql', 'a recovery code can be used more than once', 'WHERE user_id = p_user_id AND code_hash = p_recovery_hash AND used_at IS NULL', 'WHERE user_id = p_user_id AND code_hash = p_recovery_hash'),
  ('010_mfa.sql', 'a recovery code works for any account', 'WHERE user_id = p_user_id AND code_hash = p_recovery_hash AND used_at IS NULL', 'WHERE code_hash = p_recovery_hash AND used_at IS NULL'),
  ('010_mfa.sql', 'a disabled account can complete a second step', "  WHERE m.user_id = p_user_id AND m.enabled_at IS NOT NULL AND u.status = 'active'\n  FOR UPDATE OF m;", '  WHERE m.user_id = p_user_id AND m.enabled_at IS NOT NULL\n  FOR UPDATE OF m;'),
  ('010_mfa.sql', 'an unfinished enrolment can be used to sign in', "  WHERE m.user_id = p_user_id AND m.enabled_at IS NOT NULL AND u.status = 'active'\n  FOR UPDATE OF m;", "  WHERE m.user_id = p_user_id AND u.status = 'active'\n  FOR UPDATE OF m;"),
  ('010_mfa.sql', 'the login state is handed out for an unfinished enrolment', "  WHERE m.user_id = p_user_id AND m.enabled_at IS NOT NULL AND u.status = 'active'\n$$;", "  WHERE m.user_id = p_user_id AND u.status = 'active'\n$$;"),
  ('010_mfa.sql', 'the login state never reports a lock', '(m.locked_until IS NOT NULL AND m.locked_until > now())', 'false'),
  ('010_mfa.sql', 'enrolment can be restarted while two-step sign-in is on (replacing the secret)', "  IF EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN\n    RAISE EXCEPTION 'MFA_ALREADY_ENABLED: Two-step sign-in is already turned on for this account.' USING ERRCODE = 'P0001';\n  END IF;\n", ''),
  ('010_mfa.sql', 'it can be turned on without recovery codes', "IF coalesce(cardinality(p_recovery_hashes), 0) = 0 THEN\n    RAISE EXCEPTION 'MFA_NEEDS_RECOVERY_CODES: Two-step sign-in cannot be turned on", "IF coalesce(cardinality(p_recovery_hashes), 0) < 0 THEN\n    RAISE EXCEPTION 'MFA_NEEDS_RECOVERY_CODES: Two-step sign-in cannot be turned on"),
  ('010_mfa.sql', 'the code that confirmed enrolment can be replayed to sign in', 'SET enabled_at = now(), last_used_step = p_step,', 'SET enabled_at = now(), last_used_step = NULL,'),
  ('010_mfa.sql', 'turning it on is not audited', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_user, 'user.mfa_enabled', 'user', v_user::text, '{}'::jsonb);\n", ''),
  ('011_security_policy.sql', 'turning it off leaves the recovery codes behind', '  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;\n  IF v_was THEN', '  IF v_was THEN'),
  ('011_security_policy.sql', 'turning it off is not audited', "    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n    VALUES (v_org, v_user, 'user.mfa_disabled', 'user', v_user::text, '{}'::jsonb);\n", ''),
  ('010_mfa.sql', 'regenerating recovery codes keeps the old ones working', 'DELETE FROM mfa_recovery_codes WHERE user_id = v_user;\n  INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT v_user, h FROM unnest(p_recovery_hashes) AS h;\n  SELECT org_id INTO v_org FROM users WHERE id = v_user;', 'INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT v_user, h FROM unnest(p_recovery_hashes) AS h ON CONFLICT DO NOTHING;\n  SELECT org_id INTO v_org FROM users WHERE id = v_user;'),
  ('010_mfa.sql', 'regenerating recovery codes is not audited', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_user, 'user.mfa_recovery_codes_regenerated', 'user', v_user::text, '{}'::jsonb);\n", ''),
  ('010_mfa.sql', 'a lock-out is not audited', "    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n    VALUES (v_org, p_user_id, 'user.mfa_locked', 'user', p_user_id::text, '{}'::jsonb);\n", ''),
  ('010_mfa.sql', 'using a recovery code is not audited', "      INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n      VALUES (v_org, p_user_id, 'user.mfa_recovery_code_used', 'user', p_user_id::text, '{}'::jsonb);\n", ''),
  ('010_mfa.sql', "any role can reset someone else's two-step sign-in", "IF v_role IS DISTINCT FROM 'org_admin' THEN", 'IF false THEN'),
  ('010_mfa.sql', 'an admin can reset someone in another organisation', 'IF v_target_org IS DISTINCT FROM v_org THEN', 'IF false THEN'),
  ('010_mfa.sql', 'an admin can reset their own two-step sign-in without proof', 'IF p_target = v_actor THEN', 'IF false THEN'),
  ('010_mfa.sql', "an admin reset does not end the person's sessions", '    UPDATE users SET sessions_valid_after = now() WHERE id = p_target;\n', ''),
  ('010_mfa.sql', 'an admin reset leaves the recovery codes behind', '  DELETE FROM mfa_recovery_codes WHERE user_id = p_target;\n', ''),
  ('010_mfa.sql', 'an admin reset is not audited', "    INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n    VALUES (v_org, v_actor, 'user.mfa_reset', 'user', p_target::text, '{}'::jsonb);\n", ''),
  ('010_mfa.sql', 'any role can see who has two-step sign-in on', "AND a.status = 'active' AND a.role = 'org_admin')", "AND a.status = 'active')"),
  ('010_mfa.sql', 'the two-step overview spans every organisation', "WHERE u.org_id = (SELECT a.org_id FROM users a WHERE a.id = ctx_user_id() AND a.status = 'active' AND a.role = 'org_admin')", "WHERE (SELECT a.org_id FROM users a WHERE a.id = ctx_user_id() AND a.status = 'active' AND a.role = 'org_admin') IS NOT NULL"),
  ('010_mfa.sql', 'an unfinished enrolment is reported as two-step sign-in being on', "SELECT u.id, EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL)", "SELECT u.id, EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id)"),
  ('010_mfa.sql', 'the app role can read the secrets table', 'GRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;', 'GRANT SELECT ON user_mfa TO portal_app;\nGRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;'),
  ('010_mfa.sql', 'the app role can read the recovery codes table', 'GRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;', 'GRANT SELECT ON mfa_recovery_codes TO portal_app;\nGRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;'),
  ('010_mfa.sql', 'the app role can rewrite the secrets table', 'GRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;', 'GRANT UPDATE ON user_mfa TO portal_app;\nGRANT EXECUTE ON FUNCTION mfa_is_enabled(uuid) TO portal_app;'),
  # --- 011: changing your password, and the organisation's two-step policy ---
  ('011_security_policy.sql', 'a password change stores something that is not a bcrypt hash', "IF p_new_hash IS NULL OR p_new_hash !~ '^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$' THEN", "IF p_new_hash IS NULL THEN"),
  ('011_security_policy.sql', 'a password change works even if the stored hash is no longer the one that was verified', "AND password_hash IS NOT NULL AND password_hash = p_old_hash\n  RETURNING org_id, sessions_valid_after", "AND password_hash IS NOT NULL\n  RETURNING org_id, sessions_valid_after"),
  ('011_security_policy.sql', 'a password change does not end the other sessions', "locked_until = NULL, sessions_valid_after = now()\n  WHERE id = v_user", "locked_until = NULL, sessions_valid_after = sessions_valid_after\n  WHERE id = v_user"),
  ('011_security_policy.sql', 'a password change does not clear the failed-attempt count', "SET password_hash = p_new_hash, failed_login_count = 0,", "SET password_hash = p_new_hash, failed_login_count = failed_login_count,"),
  ('011_security_policy.sql', 'a password change does not lift a lock-out', "failed_login_count = 0, locked_until = NULL, sessions_valid_after = now()\n  WHERE id = v_user", "failed_login_count = 0, locked_until = locked_until, sessions_valid_after = now()\n  WHERE id = v_user"),
  ('011_security_policy.sql', 'a disabled account can change its password', "WHERE id = v_user AND status = 'active' AND password_hash IS NOT NULL AND password_hash = p_old_hash", "WHERE id = v_user AND password_hash IS NOT NULL AND password_hash = p_old_hash"),
  ('011_security_policy.sql', 'a password change works for someone who is not signed in', "  IF v_user IS NULL THEN\n    RAISE EXCEPTION 'FORBIDDEN_ROLE: You must be signed in to do that.' USING ERRCODE = 'P0001';\n  END IF;\n  -- Never let a bug", "  -- Never let a bug"),
  ('011_security_policy.sql', 'a password change is not audited', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_user, 'user.password_changed', 'user', v_user::text, '{}'::jsonb);\n", ""),
  ('011_security_policy.sql', 'the app role can set the policy directly', "GRANT EXECUTE ON FUNCTION auth_change_password(text, text) TO portal_app;", "GRANT UPDATE (mfa_policy) ON orgs TO portal_app;\nGRANT EXECUTE ON FUNCTION auth_change_password(text, text) TO portal_app;"),
  ('011_security_policy.sql', 'the policy can be set to something other than off, staff or everyone', "CHECK (mfa_policy IN ('off', 'staff', 'everyone'))", "CHECK (true)"),
  ('011_security_policy.sql', "'staff' also covers clients' people", "OR (o.mfa_policy = 'staff' AND u.tenant_id IS NULL)", "OR (o.mfa_policy = 'staff')"),
  ('011_security_policy.sql', "'everyone' does not cover clients' people", "(o.mfa_policy = 'everyone' OR (o.mfa_policy = 'staff' AND u.tenant_id IS NULL))", "(o.mfa_policy = 'staff' AND u.tenant_id IS NULL)"),
  ('011_security_policy.sql', 'the policy covers disabled accounts', "SELECT (u.status = 'active' AND u.password_hash IS NOT NULL\n          AND (o.mfa_policy", "SELECT (u.password_hash IS NOT NULL\n          AND (o.mfa_policy"),
  ('011_security_policy.sql', 'the policy covers accounts that sign in elsewhere (no password held here)', "SELECT (u.status = 'active' AND u.password_hash IS NOT NULL\n          AND (o.mfa_policy", "SELECT (u.status = 'active'\n          AND (o.mfa_policy"),
  ('011_security_policy.sql', 'an unfinished set-up counts as two-step sign-in being on', "         EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL)\n  FROM users u JOIN orgs o", "         EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id)\n  FROM users u JOIN orgs o"),
  ('011_security_policy.sql', 'anyone can read the policy and the counts', "WHERE id = ctx_user_id() AND status = 'active' AND role = 'org_admin';\n  IF v_org IS NULL THEN RETURN; END IF;", "WHERE id = ctx_user_id() AND status = 'active';\n  IF v_org IS NULL THEN RETURN; END IF;"),
  ('011_security_policy.sql', "the 'staff' count includes clients' people", "(count(*) FILTER (WHERE p.tenant_id IS NULL))::int,", "(count(*) FILTER (WHERE true))::int,"),
  ('011_security_policy.sql', "the counts include other organisations", "FROM users u WHERE u.org_id = v_org AND u.status = 'active' AND u.password_hash IS NOT NULL", "FROM users u WHERE u.status = 'active' AND u.password_hash IS NOT NULL"),
  ('011_security_policy.sql', 'the counts include disabled accounts', "FROM users u WHERE u.org_id = v_org AND u.status = 'active' AND u.password_hash IS NOT NULL", "FROM users u WHERE u.org_id = v_org AND u.password_hash IS NOT NULL"),
  ('011_security_policy.sql', 'the counts include accounts that sign in elsewhere', "FROM users u WHERE u.org_id = v_org AND u.status = 'active' AND u.password_hash IS NOT NULL", "FROM users u WHERE u.org_id = v_org AND u.status = 'active'"),
  ('011_security_policy.sql', 'the counts treat an unfinished set-up as done', "SELECT u.tenant_id, EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL) AS on_", "SELECT u.tenant_id, EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id) AS on_"),
  ('011_security_policy.sql', 'anyone can set the policy', "IF v_role IS DISTINCT FROM 'org_admin' THEN", "IF false THEN"),
  ('011_security_policy.sql', 'a lead auditor can set the policy', "IF v_role IS DISTINCT FROM 'org_admin' THEN", "IF v_role NOT IN ('org_admin', 'lead_auditor') THEN"),
  ('011_security_policy.sql', 'the policy value is not checked by the function', "IF p_policy IS NULL OR p_policy NOT IN ('off', 'staff', 'everyone') THEN", "IF false THEN"),
  ('011_security_policy.sql', 'an admin can switch the policy on without having two-step sign-in on themselves', "IF p_policy <> 'off' AND NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_actor AND enabled_at IS NOT NULL) THEN", "IF false THEN"),
  ('011_security_policy.sql', "an admin's unfinished set-up is enough to switch the policy on", "NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_actor AND enabled_at IS NOT NULL) THEN", "NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_actor) THEN"),
  ('011_security_policy.sql', 'setting the policy changes every organisation', "UPDATE orgs SET mfa_policy = p_policy WHERE id = v_org;", "UPDATE orgs SET mfa_policy = p_policy;"),
  ('011_security_policy.sql', 'a policy change is not audited', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_actor, 'org.mfa_policy_changed', 'org', v_org::text, jsonb_build_object('from', v_old, 'to', p_policy));\n", ""),
  ('011_security_policy.sql', 'setting the policy to what it already is is audited as a change', "  IF v_old = p_policy THEN RETURN false; END IF;\n", ""),
  ('011_security_policy.sql', 'someone the policy covers can turn their own two-step sign-in off', "IF coalesce(v_required, false) AND EXISTS", "IF false AND EXISTS"),
  ('011_security_policy.sql', 'someone the policy covers cannot cancel an unfinished set-up', "IF coalesce(v_required, false) AND EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN", "IF coalesce(v_required, false) THEN"),
  ('012_platform_settings.sql', 'the owner check is missing when reading the settings [013-db]', "  IF NOT platform_is_owner() THEN\n    RAISE EXCEPTION 'FORBIDDEN_ROLE", "  IF false THEN\n    RAISE EXCEPTION 'FORBIDDEN_ROLE"),
  ('012_platform_settings.sql', 'the owner check is missing when saving [013-db]', 'DECLARE v_actor uuid := ctx_user_id(); v_org uuid; v_name text;\nBEGIN\n  IF NOT platform_is_owner() THEN', 'DECLARE v_actor uuid := ctx_user_id(); v_org uuid; v_name text;\nBEGIN\n  IF false THEN'),
  ('012_platform_settings.sql', 'the owner check is missing when removing [013-db]', 'DECLARE v_actor uuid := ctx_user_id(); v_org uuid;\nBEGIN\n  IF NOT platform_is_owner() THEN', 'DECLARE v_actor uuid := ctx_user_id(); v_org uuid;\nBEGIN\n  IF false THEN'),
  ('012_platform_settings.sql', 'any organisation admin counts as the owner [013-db]', "AND role = 'org_admin' AND is_platform_owner)", "AND role = 'org_admin')"),
  ('012_platform_settings.sql', 'the owner flag counts for someone who is not an organisation admin [013-db]', "AND status = 'active' AND role = 'org_admin' AND is_platform_owner)", "AND status = 'active' AND is_platform_owner)"),
  ('012_platform_settings.sql', 'a disabled owner is still the owner [013-db]', "WHERE id = ctx_user_id() AND status = 'active' AND role = 'org_admin' AND is_platform_owner)", "WHERE id = ctx_user_id() AND role = 'org_admin' AND is_platform_owner)"),
  ('012_platform_settings.sql', 'the application can read the owner flag [013-db]', 'ALTER TABLE users ADD COLUMN is_platform_owner boolean NOT NULL DEFAULT false;', 'ALTER TABLE users ADD COLUMN is_platform_owner boolean NOT NULL DEFAULT false;\nGRANT SELECT (is_platform_owner) ON users TO portal_app;'),
  ('012_platform_settings.sql', 'the application can set the owner flag [013-db]', 'ALTER TABLE users ADD COLUMN is_platform_owner boolean NOT NULL DEFAULT false;', 'ALTER TABLE users ADD COLUMN is_platform_owner boolean NOT NULL DEFAULT false;\nGRANT SELECT (is_platform_owner), UPDATE (is_platform_owner) ON users TO portal_app;'),
  ('012_platform_settings.sql', 'the application can read the settings table directly [013-db]', '-- (No policies and no grants:', 'GRANT SELECT ON platform_settings TO portal_app;\n-- (No policies and no grants:'),
  ('012_platform_settings.sql', 'the application can write the settings table directly [013-db]', '-- (No policies and no grants:', 'GRANT INSERT, UPDATE, DELETE ON platform_settings TO portal_app;\nCREATE POLICY platform_settings_open ON platform_settings FOR ALL TO portal_app USING (true) WITH CHECK (true);\n-- (No policies and no grants:'),
  ('012_platform_settings.sql', 'an unknown settings group is not refused by the function [013-db]', "  IF p_key IS NULL OR p_key NOT IN ('email', 'scanner', 'google') THEN\n    RAISE EXCEPTION 'VALIDATION: Unknown settings group.' USING ERRCODE = 'P0001';\n  END IF;\n  IF p_config IS NULL", "  IF false THEN\n    RAISE EXCEPTION 'VALIDATION: Unknown settings group.' USING ERRCODE = 'P0001';\n  END IF;\n  IF p_config IS NULL"),
  ('012_platform_settings.sql', 'settings that are not an object are accepted by the function [013-db]', "IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN", 'IF false THEN'),
  ('012_platform_settings.sql', 'ciphertext may be sent without a secret, or a secret without ciphertext (function) [013-db]', 'IF (p_secret_enc IS NOT NULL) <> (cardinality(p_secrets_set) > 0) THEN', 'IF false THEN'),
  ('012_platform_settings.sql', 'ciphertext may exist without a secret, or the reverse (table) [013-db]', 'CONSTRAINT platform_settings_secrets_consistent CHECK ((secret_enc IS NOT NULL) = (cardinality(secrets_set) > 0)),', 'CONSTRAINT platform_settings_secrets_consistent CHECK (true),'),
  ('012_platform_settings.sql', 'the email settings may hold any secret name [013-db]', "(key = 'email'   AND secrets_set <@ ARRAY['password']) OR", "(key = 'email') OR"),
  ('012_platform_settings.sql', 'the Google settings may hold any secret name [013-db]', "(key = 'google'  AND secrets_set <@ ARRAY['clientSecret']) OR", "(key = 'google') OR"),
  ('012_platform_settings.sql', 'the scanner settings may hold a secret [013-db]', "(key = 'scanner' AND cardinality(secrets_set) = 0))", "(key = 'scanner'))"),
  ('012_platform_settings.sql', 'any group name may be stored [013-db]', "key         text PRIMARY KEY CHECK (key IN ('email', 'scanner', 'google')),", 'key         text PRIMARY KEY,'),
  ('012_platform_settings.sql', 'an oversized settings value is accepted [013-db]', 'AND length(config::text) <= 4000)', 'AND length(config::text) <= 4000000)'),
  ('012_platform_settings.sql', 'a changed-field name can be any text, such as a value [013-db]', "IF v_name IS NULL OR v_name !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' THEN", 'IF false THEN'),
  ('012_platform_settings.sql', 'any number of changed fields may be written to the log [013-db]', 'IF cardinality(p_changed) > 20 THEN', 'IF false THEN'),
  ('012_platform_settings.sql', 'a save is not audited [013-db]', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_actor, 'platform.setting_saved', 'platform_setting', p_key, jsonb_build_object('fields', to_jsonb(p_changed)));\n", ''),
  ('012_platform_settings.sql', 'the audit entry for a save contains the settings themselves [013-db]', "jsonb_build_object('fields', to_jsonb(p_changed)));", "jsonb_build_object('fields', to_jsonb(p_changed), 'config', p_config));"),
  ('012_platform_settings.sql', 'a removal is not audited [013-db]', "  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)\n  VALUES (v_org, v_actor, 'platform.setting_cleared', 'platform_setting', p_key, '{}'::jsonb);\n", ''),
  ('012_platform_settings.sql', 'removing something that is not there is audited [013-db]', '  IF NOT FOUND THEN RETURN false; END IF;\n', ''),
  ('012_platform_settings.sql', 'a save does not record who made it [013-db]', 'updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;', 'updated_at = EXCLUDED.updated_at;'),
  ('012_platform_settings.sql', 'an installation that already has an owner gets a second one from the upgrade [013-db]', '  AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_owner);', '  ;'),
  ('012_platform_settings.sql', 'the upgrade makes a disabled administrator the owner [013-db]', "u.role = 'org_admin' AND u.status IN ('active', 'invited')", "u.role = 'org_admin'"),
  ('012_platform_settings.sql', 'the upgrade makes someone who is not an administrator the owner [013-db]', "u.role = 'org_admin' AND u.status IN ('active', 'invited')", "u.status IN ('active', 'invited')"),
  ('012_platform_settings.sql', 'the upgrade picks the newest administrator, not the first [013-db]', 'ORDER BY u.created_at, u.id LIMIT 1', 'ORDER BY u.created_at DESC, u.id LIMIT 1'),
  ('013_control_assignment_rules.sql', 'any role can be assigned (role rule dropped) [assign-db]', "                            AND u.role IN ('contributor', 'tenant_lead')\n", ''),
  ('013_control_assignment_rules.sql', 'a disabled account can be assigned [assign-db]', "                            AND u.status <> 'disabled'", ''),
  ('013_control_assignment_rules.sql', 'an invited person cannot be lined up for a control [assign-db]', "u.status <> 'disabled'", "u.status = 'active'"),
  ('013_control_assignment_rules.sql', 'client leads cannot be assigned [assign-db]', "u.role IN ('contributor', 'tenant_lead')", "u.role IN ('contributor')"),
  ('013_control_assignment_rules.sql', 'contributors cannot be assigned [assign-db]', "u.role IN ('contributor', 'tenant_lead')", "u.role IN ('tenant_lead')"),
  ('013_control_assignment_rules.sql', 'a person from another client can be assigned [assign-db]', '                            AND u.tenant_id = control_assignments.tenant_id\n', ''),
  ('013_control_assignment_rules.sql', 'an auditor can assign controls [assign-db]', "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')", "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'auditor', 'tenant_lead')"),
  ('013_control_assignment_rules.sql', 'a contributor can assign controls [assign-db]', "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')", "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead', 'contributor')"),
  ('013_control_assignment_rules.sql', 'a viewer can assign controls [assign-db]', "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')", "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead', 'viewer')"),
  ('013_control_assignment_rules.sql', 'a lead auditor cannot assign controls [assign-db]', "(SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')", "(SELECT app_role()) IN ('org_admin', 'tenant_lead')"),
  ('013_control_assignment_rules.sql', 'controls of an archived client can still be handed out [assign-db]', 'AND tenant_active(tenant_id) AND (SELECT app_role())', 'AND (SELECT app_role())'),
]


# --- 014: closing an audit cycle ---------------------------------------------------------------------------------------
# audit_close and audit_reopen share most of their checks, so each shared check is broken in both. A breakage replaces
# the FIRST match: the close function comes first in the file and is matched as it stands; the reopen function is
# matched with its own opening (the line declaring v_reason) in front, which makes the text unique to it.
_C14 = "014_close_audit_cycle.sql"
_REOPEN_HEAD = "DECLARE v_actor uuid := ctx_user_id(); a audits%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));\nBEGIN\n"
_PIECES14 = [
  "  SELECT * INTO a FROM audits WHERE id = p_audit AND org_id = app_org() AND can_see_tenant(tenant_id)\n    AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard') FOR UPDATE;\n",
  "  IF NOT FOUND THEN\n    RAISE EXCEPTION 'NOT_FOUND: Audit not found or not visible to you.' USING ERRCODE = 'P0001';\n  END IF;\n",
  "  IF app_role() NOT IN ('org_admin', 'lead_auditor') THEN\n    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only a lead auditor or an organisation admin can close or reopen an audit cycle.' USING ERRCODE = 'P0001';\n  END IF;\n",
  "  IF NOT tenant_active(a.tenant_id) THEN\n    RAISE EXCEPTION 'TENANT_INACTIVE: This client is archived, so its audits can''t be changed. Restore the client first.' USING ERRCODE = 'P0001';\n  END IF;\n",
]
def _both14(name, k, change):
    piece = _PIECES14[k]
    MUTATIONS.append((_C14, f"{name} (closing) [close-db]", piece, change(piece)))
    before = _REOPEN_HEAD + "".join(_PIECES14[:k])
    MUTATIONS.append((_C14, f"{name} (reopening) [close-db]", before + piece, before + change(piece)))

# (Not included: dropping `org_id = app_org()` from the lookup, or the two GRANT EXECUTE lines. can_see_tenant() already
# limits the lookup to the caller's own organisation, and functions are executable by everyone unless that is revoked, so
# neither change can be observed. They stay in the migration as a second line of defence and as documentation.)
_both14("an audit of a client the person is not assigned to can be found", 0, lambda p: p.replace(" AND can_see_tenant(tenant_id)", ""))
_both14("dashboard-only roles are told 'forbidden' instead of 'not found'", 0, lambda p: p.replace("\n    AND app_role() NOT IN ('dashboard_only', 'tenant_dashboard')", ""))
_both14("a missing audit is not reported as not found", 1, lambda p: "")
_both14("the role check is missing", 2, lambda p: "")
_both14("an auditor can do it too", 2, lambda p: p.replace("('org_admin', 'lead_auditor')", "('org_admin', 'lead_auditor', 'auditor')"))
_both14("a client lead can do it too", 2, lambda p: p.replace("('org_admin', 'lead_auditor')", "('org_admin', 'lead_auditor', 'tenant_lead')"))
_both14("a contributor can do it too", 2, lambda p: p.replace("('org_admin', 'lead_auditor')", "('org_admin', 'lead_auditor', 'contributor')"))
_both14("a read-only reviewer can do it too", 2, lambda p: p.replace("('org_admin', 'lead_auditor')", "('org_admin', 'lead_auditor', 'viewer')"))
_both14("a lead auditor cannot do it", 2, lambda p: p.replace("('org_admin', 'lead_auditor')", "('org_admin')"))
_both14("an organisation admin cannot do it", 2, lambda p: p.replace("('org_admin', 'lead_auditor')", "('lead_auditor')"))
_both14("an archived client's audit can be changed", 3, lambda p: "")

MUTATIONS += [
  (_C14, "closing an already closed audit is not refused with its own message [close-db]", "  IF a.status = 'closed' THEN\n    RAISE EXCEPTION 'AUDIT_ALREADY_CLOSED", "  IF false THEN\n    RAISE EXCEPTION 'AUDIT_ALREADY_CLOSED"),
  (_C14, "closing does not record who closed it [close-db]", "closed_at = now(), closed_by = v_actor WHERE id = a.id;", "closed_at = now() WHERE id = a.id;"),
  (_C14, "closing does not record when [close-db]", "SET status = 'closed', closed_at = now(), closed_by = v_actor", "SET status = 'closed', closed_at = a.created_at, closed_by = v_actor"),
  (_C14, "closing is not written to the audit log [close-db]", "  INSERT INTO audit_log (org_id, tenant_id, actor_id, action, entity, entity_id, change)\n  VALUES (a.org_id, a.tenant_id, v_actor, 'audit.closed', 'audit', a.id::text,\n          jsonb_build_object('name', a.name, 'applicableControls', v_applicable, 'acceptedControls', v_accepted));\n", ""),
  (_C14, "the closing entry is attributed to someone else [close-db]", "VALUES (a.org_id, a.tenant_id, v_actor, 'audit.closed'", "VALUES (a.org_id, a.tenant_id, a.created_by, 'audit.closed'"),
  (_C14, "the closing entry leaves out the cycle's name [close-db]", "jsonb_build_object('name', a.name, 'applicableControls', v_applicable, 'acceptedControls', v_accepted)", "jsonb_build_object('applicableControls', v_applicable, 'acceptedControls', v_accepted)"),
  (_C14, "the closing entry leaves out the number of applicable controls [close-db]", "'name', a.name, 'applicableControls', v_applicable, 'acceptedControls', v_accepted)", "'name', a.name, 'acceptedControls', v_accepted)"),
  (_C14, "the closing entry leaves out the number of accepted controls [close-db]", "'applicableControls', v_applicable, 'acceptedControls', v_accepted)", "'applicableControls', v_applicable)"),
  (_C14, "the applicable count includes controls marked not applicable [close-db]", "SELECT count(*) FILTER (WHERE applicable), count(*) FILTER", "SELECT count(*), count(*) FILTER"),
  (_C14, "the accepted count includes controls marked not applicable [close-db]", "count(*) FILTER (WHERE applicable AND status = 'accepted')", "count(*) FILTER (WHERE status = 'accepted')"),
  (_C14, "reopening an audit that is not closed is not refused [close-db]", "  IF a.status <> 'closed' THEN\n    RAISE EXCEPTION 'AUDIT_NOT_CLOSED", "  IF false THEN\n    RAISE EXCEPTION 'AUDIT_NOT_CLOSED"),
  (_C14, "reopening needs no reason [close-db]", "  IF length(v_reason) < 3 OR length(v_reason) > 1000 THEN", "  IF false THEN"),
  (_C14, "a reason of one or two characters is accepted [close-db]", "IF length(v_reason) < 3 OR", "IF length(v_reason) < 1 OR"),
  (_C14, "a reason of two characters is accepted [close-db]", "IF length(v_reason) < 3 OR", "IF length(v_reason) < 2 OR"),
  (_C14, "a reason must be four characters [close-db]", "IF length(v_reason) < 3 OR", "IF length(v_reason) < 4 OR"),
  (_C14, "a reason of any length is accepted [close-db]", "OR length(v_reason) > 1000 THEN", "OR false THEN"),
  (_C14, "a reason of 1001 characters is accepted [close-db]", "OR length(v_reason) > 1000 THEN", "OR length(v_reason) > 1001 THEN"),
  (_C14, "a reason must be under 1000 characters [close-db]", "OR length(v_reason) > 1000 THEN", "OR length(v_reason) > 999 THEN"),
  (_C14, "a reason of blank spaces counts [close-db]", "v_reason text := btrim(coalesce(p_reason, ''));", "v_reason text := coalesce(p_reason, '');"),
  (_C14, "a missing reason is accepted [close-db]", "v_reason text := btrim(coalesce(p_reason, ''));", "v_reason text := btrim(p_reason);"),
  (_C14, "reopening leaves the closing person in place [close-db]", "SET status = 'in_progress', closed_at = NULL, closed_by = NULL", "SET status = 'in_progress', closed_at = NULL"),
  (_C14, "reopening does not clear the closing time [close-db]", "SET status = 'in_progress', closed_at = NULL, closed_by = NULL", "SET status = 'in_progress', closed_by = NULL"),
  (_C14, "reopening is not written to the audit log [close-db]", "  INSERT INTO audit_log (org_id, tenant_id, actor_id, action, entity, entity_id, change)\n  VALUES (a.org_id, a.tenant_id, v_actor, 'audit.reopened', 'audit', a.id::text,\n          jsonb_build_object('name', a.name, 'reason', v_reason, 'closedAt', a.closed_at, 'closedBy', a.closed_by));\n", ""),
  (_C14, "the reopening entry is attributed to someone else [close-db]", "VALUES (a.org_id, a.tenant_id, v_actor, 'audit.reopened'", "VALUES (a.org_id, a.tenant_id, a.created_by, 'audit.reopened'"),
  (_C14, "the reopening entry leaves out the cycle's name [close-db]", "jsonb_build_object('name', a.name, 'reason', v_reason,", "jsonb_build_object('reason', v_reason,"),
  (_C14, "the reopening entry leaves out the reason [close-db]", "'name', a.name, 'reason', v_reason, 'closedAt'", "'name', a.name, 'closedAt'"),
  (_C14, "the reopening entry leaves out when it had been closed [close-db]", "'reason', v_reason, 'closedAt', a.closed_at, 'closedBy', a.closed_by)", "'reason', v_reason, 'closedBy', a.closed_by)"),
  (_C14, "the reopening entry leaves out who had closed it [close-db]", "'closedAt', a.closed_at, 'closedBy', a.closed_by)", "'closedAt', a.closed_at)"),
  (_C14, "the reopening entry records the untrimmed text [close-db]", "'reason', v_reason,", "'reason', p_reason,"),
  # the status can only change through those two functions
  (_C14, "the application can write the status directly (table-wide permission kept) [close-db]", "REVOKE INSERT, UPDATE ON audits FROM portal_app;\n", ""),
  (_C14, "the application may update the status column [close-db]", "GRANT UPDATE (name) ON audits TO portal_app;", "GRANT UPDATE (name, status) ON audits TO portal_app;"),
  (_C14, "the application may update the closing time [close-db]", "GRANT UPDATE (name) ON audits TO portal_app;", "GRANT UPDATE (name, closed_at) ON audits TO portal_app;"),
  (_C14, "the application may update who closed the cycle [close-db]", "GRANT UPDATE (name) ON audits TO portal_app;", "GRANT UPDATE (name, closed_by) ON audits TO portal_app;"),
  (_C14, "the application may insert a cycle with a closing time [close-db]", "GRANT INSERT (org_id, tenant_id, template_id, template_version, name, created_by) ON audits TO portal_app;", "GRANT INSERT (org_id, tenant_id, template_id, template_version, name, created_by, closed_at, closed_by, status) ON audits TO portal_app;"),
  (_C14, "creating an audit is no longer possible for the application [close-db]", "GRANT INSERT (org_id, tenant_id, template_id, template_version, name, created_by) ON audits TO portal_app;", ""),
  (_C14, "renaming an audit is no longer possible for the application [close-db]", "GRANT UPDATE (name) ON audits TO portal_app;", ""),
  (_C14, "'closed' without a closing time, or a time without 'closed', is accepted [close-db]", "ALTER TABLE audits ADD CONSTRAINT audits_closed_consistent CHECK ((status = 'closed') = (closed_at IS NOT NULL));", ""),
  (_C14, "a closing time on an open cycle is accepted [close-db]", "CHECK ((status = 'closed') = (closed_at IS NOT NULL))", "CHECK (status <> 'closed' OR closed_at IS NOT NULL)"),
  (_C14, "'closed' without a closing time is accepted [close-db]", "CHECK ((status = 'closed') = (closed_at IS NOT NULL))", "CHECK (closed_at IS NULL OR status = 'closed')"),
  (_C14, "the upgrade leaves already-closed cycles without a closing time [close-db]", "UPDATE audits SET closed_at = created_at WHERE status = 'closed' AND closed_at IS NULL;", ""),
  (_C14, "the upgrade overwrites an existing closing time [close-db]", "UPDATE audits SET closed_at = created_at WHERE status = 'closed' AND closed_at IS NULL;", "UPDATE audits SET closed_at = created_at WHERE status = 'closed';"),
  (_C14, "the upgrade gives open cycles a closing time [close-db]", "UPDATE audits SET closed_at = created_at WHERE status = 'closed' AND closed_at IS NULL;", "UPDATE audits SET closed_at = created_at WHERE closed_at IS NULL;"),
  # the cycle's own row
  (_C14, "a closed cycle can be renamed (guard trigger missing) [close-db]", "CREATE TRIGGER audits_closed_guard BEFORE UPDATE ON audits FOR EACH ROW EXECUTE FUNCTION audits_closed_guard();", ""),
  (_C14, "a closed cycle can be renamed (guard condition weakened) [close-db]", "IF OLD.status = 'closed' AND NEW.status = 'closed' THEN", "IF false THEN"),
  (_C14, "a closed cycle cannot be reopened (guard too strict) [close-db]", "IF OLD.status = 'closed' AND NEW.status = 'closed' THEN", "IF OLD.status = 'closed' THEN"),
  (_C14, "an open cycle cannot be closed (guard too strict) [close-db]", "IF OLD.status = 'closed' AND NEW.status = 'closed' THEN", "IF NEW.status = 'closed' THEN"),
  (_C14, "the guard on the cycle's row gives the wrong refusal [close-db]", "RAISE EXCEPTION 'AUDIT_CLOSED: This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.'\n      USING ERRCODE = 'P0001';\n  END IF;\n  RETURN NEW;\nEND\n$$;\nCREATE TRIGGER audits_closed_guard", "RAISE EXCEPTION 'FORBIDDEN_ROLE: nope'\n      USING ERRCODE = 'P0001';\n  END IF;\n  RETURN NEW;\nEND\n$$;\nCREATE TRIGGER audits_closed_guard"),
  # the lock on the pieces of a cycle
  (_C14, "the lock is never applied (cycle never counts as closed) [close-db]", "WHERE a.status = 'closed'\n      AND a.id IN", "WHERE a.status = 'no-such-status'\n      AND a.id IN"),
  (_C14, "the lock refuses with the wrong message [close-db]", "IF v_closed THEN\n    RAISE EXCEPTION 'AUDIT_CLOSED: This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.'", "IF v_closed THEN\n    RAISE EXCEPTION 'FORBIDDEN_ROLE: This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.'"),
  (_C14, "the lock refuses even when the cycle is open [close-db]", "IF v_closed THEN\n    RAISE EXCEPTION 'AUDIT_CLOSED", "IF true THEN\n    RAISE EXCEPTION 'AUDIT_CLOSED"),
  (_C14, "scan results and integrity flags are blocked on a closed cycle [close-db]", "  IF TG_TABLE_NAME = 'evidence_files' AND TG_OP = 'UPDATE' THEN RETURN NEW; END IF;\n", ""),
  (_C14, "evidence can be added or removed on a closed cycle (exemption covers more than updates) [close-db]", "IF TG_TABLE_NAME = 'evidence_files' AND TG_OP = 'UPDATE' THEN", "IF TG_TABLE_NAME = 'evidence_files' THEN"),
  (_C14, "any table's rows can be updated on a closed cycle (exemption covers every table) [close-db]", "IF TG_TABLE_NAME = 'evidence_files' AND TG_OP = 'UPDATE' THEN", "IF TG_OP = 'UPDATE' THEN"),
  (_C14, "a row can be moved out of a closed cycle (old row not checked on update) [close-db]", "IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;", "IF TG_OP = 'DELETE' THEN v_old := to_jsonb(OLD); END IF;"),
  (_C14, "a row can be moved into a closed cycle (new row not checked on update) [close-db]", "IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;", "IF TG_OP = 'INSERT' THEN v_new := to_jsonb(NEW); END IF;"),
  (_C14, "rows can be removed from a closed cycle (old row never checked) [close-db]", "FROM (VALUES (v_old), (v_new)) AS r (j)", "FROM (VALUES (v_new)) AS r (j)"),
  (_C14, "rows can be added to a closed cycle (new row never checked) [close-db]", "FROM (VALUES (v_old), (v_new)) AS r (j)", "FROM (VALUES (v_old)) AS r (j)"),
  (_C14, "a control's own rows are not found by the lock (looked up as if they belonged to another table) [close-db]", "SELECT CASE WHEN TG_TABLE_NAME = 'audit_controls'", "SELECT CASE WHEN TG_TABLE_NAME = 'no-such-table'"),
  (_C14, "the lock is hidden by row-level security from people who cannot read the audits table [close-db]", "CREATE FUNCTION audit_closed_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS", "CREATE FUNCTION audit_closed_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS"),
  (_C14, "a delete is let through with a changed row [close-db]", "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\n  RETURN NEW;", "RETURN NEW;"),
]
for _t in ("audit_controls", "control_assignments", "evidence_files", "comments", "reviews"):
    _trigger = f"CREATE TRIGGER audit_closed_lock BEFORE INSERT OR UPDATE OR DELETE ON {_t}\n  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();"
    MUTATIONS.append((_C14, f"{_t} is not locked at all on a closed cycle [close-db]", _trigger, ""))
    for _op in ("INSERT", "UPDATE", "DELETE"):
        if _t == "evidence_files" and _op == "UPDATE":
            continue  # the function lets updates of an evidence file through anyway, so this trigger event changes nothing
        _kept = " OR ".join(o for o in ("INSERT", "UPDATE", "DELETE") if o != _op)
        MUTATIONS.append((_C14, f"{_t}: a {_op.lower()} is not stopped on a closed cycle [close-db]", _trigger,
                          f"CREATE TRIGGER audit_closed_lock BEFORE {_kept} ON {_t}\n  FOR EACH ROW EXECUTE FUNCTION audit_closed_lock();"))


# Breakages in application code (src/). Each names the test files that should notice it — a targeted run is
# much faster than the whole suite, and a breakage that survives a targeted run is simply re-run in full.
SOURCE_MUTATIONS = [
  # file, name, old, new, tests that must fail
  ("src/services/passwordReset.ts", "a too-weak new password is accepted", '  if (!check.ok) throw new AppError(check.reason!, 422, "WEAK_PASSWORD");\n', "", ["tests/36-password-reset-http.test.ts"]),
  ("src/services/passwordReset.ts", "the reset email points at the wrong page", "/reset-password?token=${token}", "/accept-invite?token=${token}", ["tests/36-password-reset-http.test.ts"]),
  ("src/services/passwordReset.ts", "the reset email goes to the address as typed, not the one on file", "to: [rows[0].out_email],", "to: [email],", ["tests/36-password-reset-http.test.ts"]),
  ("src/services/passwordReset.ts", "an unknown address is told so", "if (rows.length === 0) return { settled: Promise.resolve() };", 'if (rows.length === 0) throw new AppError("No such account.", 404, "NOT_FOUND");', ["tests/36-password-reset-http.test.ts"]),
  ("src/services/passwordReset.ts", "an unexpected mail error is logged in full (address and link included)", ': "[email] password reset: sending failed unexpectedly"', ': `[email] password reset: ${String(e)}`', ["tests/36-password-reset-http.test.ts"]),
  ("src/services/passwordReset.ts", "a mail failure is surfaced to the visitor", "(e: unknown) => { console.error(e instanceof EmailDeliveryError ? `[email] password reset: ${e.message}` : \"[email] password reset: sending failed unexpectedly\"); },", "(e: unknown) => { throw e; },", ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "the visitor waits for the mail server before getting an answer", "    await reset.requestPasswordReset(deps.pool, b.email, { email: deps.email, appBaseUrl: deps.appBaseUrl });", "    await (await reset.requestPasswordReset(deps.pool, b.email, { email: deps.email, appBaseUrl: deps.appBaseUrl })).settled;", ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "a completed reset also signs the person in", "res.json({ ok: true });", 'res.json({ ok: true, token: "session-token" });', ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "forgot-password is not rate limited", 'r.post("/auth/forgot-password", resetLimit(), h(', 'r.post("/auth/forgot-password", h(', ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "reset-password is not rate limited", 'r.post("/auth/reset-password", resetLimit(), h(', 'r.post("/auth/reset-password", h(', ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "login is not rate limited", 'r.post("/auth/login", signIn(), h(', 'r.post("/auth/login", h(', ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "accept-invite is not rate limited", 'r.post("/auth/accept-invite", signIn(), h(', 'r.post("/auth/accept-invite", h(', ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "forgot-password and reset-password share one counter", "  const resetLimit = () => rateLimit({ windowMs: limits.windowMs, max: limits.passwordReset });", "  const sharedReset = rateLimit({ windowMs: limits.windowMs, max: limits.passwordReset });\n  const resetLimit = () => sharedReset;", ["tests/36-password-reset-http.test.ts"]),
  ("src/http/routes/auth.ts", "the same answer is not given for every outcome", "res.status(202).json({ message: FORGOT_PASSWORD_MESSAGE });", "res.status(202).json({ message: FORGOT_PASSWORD_MESSAGE, queued: true });", ["tests/36-password-reset-http.test.ts"]),
  ("src/http/app.ts", "default sign-in allowance is far too small", "signIn: 60 }", "signIn: 3 }", ["tests/36-password-reset-http.test.ts"]),
  ("src/http/app.ts", "every X-Forwarded-For value is believed", 'app.set("trust proxy", deps.trustProxy ?? 0);', 'app.set("trust proxy", true);', ["tests/36-password-reset-http.test.ts", "tests/35-rate-limit.test.ts"]),
  ("src/http/app.ts", "the proxy setting is ignored", 'app.set("trust proxy", deps.trustProxy ?? 0);', 'app.set("trust proxy", 0);', ["tests/36-password-reset-http.test.ts"]),
  ("src/auth/jwt.ts", "the session check is skipped", "if (this.sessionCheck) {", "if (false as boolean && this.sessionCheck) {", ["tests/36-password-reset-http.test.ts"]),
  ("src/auth/jwt.ts", "the session check is asked about 'now' instead of when the token was issued", "new Date(iat * 1000)", "new Date()", ["tests/36-password-reset-http.test.ts"]),
  ("src/auth/jwt.ts", "a token with no issue time is let through", '      if (typeof iat !== "number") return null;\n', "", ["tests/36-password-reset-http.test.ts"]),
  ("src/auth/sessionCheck.ts", "anything is sent to the database as a user id", "    if (!UUID.test(userId)) return false;\n", "", ["tests/36-password-reset-http.test.ts"]),
  ("src/server.ts", "production does not check sessions against the database", "new JwtTokenVerifier(config.jwtSecret, dbSessionCheck(pool))", "new JwtTokenVerifier(config.jwtSecret)", ["tests/33-real-server-email-and-scan.test.ts"]),
  ("src/server.ts", "TRUST_PROXY never reaches the app", " trustProxy: config.trustProxy,", "", ["tests/33-real-server-email-and-scan.test.ts"]),
  ("src/config.ts", "TRUST_PROXY accepts any value", 'intSetting("TRUST_PROXY", 0, 0, 10)', 'intSetting("TRUST_PROXY", 0, 0, 1000000)', ["tests/32-config-and-wiring.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "one request too many is allowed", "entry.count > opts.max", "entry.count > opts.max + 1", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "one request too few is allowed", "entry.count > opts.max", "entry.count >= opts.max", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "the limit never lifts", "entry.resetAt <= t) {\n      clients.delete", "false) {\n      clients.delete", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "all visitors share one counter", 'const key = req.ip ?? "unknown";', 'const key = "everyone";', ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "no Retry-After header", '      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));\n', "", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "Retry-After rounds down", "Math.ceil((entry.resetAt - t) / 1000)", "Math.floor((entry.resetAt - t) / 1000)", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "the table of remembered addresses grows without bound", "while (clients.size >= maxClients) {", "while (false) {", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "a flood evicts the NEWEST address instead of the oldest", "const oldest = clients.keys().next();", "const oldest = { done: false as const, value: [...clients.keys()].at(-1)! };", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "the missing-TRUST_PROXY warning never appears", "if (!warned && req.headers", "if (false as boolean && req.headers", ["tests/35-rate-limit.test.ts"]),
  ("src/http/middleware/rateLimit.ts", "the missing-TRUST_PROXY warning repeats on every request", "      warned = true;\n", "", ["tests/35-rate-limit.test.ts"]),
  ('src/auth/totp.ts', 'codes are 7 digits long [mfa-src]', 'String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0")', 'String(bin % 10 ** 7).padStart(7, "0")', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'the accepted clock window is far too wide [mfa-src]', 'export const TOTP_WINDOW_STEPS = 1;', 'export const TOTP_WINDOW_STEPS = 3;', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'no clock drift at all is forgiven [mfa-src]', 'export const TOTP_WINDOW_STEPS = 1;', 'export const TOTP_WINDOW_STEPS = 0;', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'the matched step is reported wrongly [mfa-src]', '&& matched === null) matched = s;', '&& matched === null) matched = now;', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'anything is compared, not only six digits [mfa-src]', '  if (!/^\\d{6}$/.test(code)) return null;\n', '', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'an authenticator secret is only 80 bits [mfa-src]', 'base32Encode(randomBytes(20))', 'base32Encode(randomBytes(10))', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'ten recovery codes become eight [mfa-src]', 'export const RECOVERY_CODE_COUNT = 10;', 'export const RECOVERY_CODE_COUNT = 8;', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'recovery codes are only 40 bits [mfa-src]', 'base32Encode(randomBytes(10)).replace', 'base32Encode(randomBytes(5)).replace', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', "a recovery code's hash is not tied to the account [mfa-src]", '.update(`${userId}:${normalizedCode}`)', '.update(normalizedCode)', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'recovery codes are case-sensitive [mfa-src]', 'const c = input.toUpperCase().replace(/[\\s-]/g, "");', 'const c = input.replace(/[\\s-]/g, "");', ["tests/39-totp.test.ts"]),
  ('src/auth/totp.ts', 'the QR address omits the issuer [mfa-src]', 'secret: opts.secret, issuer: opts.issuer, algorithm', 'secret: opts.secret, algorithm', ["tests/39-totp.test.ts"]),
  ('src/auth/mfaToken.ts', 'the challenge is signed with the session secret itself [mfa-src]', 'const key = (secret: string) => createHmac("sha256", secret).update("evidence-portal:mfa-challenge:v1").digest();', 'const key = (secret: string) => Buffer.from(secret);', ["tests/39-totp.test.ts"]),
  ('src/auth/mfaToken.ts', 'the challenge carries the session issuer [mfa-src]', 'const ISSUER = "evidence-portal-mfa";', 'const ISSUER = "evidence-portal";', ["tests/39-totp.test.ts"]),
  ('src/auth/mfaToken.ts', "the challenge's kind is not checked [mfa-src]", 'p.typ !== "mfa" || ', '', ["tests/39-totp.test.ts"]),
  ('src/auth/mfaToken.ts', 'the challenge lives an hour [mfa-src]', '5 * 60;', '60 * 60;', ["tests/39-totp.test.ts"]),
  ('src/auth/mfaToken.ts', "the challenge's subject is not required [mfa-src]", ' || typeof p.sub !== "string"', '', ["tests/39-totp.test.ts"]),
  ('src/services/auth.ts', 'two-step accounts are signed straight in [mfa-src]', '  if (mfaOn) return { mfaRequired: true, mfaToken: signMfaToken(row.id, jwtSecret) };\n', '', ["tests/40-mfa-http.test.ts"]),
  ('src/services/auth.ts', 'a correct password clears the failure count before the second step [mfa-src]', '  if (mfaOn) return { mfaRequired: true, mfaToken: signMfaToken(row.id, jwtSecret) };\n', '  await withoutUser(pool, (c) => c.query("SELECT auth_record_login_success($1)", [row.id]));\n  if (mfaOn) return { mfaRequired: true, mfaToken: signMfaToken(row.id, jwtSecret) };\n', ["tests/40-mfa-http.test.ts"]),
  ('src/services/auth.ts', 're-confirming the password does not count wrong attempts [mfa-src]', '    await withoutUser(pool, (c) => c.query("SELECT auth_record_login_failure($1)", [userId]));\n', '', ["tests/40-mfa-http.test.ts"]),
  ('src/services/auth.ts', 'a wrong password on re-confirmation signs the person out [mfa-src]', 'throw new AppError("Incorrect password.", 403, "INVALID_PASSWORD");', 'throw new AppError("Incorrect password.", 401, "INVALID_PASSWORD");', ["tests/40-mfa-http.test.ts"]),
  ('src/services/auth.ts', 're-confirming ignores the lock-out [mfa-src]', '  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {\n    throw new AppError("Too many failed attempts. Please try again in a few minutes.", 423, "ACCOUNT_LOCKED");\n  }\n  if (!(await verifyPassword(password, row.password_hash))) {', '  if (!(await verifyPassword(password, row.password_hash))) {', ["tests/40-mfa-http.test.ts"]),
  ('src/services/auth.ts', 'an account with no local password reaches the password check [mfa-src]', '  if (!row.password_hash) {\n    throw new AppError("This account signs in through', '  if (false) {\n    throw new AppError("This account signs in through', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/auth.ts', 'the second step is not rate limited [mfa-src]', 'r.post("/auth/mfa/verify", signIn(), h(', 'r.post("/auth/mfa/verify", h(', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/auth.ts', 'the password-step response may be cached [mfa-src]', '    res.set("Cache-Control", "no-store");\n    res.json(result); // a session, or', '    res.json(result); // a session, or', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/auth.ts', 'the second-step response may be cached [mfa-src]', '    res.set("Cache-Control", "no-store");\n    res.json(result);\n  }));\n\n  r.post("/auth/accept-invite"', '    res.json(result);\n  }));\n\n  r.post("/auth/accept-invite"', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'secrets and recovery codes may be cached [mfa-src]', 'const noStore = (res: Response) => { res.set("Cache-Control", "no-store"); };', 'const noStore = (_res: Response) => {};', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'enrolment is not rate limited [mfa-src]', 'r.post("/auth/mfa/enroll", guarded(), h(', 'r.post("/auth/mfa/enroll", h(', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'enrolment confirmation is not rate limited [mfa-src]', 'r.post("/auth/mfa/enroll/confirm", guarded(), h(', 'r.post("/auth/mfa/enroll/confirm", h(', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'turning off is not rate limited [mfa-src]', 'r.post("/auth/mfa/disable", guarded(), h(', 'r.post("/auth/mfa/disable", h(', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'new recovery codes are not rate limited [mfa-src]', 'r.post("/auth/mfa/recovery-codes", guarded(), h(', 'r.post("/auth/mfa/recovery-codes", h(', ["tests/40-mfa-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'the admin reset id is not checked [mfa-src]', 'const target = parse(uuidSchema, pid(req, "id"));', 'const target = pid(req, "id");', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'enrolling does not re-check the password [mfa-src]', 'const account = await confirmPassword(pool, userId, password);', 'const account = { email: userId };', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'the authenticator secret is stored unencrypted [mfa-src]', 'c.query("SELECT mfa_begin_enrollment($1)", [s.encrypt(secret)])', 'c.query("SELECT mfa_begin_enrollment($1)", [secret])', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'a recovery code can confirm enrolment [mfa-src]', 'if (!typed || typed.kind !== "totp") throw', 'if (!typed) throw', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'turning off needs no code [mfa-src]', '  await confirmPassword(pool, userId, password);\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', '  await confirmPassword(pool, userId, password);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'turning off needs no password [mfa-src]', '  await confirmPassword(pool, userId, password);\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', '  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'a wrong code when turning off signs the person out [mfa-src]', '  await confirmPassword(pool, userId, password);\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', '  await confirmPassword(pool, userId, password);\n  await verifySecondStep(pool, store, userId, rawCode, 401, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'new recovery codes need no code [mfa-src]', '  await requireEnabled(pool, store, userId);\n  await confirmPassword(pool, userId, password);\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  const { codes, hashes } = newRecoverySet(userId);', '  await requireEnabled(pool, store, userId);\n  await confirmPassword(pool, userId, password);\n  const { codes, hashes } = newRecoverySet(userId);', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'new recovery codes need no password [mfa-src]', '  await requireEnabled(pool, store, userId);\n  await confirmPassword(pool, userId, password);\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  const { codes, hashes } = newRecoverySet(userId);', '  await requireEnabled(pool, store, userId);\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  const { codes, hashes } = newRecoverySet(userId);', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'recovery codes are hashed without the account [mfa-src]', 'codes.map((c) => hashRecoveryCode(userId, normalizeRecoveryCode(c)!))', 'codes.map((c) => hashRecoveryCode("shared", normalizeRecoveryCode(c)!))', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'the lock-out is not announced on the attempt that causes it [mfa-src]', '  if ((await loginState(pool, userId))?.locked) throw locked();\n', '', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'a missing encryption key is not reported cleanly [mfa-src]', '    if (!store) throw notConfigured();\n', '', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', "an undecryptable secret is logged with the account's id [mfa-src]", 'console.error("Two-step sign-in: an account\'s authenticator secret could not be decrypted — has SECRET_ENCRYPTION_KEY changed?");', 'console.error(`Two-step sign-in: could not decrypt the secret for ${userId} — has SECRET_ENCRYPTION_KEY changed?`);', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'the second step ignores the password lock-out [mfa-src]', '  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {\n    throw new AppError("Too many failed attempts. Please try again in a few minutes.", 423, "ACCOUNT_LOCKED");\n  }\n\n  let used', '\n  let used', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'two-step switched off between the steps is reported as a conflict [mfa-src]', '    if (e instanceof AppError && e.code === "MFA_NOT_ENABLED") throw expired();\n', '', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'the used-recovery-code notice is dropped [mfa-src]', 'return used.usedRecoveryCode ? { ...session, recoveryCodeUsed: true } : session;', 'return session;', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'a completed second step is not recorded as a sign-in [mfa-src]', '  await withoutUser(pool, (c) => c.query("SELECT auth_record_login_success($1)", [userId]));\n  const session', '  const session', ["tests/40-mfa-http.test.ts"]),
  ('src/services/mfa.ts', 'the status claims two-step is available without a key [mfa-src]', 'available: !!store', 'available: true', ["tests/40-mfa-http.test.ts"]),
  ('src/services/users.ts', 'everyone is shown the two-step column [mfa-src]', 'return flags.size === 0 ? rows : rows.map(', 'return rows.map(', ["tests/40-mfa-http.test.ts"]),
  ("src/services/users.ts", "everyone shows as having it on, whatever the database says [mfa-src]", "rows.map((x) => [x.user_id, x.enabled])", "rows.map((x) => [x.user_id, true])", ["tests/40-mfa-http.test.ts"]),
  ('src/http/app.ts', 'the two-step settings routes are not mounted [mfa-src]', '  app.use(mfaRouter(deps));\n', '', ["tests/40-mfa-http.test.ts"]),
  ('src/http/app.ts', 'the two-step settings routes are open to signed-out visitors [mfa-src]', '  app.use(authRouter(deps));\n', '  app.use(authRouter(deps));\n  app.use(mfaRouter(deps));\n', ["tests/40-mfa-http.test.ts"]),
  # --- 011: changing your password, and the organisation's two-step policy ---
  ("src/services/account.ts", "a too-weak new password is accepted [011-src]", '  const strength = checkPasswordStrength(input.newPassword);\n  if (!strength.ok) throw new AppError(strength.reason!, 422, "WEAK_PASSWORD");\n', "", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "the new password may be the same as the current one [011-src]", '  if (await verifyPassword(input.newPassword, account.password_hash!)) {\n    throw new AppError("Choose a password that is different from your current one.", 422, "SAME_PASSWORD");\n  }\n', "", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "two-step sign-in is ignored when changing the password [011-src]", "const twoStep = (await getStatus(pool, store, userId)).enabled;", "const twoStep = false;", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "a missing code is not asked for up front [011-src]", "if (twoStep && !input.code) {", "if (false) {", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "the code is not checked [011-src]", "  if (twoStep) await verifySecondStep(pool, store, userId, input.code!, 403, notify);\n", "", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "a wrong code signs the person out (401 instead of 403) [011-src]", "await verifySecondStep(pool, store, userId, input.code!, 403, notify);", "await verifySecondStep(pool, store, userId, input.code!, 401, notify);", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "the fresh session is stamped with the server's clock only [011-src]", "return Math.max(Math.floor(nowMs / 1000), Math.floor(revokedAt.getTime() / 1000));", "return Math.floor(nowMs / 1000);", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "the fresh session is stamped with the earlier of the two clocks [011-src]", "return Math.max(Math.floor(nowMs / 1000), Math.floor(revokedAt.getTime() / 1000));", "return Math.min(Math.floor(nowMs / 1000), Math.floor(revokedAt.getTime() / 1000));", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "the fresh session is not stamped at all [011-src]", "return sessionFor(account, jwtSecret, issuedAtAfter(revokedAt));", "return sessionFor(account, jwtSecret);", ["tests/42-change-password-http.test.ts"]),
  ("src/services/account.ts", "a password changed elsewhere in the meantime is not reported [011-src]", '  if (!revokedAt) throw new AppError("Your password was changed somewhere else a moment ago. Please check and try again.", 409, "PASSWORD_CHANGED_ELSEWHERE");\n', "", ["tests/42-change-password-http.test.ts"]),
  ("src/http/routes/account.ts", "changing the password is not rate limited [011-src]", "r.post(\"/auth/change-password\", rateLimit({ windowMs: limits.windowMs, max: limits.signIn }), h(", "r.post(\"/auth/change-password\", h(", ["tests/42-change-password-http.test.ts"]),
  ("src/http/routes/account.ts", "the new session may be cached [011-src]", '    res.set("Cache-Control", "no-store");\n', "", ["tests/42-change-password-http.test.ts"]),
  ("src/http/routes/account.ts", "a code is dropped from the request [011-src]", "res.json(await account.changePassword(deps.pool, deps.jwtSecret, deps.secretStore, req.userId!, b, notify));", "res.json(await account.changePassword(deps.pool, deps.jwtSecret, deps.secretStore, req.userId!, { currentPassword: b.currentPassword, newPassword: b.newPassword }, notify));", ["tests/42-change-password-http.test.ts"]),
  ("src/http/app.ts", "the change-password route is not mounted [011-src]", "  app.use(accountRouter(deps));\n", "", ["tests/42-change-password-http.test.ts"]),
  ("src/http/app.ts", "the change-password route is open to signed-out visitors [011-src]", "  app.use(authRouter(deps));\n", "  app.use(authRouter(deps));\n  app.use(accountRouter(deps));\n", ["tests/42-change-password-http.test.ts"]),
  ("src/auth/jwt.ts", "a session stamped with a chosen moment ignores it [011-src]", "issuedAt === undefined ? { sub: userId } : { sub: userId, iat: issuedAt }", "{ sub: userId }", ["tests/42-change-password-http.test.ts"]),
  ("src/errors.ts", "'your organisation requires it' is a generic 400 [011-src]", "  MFA_REQUIRED_BY_POLICY: 403,\n", "", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/errors.ts", "'turn on your own two-step first' is a generic 400 [011-src]", "  MFA_ADMIN_NEEDS_MFA: 409,\n", "", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/services/mfa.ts", "the status never says the organisation requires two-step sign-in [011-src]", "required: r.required === true };", "required: false };", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/services/mfa.ts", "turning off is only refused after the password and code are checked [011-src]", '  if (st.required) throw new AppError("Your organisation requires two-step sign-in, so it cannot be turned off.", 403, "MFA_REQUIRED_BY_POLICY");\n', "", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/services/mfa.ts", "the policy can be switched on by a server that can't check codes [011-src]", '  if (policy !== "off") requireStore(store);\n', "", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/services/mfa.ts", "the policy can't be switched off by a server that can't check codes [011-src]", 'if (policy !== "off") requireStore(store);', "requireStore(store);", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/services/mfa.ts", "the policy page claims two-step is available without a key [011-src]", "available: !!store,\n    staff:", "available: true,\n    staff:", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/services/mfa.ts", "someone who is not an admin gets an empty policy instead of a refusal [011-src]", 'if (!r) throw new AppError("Only an organisation admin can see or change the two-step sign-in policy.", 403, "FORBIDDEN_ROLE");', 'if (!r) return { policy: "off", available: !!store, staff: { total: 0, enrolled: 0 }, everyone: { total: 0, enrolled: 0 } };', ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "a database failure lets the request through [011-src]", "    } catch (e) {\n      next(e);\n    }", "    } catch (e) {\n      next();\n    }", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "the policy never blocks anyone [011-src]", "if (row?.required === true && row.enabled !== true) {", "if (false) {", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "the policy blocks people who have already set it up [011-src]", "if (row?.required === true && row.enabled !== true) {", "if (row?.required === true) {", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "the policy blocks people it does not cover [011-src]", "if (row?.required === true && row.enabled !== true) {", "if (row?.enabled !== true) {", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "the block is a 401, which signs the person out [011-src]", "return res.status(403).json({ error: { code: \"MFA_SETUP_REQUIRED\"", "return res.status(401).json({ error: { code: \"MFA_SETUP_REQUIRED\"", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "people who must set it up can't confirm the set-up [011-src]", ', "POST /auth/mfa/enroll/confirm"]', ']', ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "people who must set it up can also use something else [011-src]", '"POST /auth/mfa/enroll/confirm"]', '"POST /auth/mfa/enroll/confirm", "GET /users"]', ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/middleware/mfaPolicy.ts", "an id that isn't a UUID is looked up in the database [011-src]", "if (!userId || !UUID.test(userId)) return next();", "if (!userId) return next();", ["tests/43-mfa-policy-http.test.ts"]),
  ("src/http/app.ts", "the policy is not enforced at all [011-src]", "  app.use(enforceMfaPolicy(deps.pool));\n", "", ["tests/43-mfa-policy-http.test.ts"]),
  ('src/services/notices.ts', 'a disabled or invited account is mailed [012-src]', 'if (!who || who.status !== "active") return;', 'if (!who) return;', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'a notice is also sent to an address nobody asked for [012-src]', 'to: [who.email], subject, text', 'to: [who.email, "security@evidence-portal.example"], subject, text', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', "the account's internal id is printed in the notice [012-src]", 'to: [who.email], subject, text', 'to: [who.email], subject, text: `${text}\\nRef: ${who.id}`', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', "the account's password hash is printed in the notice [012-src]", 'to: [who.email], subject, text', 'to: [who.email], subject, text: `${text}\\n${who.password_hash}`', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'a mail failure is rethrown instead of logged [012-src]', '      })().catch((e: unknown) => {\n', '      })().catch((e: unknown) => {\n        throw e;\n', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'an unexpected mail error is logged in full [012-src]', ': `[email] security notice (${kind}): not sent`', ': `[email] security notice (${kind}): ${String(e)}`', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the log names the address [012-src]', 'console.error(e instanceof EmailDeliveryError ? `[email] security notice (${kind}): ${e.message}`', 'console.error(e instanceof EmailDeliveryError ? `[email] security notice (${kind}) for ${userId}: ${e.message}`', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'queued notices are not tracked, so a shutdown cannot wait for them [012-src]', '      pending.add(work);\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'waiting for notices ignores the time limit [012-src]', '}, timeoutMs); });', '}, timeoutMs * 1000); });', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the remaining recovery codes are not counted [012-src]', 'kind === "mfa_recovery_used" ? await recoveryCodesLeft(pool, userId) : undefined', 'undefined', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the nudge for a new set appears one code too late [012-src]', 'left <= LOW_RECOVERY_CODES ?', 'left < LOW_RECOVERY_CODES ?', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the nudge for a new set appears one code too early [012-src]', 'left <= LOW_RECOVERY_CODES ?', 'left <= LOW_RECOVERY_CODES + 1 ?', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'a notice does not say when it happened [012-src]', 'const when = formatUtc(ctx.at);', 'const when = "an unknown time";', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', "the 'if it wasn't you' link goes to the wrong page [012-src]", 'const reset = `${ctx.appBaseUrl}/forgot-password`;', 'const reset = `${ctx.appBaseUrl}/login`;', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the month is off by one [012-src]', 'MONTHS[d.getUTCMonth()]', 'MONTHS[(d.getUTCMonth() + 1) % 12]', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the footer no longer says no one will ask for a code [012-src]', 'We will never ask for your password or a code by email.', 'Thank you.', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/notices.ts', 'the password-change subject is the reset subject [012-src]', '"Your Evidence Portal password was changed"', '"Your Evidence Portal password was reset"', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/account.ts', 'a password change sends no notice [012-src]', '  notify?.notify(userId, "password_changed");\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/account.ts', 'a password change sends its notice even when refused [012-src]', '  const twoStep = (await getStatus(pool, store, userId)).enabled;', '  notify?.notify(userId, "password_changed");\n  const twoStep = (await getStatus(pool, store, userId)).enabled;', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/account.ts', 'the response waits for the notice to be delivered [012-src]', '  notify?.notify(userId, "password_changed");\n  return', '  notify?.notify(userId, "password_changed");\n  await (await import("./notices.ts")).flushNotices(30_000);\n  return', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/passwordReset.ts', 'a password reset by link sends no notice [012-src]', '  notify?.notify(userId, "password_reset");\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'turning two-step on sends no notice [012-src]', '  notify?.notify(userId, "mfa_enabled");\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'turning two-step on sends its notice even when nothing was set up [012-src]', '  if (!done) throw new AppError("Start setting up two-step sign-in first.", 409, "NO_ENROLLMENT");\n  notify?.notify(userId, "mfa_enabled");', '  notify?.notify(userId, "mfa_enabled");\n  if (!done) throw new AppError("Start setting up two-step sign-in first.", 409, "NO_ENROLLMENT");', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'turning two-step off sends no notice [012-src]', '  notify?.notify(userId, "mfa_disabled");\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'turning two-step off says it was turned on [012-src]', 'notify?.notify(userId, "mfa_disabled");', 'notify?.notify(userId, "mfa_enabled");', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'turning two-step off sends its notice even when refused [012-src]', '  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));\n  notify?.notify(userId, "mfa_disabled");', '  notify?.notify(userId, "mfa_disabled");\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'new recovery codes send no notice [012-src]', '  notify?.notify(userId, "mfa_recovery_regenerated");\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'new recovery codes send their notice even when refused [012-src]', '  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  const { codes, hashes } = newRecoverySet(userId);', '  notify?.notify(userId, "mfa_recovery_regenerated");\n  await verifySecondStep(pool, store, userId, rawCode, 403, notify);\n  const { codes, hashes } = newRecoverySet(userId);', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'using a recovery code sends no notice [012-src]', '    if (typed.kind === "recovery") notify?.notify(userId, "mfa_recovery_used");\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'a wrong recovery code sends a notice [012-src]', '  if (ok) {\n    if (typed.kind === "recovery") notify?.notify(userId, "mfa_recovery_used");\n', '  if (typed.kind === "recovery") notify?.notify(userId, "mfa_recovery_used");\n  if (ok) {\n', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'an authenticator code also sends a recovery-code notice [012-src]', 'if (typed.kind === "recovery") notify?.notify(userId, "mfa_recovery_used");', 'notify?.notify(userId, "mfa_recovery_used");', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', "an administrator's reset sends no notice [012-src]", '  if (reset) notify?.notify(targetUserId, "mfa_reset_by_admin"); // the person it happened to, never the admin\n', '', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', "an administrator's reset notifies the administrator instead [012-src]", 'notify?.notify(targetUserId, "mfa_reset_by_admin")', 'notify?.notify(actorId, "mfa_reset_by_admin")', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/mfa.ts', 'a reset that found nothing to reset still sends a notice [012-src]', 'if (reset) notify?.notify(targetUserId, "mfa_reset_by_admin")', 'notify?.notify(targetUserId, "mfa_reset_by_admin")', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/auth.ts', 'signing in with a recovery code sends no notice (not handed on) [012-src]', 'b.mfaToken, b.code, notify)', 'b.mfaToken, b.code)', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/auth.ts', 'a reset by link sends no notice (not handed on) [012-src]', 'reset.resetPassword(deps.pool, b.token, b.password, notify)', 'reset.resetPassword(deps.pool, b.token, b.password)', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/account.ts', 'a password change sends no notice (not handed on) [012-src]', 'req.userId!, b, notify)', 'req.userId!, b)', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'turning two-step on sends no notice (not handed on) [012-src]', 'req.userId!, b.code, notify)', 'req.userId!, b.code)', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'turning two-step off sends no notice (not handed on) [012-src]', 'mfa.disable(deps.pool, deps.secretStore, req.userId!, b.password, b.code, notify)', 'mfa.disable(deps.pool, deps.secretStore, req.userId!, b.password, b.code)', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/mfa.ts', 'new recovery codes send no notice (not handed on) [012-src]', 'mfa.regenerateRecoveryCodes(deps.pool, deps.secretStore, req.userId!, b.password, b.code, notify)', 'mfa.regenerateRecoveryCodes(deps.pool, deps.secretStore, req.userId!, b.password, b.code)', ["tests/44-security-notices-http.test.ts"]),
  ('src/http/routes/mfa.ts', "an administrator's reset sends no notice (not handed on) [012-src]", 'mfa.adminReset(deps.pool, req.userId!, target, notify)', 'mfa.adminReset(deps.pool, req.userId!, target)', ["tests/44-security-notices-http.test.ts"]),
  ('src/services/platformSettings.ts', 'a non-owner can send test emails [013-src]', 'async function requireOwner(pool: Pool, userId: string) {\n  if (!(await isOwner(pool, userId))) {', 'async function requireOwner(pool: Pool, userId: string) {\n  if (false) {', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', "saving ignores that the server's environment provides the group [013-src]", '  await requireOwner(d.pool, userId);\n  if (d.env[group]) throw envLocked(group);\n  if (SECRET_NAMES', '  await requireOwner(d.pool, userId);\n  if (SECRET_NAMES', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', "removing ignores that the server's environment provides the group [013-src]", '  await requireOwner(d.pool, userId);\n  if (d.env[group]) throw envLocked(group);\n  await reauthenticate', '  await requireOwner(d.pool, userId);\n  await reauthenticate', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a secret is "stored" without an encryption key [013-src]', 'if (SECRET_NAMES[group].length > 0 && !d.store) {', 'if (false) {', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'typing mistakes are only reported after the password is checked [013-src]', '  let parsed;\n  try { parsed = parseGroup(group, input, existing); } catch (e) {\n    if (e instanceof SettingsInputError) throw new AppError(e.message, 400, "VALIDATION");\n    throw e;\n  }\n\n  await reauthenticate(d, userId, reauth, notify);\n\n  const secretNames', '  await reauthenticate(d, userId, reauth, notify);\n  let parsed;\n  try { parsed = parseGroup(group, input, existing); } catch (e) {\n    if (e instanceof SettingsInputError) throw new AppError(e.message, 400, "VALIDATION");\n    throw e;\n  }\n\n  const secretNames', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'saving does not ask for the password [013-src]', '  await reauthenticate(d, userId, reauth, notify);\n\n  const secretNames', '\n  const secretNames', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'removing does not ask for the password [013-src]', '  await reauthenticate(d, userId, reauth, notify);\n  await run(() => withUser(d.pool, userId, (c) => c.query("SELECT platform_setting_clear($1)"', '  await run(() => withUser(d.pool, userId, (c) => c.query("SELECT platform_setting_clear($1)"', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a two-step code is not required [013-src]', 'if (twoStep && !reauth.code) {', 'if (false) {', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a two-step code is not checked [013-src]', 'if (twoStep) await verifySecondStep(', 'if (false) await verifySecondStep(', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a recovery code used here sends no notice [013-src]', 'await verifySecondStep(d.pool, d.store, userId, reauth.code!, 403, notify);', 'await verifySecondStep(d.pool, d.store, userId, reauth.code!, 403);', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a blank password replaces the stored one with nothing [013-src]', 'try { existing = openSecrets(d.store, stored?.out_secret_enc ?? null); }', 'try { existing = {}; }', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the audit log lists every field every time [013-src]', 'for (const [k, v] of Object.entries(parsed.config)) if (!same(v, stored?.out_config?.[k])) changed.add(k);', 'for (const [k, v] of Object.entries(parsed.config)) changed.add(k);', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the audit log never mentions a changed password [013-src]', 'for (const k of secretNames) if (parsed.secrets[k] !== existing[k]) changed.add(k);', '', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the settings page is sent the secret values [013-src]', 'values: state.settings ? describeSettings(group, state.settings) : null,', 'values: state.settings ? (state.settings as unknown as Record<string, string>) : null,', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the page claims secrets are set for settings the environment provides [013-src]', 'secretsSet: state.source === "environment" ? [] : (row?.out_secrets_set ?? []),', 'secretsSet: row?.out_secrets_set ?? [],', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the page shows who saved settings that came from the environment [013-src]', 'updatedBy: state.source === "panel" ? (row?.out_updated_by ?? null) : null,', 'updatedBy: row?.out_updated_by ?? null,', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the page does not say a code is needed [013-src]', 'const needsCode = (await getStatus(d.pool, d.store, userId)).enabled;', 'const needsCode = false;', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a save does not tell the running server to reload [013-src]', '  d.runtime.invalidate(); // the running server must use the new values from the very next email, upload or Google sign-in\n  return buildView', '  return buildView', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'a removal does not tell the running server to reload [013-src]', '  d.runtime.invalidate();\n  return buildView(d, userId);\n}\n\n/** Sends a short', '  return buildView(d, userId);\n}\n\n/** Sends a short', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the settings page shows remembered values, not current ones [013-src]', '  d.runtime.invalidate(); // the page should show what is true now, not what was cached a few seconds ago\n', '', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the test email can go to another address [013-src]', '      to: [me.email],', '      to: [me.email, "someone-else@example.test"],', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the test email says it worked when the mail server refused it [013-src]', '    if (e instanceof EmailDeliveryError) throw new AppError(e.message, 502, "EMAIL_TEST_FAILED");\n    throw new AppError("The test email could not be sent.", 502, "EMAIL_TEST_FAILED");', '    return { ok: true, sentTo: me.email };', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the test email is sent without a mail server being set up [013-src]', 'if (!smtp) throw new AppError("No mail server is set up yet. Save the email settings first.", 409, "NOT_CONFIGURED");', '', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the scanner check passes a scanner that catches nothing [013-src]', 'if (verdict !== "infected") {', 'if (false) {', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the scanner check uses a harmless file instead of the test virus [013-src]', 'Buffer.from(EICAR_TEST_STRING)', 'Buffer.from("hello")', ['tests/46-platform-settings-http.test.ts']),
  ('src/services/platformSettings.ts', 'the scanner check passes when the scanner is unreachable [013-src]', 'if (e instanceof ScannerUnavailableError) throw new AppError(e.message, 502, "SCANNER_TEST_FAILED");\n    throw new AppError("The scanner could not be checked.", 502, "SCANNER_TEST_FAILED");', 'return { ok: true };', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'saving settings is not rate-limited [013-src]', 'r.put("/platform/settings/:group", guarded(), h(', 'r.put("/platform/settings/:group", h(', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'removing settings is not rate-limited [013-src]', 'r.post("/platform/settings/:group/clear", guarded(), h(', 'r.post("/platform/settings/:group/clear", h(', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'the settings may be cached by the browser [013-src]', '  r.get("/platform/settings", h(async (req, res) => {\n    res.set("Cache-Control", "no-store");', '  r.get("/platform/settings", h(async (req, res) => {', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'everyone is told they are the owner [013-src]', 'res.json({ owner: await platform.isOwner(deps.pool, req.userId!) });', 'res.json({ owner: true });', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'an unknown group is not refused [013-src]', 'if (!isGroup(raw)) throw', 'if (false) throw', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'the test email is not rate-limited [013-src]', 'r.post("/platform/settings/email/test", guarded(), h(', 'r.post("/platform/settings/email/test", h(', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/routes/platform.ts', 'the scanner check is not rate-limited [013-src]', 'r.post("/platform/settings/scanner/test", guarded(), h(', 'r.post("/platform/settings/scanner/test", h(', ['tests/46-platform-settings-http.test.ts']),
  ('src/http/app.ts', 'the settings routes are reachable without signing in [013-src]', 'app.use(platformRouter(', 'app.use("/platform-open", platformRouter(', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'the port for TLS is the wrong one [013-src]', '{ starttls: 587, tls: 465, none: 25 }', '{ starttls: 587, tls: 25, none: 465 }', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'a login is allowed over an unencrypted connection [013-src]', '    if (security === "none") {\n      return fail("security"', '    if (false) {\n      return fail("security"', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'a web address is accepted as a mail server [013-src]', 'if (/^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//.test(v) || v.includes("/")) {', 'if (false) {', ['tests/46-platform-settings-http.test.ts', 'tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/validate.ts', 'the From address need not be an address [013-src]', 'if (!from.includes("@")) return', 'if (false) return', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'a password with a line break is accepted [013-src]', '/[\\r\\n\\0]/.test(typedPassword)', 'false', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'a password without a username is accepted [013-src]', 'if (typedPassword !== undefined) return fail("password", "A password needs a username.', 'if (false) return fail("password", "A password needs a username.', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'the Google client secret is not required the first time [013-src]', 'if (clientSecret === undefined) return fail(', 'if (false) return fail(', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'plain http is accepted for any Google redirect address [013-src]', '!(url.protocol === "http:" && local)', '!(url.protocol === "http:")', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'the Google redirect address can be any page [013-src]', 'if (!url.pathname.endsWith(CALLBACK_PATH)) return fail(', 'if (false) return fail(', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'the Google redirect address may carry a query or login [013-src]', 'if (url.username || url.password || url.search || url.hash) return fail(', 'if (false) return fail(', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'the scanner time limit has no upper bound [013-src]', '"The time limit", 1, 600, 60)', '"The time limit", 1, 600000, 60)', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'the scanner file size limit has no upper bound [013-src]', '"The largest file", 1, 4096, 25)', '"The largest file", 1, 4096000, 25)', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/validate.ts', 'a port outside 1-65535 is accepted [013-src]', '"The port", 1, 65535, 3310)', '"The port", 0, 6553500, 3310)', ['tests/46-platform-settings-http.test.ts']),
  ('src/settings/runtime.ts', 'the environment no longer wins over what was saved [013-src]', 'if (fromEnv) { out[group] = { source: "environment", settings: fromEnv }; continue; }', '', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'the database is read even when the environment provides everything [013-src]', 'GROUPS.every((g) => env[g]) ? [] : await loadStoredRows(opts.pool)', 'await loadStoredRows(opts.pool)', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'saved secrets are "opened" without a key [013-src]', 'if (!store) throw new SecretsUnreadable();', 'if (!store) return {};', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'one unusable group breaks all the others [013-src]', '        out[group] = { source: "none", problem };', '        throw e;', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'settings are remembered forever [013-src]', 'if (fresh && now() - fresh.at < ttl) return fresh.value;', 'if (fresh) return fresh.value;', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'settings are never remembered [013-src]', 'if (fresh && now() - fresh.at < ttl) return fresh.value;', 'if (false) return fresh!.value;', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'invalidate does not forget what was loaded [013-src]', '      generation++;\n      fresh = undefined;', '      generation++;', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'a load that started before a save is remembered anyway [013-src]', 'if (started === generation) fresh = { at: now(), value };', 'fresh = { at: now(), value };', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'a failed first load is treated as "nothing set up" [013-src]', '          throw e;\n        } finally {', '          return { email: { source: "none" }, scanner: { source: "none" }, google: { source: "none" } } as EffectiveSettings;\n        } finally {', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'the last good settings are dropped when the database blinks [013-src]', '          if (lastGood) {', '          if (false) {', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'after a database failure every request tries again [013-src]', 'if (started === generation) fresh = { at: now() - ttl + 1_000, value: lastGood };', '', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'simultaneous requests each load the settings [013-src]', 'if (inflight) return inflight;', '', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'an unusable group is logged on every reload [013-src]', 'if (!warnedProblems.has(`${group}:${problem}`)) {', 'if (true) {', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/runtime.ts', 'the database failure warning repeats on every request [013-src]', 'if (now() - lastStaleWarning >= STALE_WARNING_EVERY_MS) {', 'if (true) {', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'the mail sender never switches to new settings [013-src]', '    if (this.built?.key !== key) {\n      this.built = { key, sender', '    if (!this.built) {\n      this.built = { key, sender', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'the mail connection is rebuilt for every message [013-src]', '    if (this.built?.key !== key) {\n      this.built = { key, sender', '    if (true) {\n      this.built = { key, sender', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', "mail that can't be sent because settings did not load is dropped silently [013-src]", '      throw new EmailDeliveryError("Email not delivered: the server\'s email settings could not be loaded.", "other");', '      return;', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'the scanner never switches to new settings [013-src]', '    if (this.built?.key !== key) {\n      this.built = { key, scanner', '    if (!this.built) {\n      this.built = { key, scanner', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'a scan during a settings outage is recorded as "skipped" [013-src]', 'throw new ScannerUnavailableError("The malware scanner\'s settings could not be loaded just now.");', 'return "skipped";', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'the Google client never switches to new settings [013-src]', 'if (this.built?.key !== key) this.built =', 'if (!this.built) this.built =', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'a settings outage is reported as "Google not set up" [013-src]', '503, "OAUTH_UNAVAILABLE");', '503, "OAUTH_NOT_CONFIGURED");', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'a changed secret does not rebuild the connection [013-src]', 'const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null))', 'const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v && typeof v === "object" ? { ...(v as object), password: 0, clientSecret: 0 } : v ?? null))', ['tests/47-runtime-and-live-settings.test.ts']),
  ('src/settings/live.ts', 'changes made after startup are logged as startup [013-src]', '  if (startup) return out;\n  const tag', '  return out;\n  const tag', ['tests/47-runtime-and-live-settings.test.ts']),
  ('scripts/init-env.mjs', 'the session-signing secret is the same every time [013-src]', '`JWT_SECRET=${random(32)}`', '`JWT_SECRET=${"0".repeat(64)}`', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'the database passwords are the same as each other [013-src]', '`APP_DB_PASSWORD=${random(24)}`', '`APP_DB_PASSWORD=${"1".repeat(48)}`', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'the encryption key is left commented out [013-src]', '`SECRET_ENCRYPTION_KEY=${random(32)}`', '`# SECRET_ENCRYPTION_KEY=${random(32)}`', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'an existing .env is replaced [013-src]', 'if (existsSync(target)) {', 'if (false) {', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'the new .env can be read by other users [013-src]', 'mode: 0o600', 'mode: 0o644', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'the secrets are printed on screen [013-src]', 'io.log(`Created ${target}\\n`);', 'io.log(`Created ${target}\\n${text}`);', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'a public address with a login in it is accepted [013-src]', 'if (url.username || url.password || url.search || url.hash) throw', 'if (false) throw', ['tests/48-init-env-script.test.ts']),
  ('scripts/init-env.mjs', 'a missing line in .env.example is silently skipped [013-src]', 'if (!matches) throw new Error(', 'if (!matches) return text; throw new Error(', ['tests/48-init-env-script.test.ts']),
  ('src/services/users.ts', 'the wrong client is not noticed [assign-src]', 'if (tenant_id !== tenantId) throw', 'if (false) throw', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'a person who cannot do the work is not noticed [assign-src]', 'if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {', 'if (false) {', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'a switched-off account is not noticed [assign-src]', 'if (status === "disabled") throw', 'if (false) throw', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'a person who does not exist is not noticed [assign-src]', 'if (t.rowCount === 0) throw new AppError("That person was not found."', 'if (false) throw new AppError("That person was not found."', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'viewers count as people who can do the work [assign-src]', 'export const ASSIGNABLE_ROLES = ["contributor", "tenant_lead"] as const;', 'export const ASSIGNABLE_ROLES = ["contributor", "tenant_lead", "viewer"] as const;', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'single assign: the person is not checked [assign-src]', '    const { org_id, tenant_id } = ctl.rows[0];\n    await requireAssignable(c, targetUserId, tenant_id);\n    const r = await c.query(\n      "INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES', '    const { org_id, tenant_id } = ctl.rows[0];\n    const r = await c.query(\n      "INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'single assign: logged again when already assigned [assign-src]', 'if ((r.rowCount ?? 0) > 0) {\n      await logAudit(c, { orgId: org_id, tenantId: tenant_id, actorId: userId, action: "control.assigned", entity: "audit_control", entityId: controlId,', 'if (true) {\n      await logAudit(c, { orgId: org_id, tenantId: tenant_id, actorId: userId, action: "control.assigned", entity: "audit_control", entityId: controlId,', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'single assign: never logged [assign-src]', 'if ((r.rowCount ?? 0) > 0) {\n      await logAudit(c, { orgId: org_id, tenantId: tenant_id, actorId: userId, action: "control.assigned", entity: "audit_control", entityId: controlId,', 'if (false) {\n      await logAudit(c, { orgId: org_id, tenantId: tenant_id, actorId: userId, action: "control.assigned", entity: "audit_control", entityId: controlId,', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'single assign: logged under the wrong person [assign-src]', 'actorId: userId, action: "control.assigned", entity: "audit_control", entityId: controlId, change: { userId: targetUserId } });', 'actorId: targetUserId, action: "control.assigned", entity: "audit_control", entityId: controlId, change: { userId: targetUserId } });', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'single assign: log does not say who was assigned [assign-src]', 'action: "control.assigned", entity: "audit_control", entityId: controlId, change: { userId: targetUserId } });', 'action: "control.assigned", entity: "audit_control", entityId: controlId, change: { userId } });', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: duplicates are not removed [assign-src]', 'const ids = [...new Set(controlIds)];', 'const ids = controlIds;', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: an empty request is accepted [assign-src]', 'if (ids.length === 0) throw', 'if (false) throw', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: no upper limit [assign-src]', 'if (ids.length > MAX_BULK_ASSIGN) throw', 'if (false) throw', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: the limit is one too high [assign-src]', 'export const MAX_BULK_ASSIGN = 200;', 'export const MAX_BULK_ASSIGN = 201;', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: the limit is one too low [assign-src]', 'export const MAX_BULK_ASSIGN = 200;', 'export const MAX_BULK_ASSIGN = 199;', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: missing controls do not stop the request [assign-src]', 'if (found.rowCount !== ids.length) throw', 'if (false) throw', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: controls of other audits are accepted [assign-src]', '"SELECT org_id, tenant_id FROM audit_controls WHERE audit_id = $1 AND id = ANY($2::uuid[])", [auditId, ids]', '"SELECT org_id, tenant_id FROM audit_controls WHERE id = ANY($1::uuid[])", [ids]', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: the person is not checked [assign-src]', '    const { org_id, tenant_id } = found.rows[0]; // an audit belongs to one client, so they all share these\n    await requireAssignable(c, targetUserId, tenant_id);\n', '    const { org_id, tenant_id } = found.rows[0]; // an audit belongs to one client, so they all share these\n', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: already-assigned controls are counted again [assign-src]', 'return { assigned: r.rowCount ?? 0 };', 'return { assigned: ids.length };', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: every entry is logged against the same control [assign-src]', 'action: "control.assigned", entity: "audit_control", entityId: row.audit_control_id,', 'action: "control.assigned", entity: "audit_control", entityId: ids[0],', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: entries are not logged [assign-src]', '    for (const row of r.rows) {\n      await logAudit', '    for (const row of []) {\n      await logAudit', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'bulk: entries do not say who was assigned [assign-src]', 'entityId: row.audit_control_id, change: { userId: targetUserId } });', 'entityId: row.audit_control_id, change: { userId } });', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'list: the order is not by address [assign-src]', 'ORDER BY lower(u.email)`, [controlId]);', '`, [controlId]);', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'list: a control the caller cannot see gives an empty list [assign-src]', '    const ctl = await c.query("SELECT 1 FROM audit_controls WHERE id = $1", [controlId]);\n    if (ctl.rowCount === 0) throw', '    const ctl = await c.query("SELECT 1 FROM audit_controls WHERE id = $1", [controlId]);\n    if (false) throw', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'list: the name field shows the address [assign-src]', 'fullName: x.full_name, role: x.role }));', 'fullName: x.email, role: x.role }));', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'unassign: always says something was removed [assign-src]', 'return { removed: (r.rowCount ?? 0) > 0 };\n  }));\n}\n', 'return { removed: true };\n  }));\n}\n', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'unassign: logged even when nothing was removed [assign-src]', 'if ((r.rowCount ?? 0) > 0) {\n      await logAudit(c, { orgId: r.rows[0].org_id, tenantId: r.rows[0].tenant_id', 'if (true) {\n      await logAudit(c, { orgId: r.rows[0]?.org_id, tenantId: r.rows[0]?.tenant_id', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'unassign: never logged [assign-src]', 'if ((r.rowCount ?? 0) > 0) {\n      await logAudit(c, { orgId: r.rows[0].org_id, tenantId: r.rows[0].tenant_id', 'if (false) {\n      await logAudit(c, { orgId: r.rows[0].org_id, tenantId: r.rows[0].tenant_id', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'unassign: logged as an assignment [assign-src]', 'action: "control.unassigned"', 'action: "control.assigned"', ['tests/50-control-assignment.test.ts']),
  ('src/services/users.ts', 'unassign: log does not say who was removed [assign-src]', 'entityId: controlId, change: { userId: targetUserId } });\n    }\n    return { removed', 'entityId: controlId, change: { userId } });\n    }\n    return { removed', ['tests/50-control-assignment.test.ts']),
  ('src/http/routes/controls.ts', 'route: listing who a control is assigned to is missing [assign-src]', 'r.get("/controls/:id/assignments"', 'r.get("/controls/:id/assignment"', ['tests/50-control-assignment.test.ts']),
  ('src/http/routes/controls.ts', 'route: bulk assignment answers 200 instead of 201 [assign-src]', 'res.status(201).json(await users.assignControlsToUser(', 'res.json(await users.assignControlsToUser(', ['tests/50-control-assignment.test.ts']),
  ('src/http/routes/controls.ts', 'route: bulk assignment ignores the audit in the address [assign-src]', 'pid(req, "auditId"), b.userId, b.controlIds', 'pid(req, "id"), b.userId, b.controlIds', ['tests/50-control-assignment.test.ts']),
  ('src/http/routes/controls.ts', 'route: control ids are not checked to be ids [assign-src]', 'controlIds: z.array(z.string().uuid())', 'controlIds: z.array(z.string())', ['tests/50-control-assignment.test.ts']),
  ('src/http/routes/controls.ts', 'route: the person is not checked to be an id [assign-src]', 'const bulkAssignSchema = z.object({ userId: z.string().uuid(),', 'const bulkAssignSchema = z.object({ userId: z.string(),', ['tests/50-control-assignment.test.ts']),
  ('src/services/folderNames.ts', 'forbidden characters stay in folder names [cycle-src]', '.replace(/[\\\\/:*?"<>|\\u0000-\\u001f]/g, "-")\n', '\n', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'only some forbidden characters are replaced [cycle-src]', '/[\\\\/:*?"<>|\\u0000-\\u001f]/g', '/[\\\\/]/g', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'control characters stay in folder names [cycle-src]', '|\\u0000-\\u001f]/g', '|]/g', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'runs of spaces are kept [cycle-src]', '.replace(/\\s+/g, " ")\n', '\n', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'spaces at the ends are kept [cycle-src]', '    .trim()\n', '', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'long names are not shortened [cycle-src]', '.slice(0, 120)', '', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'names are shortened too much [cycle-src]', '.slice(0, 120)', '.slice(0, 100)', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'a trailing dot or space is kept [cycle-src]', '.replace(/[. ]+$/, "")', '', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'an empty name has no fallback [cycle-src]', '${cleaned || "Audit"}', '${cleaned}', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'the id code is left off [cycle-src]', 'return `${cleaned || "Audit"} [${code}]`;', 'return cleaned || "Audit";', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/folderNames.ts', 'the id code is too short [cycle-src]', 'auditId.slice(0, 8);', 'auditId.slice(0, 6);', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/evidence.ts', 'evidence goes into the client folder directly, not a cycle folder [cycle-src]', 'return storage.findOrCreateFolder(cycle.id, ctx.controlRef);', 'return storage.findOrCreateFolder(ctx.storageRootId!, ctx.controlRef);', ['tests/51-audit-cycle-folders.test.ts', 'tests/07-services.test.ts']),
  ('src/services/evidence.ts', 'cycle folders ignore the audit id [cycle-src]', 'auditFolderName(ctx.auditName, ctx.auditId)', 'ctx.auditName', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/evidence.ts', 'cycle folders are named after the wrong audit [cycle-src]', 'auditFolderName(ctx.auditName, ctx.auditId)', 'auditFolderName(ctx.auditName, ctx.id)', ['tests/51-audit-cycle-folders.test.ts']),
  ('src/services/evidence.ts', 'a flagged file is left in the evidence folder [quarantine-src]', 'const quarantined = await quarantine(storage, providerFileId);', 'const quarantined = false;', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'a flagged file is reported as moved even when it was not [quarantine-src]', '    return false;\n  }\n}\n\n/** The audit log', '    return true;\n  }\n}\n\n/** The audit log', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the message always claims the file was moved [quarantine-src]', '      quarantined\n        ? "This file was flagged', '      true\n        ? "This file was flagged', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the message never says the file was moved [quarantine-src]', '      quarantined\n        ? "This file was flagged', '      false\n        ? "This file was flagged', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the flagged upload is not written to the audit log [quarantine-src]', '    await recordInfected(pool, userId, controlId, meta.name, quarantined);\n', '', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the audit log entry has the wrong action [quarantine-src]', 'action: "evidence.infected"', 'action: "evidence.uploaded"', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the audit log entry names the wrong person [quarantine-src]', 'actorId: userId, action: "evidence.infected"', 'actorId: row.org_id, action: "evidence.infected"', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the audit log entry leaves out the file name [quarantine-src]', 'change: { fileName, quarantined } });', 'change: { quarantined } });', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the audit log entry leaves out whether it was quarantined [quarantine-src]', 'change: { fileName, quarantined } });', 'change: { fileName } });', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'the audit log entry always says it was quarantined [quarantine-src]', 'change: { fileName, quarantined } });', 'change: { fileName, quarantined: true } });', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', "the flagged file's name is written to the server log [quarantine-src]", 'console.error(e instanceof StorageError ? `[quarantine] could not move a flagged file to the trash (${e.code})` : "[quarantine] could not move a flagged file to the trash");', 'console.error(`[quarantine] could not move ${providerFileId} to the trash`, e);', ['tests/52-quarantine.test.ts']),
  ('src/services/evidence.ts', 'files that could not be scanned are refused and quarantined too [quarantine-src]', 'if (scanStatus === "infected") {\n    const quarantined', 'if (scanStatus !== "clean") {\n    const quarantined', ['tests/52-quarantine.test.ts']),
  ('src/storage/googleDrive.ts', 'quarantine does not trash the file [quarantine-src]', 'body: JSON.stringify({ trashed: true }),', 'body: JSON.stringify({ trashed: false }),', ['tests/52-quarantine.test.ts']),
  ('src/storage/googleDrive.ts', 'quarantine deletes the file for good [quarantine-src]', '      method: "PATCH",\n      headers: { "Content-Type": "application/json" },\n      body: JSON.stringify({ trashed: true }),', '      method: "DELETE",\n      headers: { "Content-Type": "application/json" },\n      body: JSON.stringify({ trashed: true }),', ['tests/52-quarantine.test.ts']),
  ('src/storage/googleDrive.ts', 'quarantine trashes a different file [quarantine-src]', 'await this.call(`/files/${encodeURIComponent(providerFileId)}?supportsAllDrives=true&fields=id`, {\n      method: "PATCH"', 'await this.call(`/files/${encodeURIComponent("x" + providerFileId)}?supportsAllDrives=true&fields=id`, {\n      method: "PATCH"', ['tests/52-quarantine.test.ts']),
  ('src/storage/lazyProvider.ts', 'the lazy provider does not pass quarantine on [quarantine-src]', 'async quarantineFile(providerFileId: string): Promise<void> { return (await this.provider()).quarantineFile(providerFileId); }', 'async quarantineFile(providerFileId: string): Promise<void> { return; }', ['tests/52-quarantine.test.ts']),
  ('scripts/verify.mjs', 'a failing library audit is never excused as "no internet" [verify-src]', '} else if (step.audit && OFFLINE.test(r.output)) {', '} else if (false) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'any failing step is excused as "no internet" [verify-src]', '} else if (step.audit && OFFLINE.test(r.output)) {', '} else if (OFFLINE.test(r.output)) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the exit code is always 0 [verify-src]', 'return failed.length === 0 ? 0 : 1;', 'return 0;', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the exit code is always 1 [verify-src]', 'return failed.length === 0 ? 0 : 1;', 'return 1;', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'an unknown option is ignored [verify-src]', 'else throw new UsageError(`Unknown option "${a}".\\n\\n${USAGE}`);', 'else continue;', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'an unknown option exits with 1 instead of 2 [verify-src]', '(ioOverride.error ?? ((t) => console.error(t)))(e.message); return 2;', '(ioOverride.error ?? ((t) => console.error(t)))(e.message); return 1;', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'libraries are reinstalled even when present [verify-src]', 'if (!io.installed(folder)) {', 'if (true) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'libraries are never installed [verify-src]', 'if (!io.installed(folder)) {', 'if (false) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'libraries are reinstalled for every step [verify-src]', '    installs.set(folder, failure);\n', '', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'a failed install does not fail the steps that need it [verify-src]', '    if (missing) {', '    if (false) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the audit is always included [verify-src]', 'if (opts.audit !== false) {', 'if (true) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the audit is never included [verify-src]', 'if (opts.audit !== false) {', 'if (false) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the deliberate-breakage checks always run [verify-src]', 'if (opts.mutation) {', 'if (true) {', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the audit also checks the test tools [verify-src]', 'npm audit --omit=dev --audit-level=high", needs: ".", audit: true', 'npm audit --audit-level=high", needs: ".", audit: true', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the audit ignores serious problems [verify-src]', 'npm audit --omit=dev --audit-level=high", needs: ".", audit: true', 'npm audit --omit=dev --audit-level=critical", needs: ".", audit: true', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the web app lint step is missing [verify-src]', '    front("code checks", "npm run lint"),\n', '', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the web app tests are not run [verify-src]', '    front("automated tests", "npx vitest run"),\n', '', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'the production build is not run [verify-src]', '    front("production build", "npm run build"),\n', '', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'later steps stop after a failure [verify-src]', '      io.log(`${label} … FAILED (${took})\\n${tail(r.output, 40)}`);\n      results.push({ title: step.title, status: "failed" });', '      io.log(`${label} … FAILED (${took})\\n${tail(r.output, 40)}`);\n      results.push({ title: step.title, status: "failed" });\n      break;', ['tests/53-verify-script.test.ts']),
  ('scripts/verify.mjs', 'a failing step shows none of its output [verify-src]', 'FAILED (${took})\\n${tail(r.output, 40)}`', 'FAILED (${took})`', ['tests/53-verify-script.test.ts']),
  # --- 014: closing an audit cycle ---
  ('src/errors.ts', 'a lock refusal is reported as a bad request [close-src]', 'AUDIT_CLOSED: 409,', 'AUDIT_CLOSED: 400,', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/errors.ts', 'closing twice is reported as a bad request [close-src]', 'AUDIT_ALREADY_CLOSED: 409,', 'AUDIT_ALREADY_CLOSED: 400,', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/errors.ts', 'reopening an open cycle is reported as a bad request [close-src]', 'AUDIT_NOT_CLOSED: 409,', 'AUDIT_NOT_CLOSED: 400,', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/errors.ts', 'an archived client is reported as a bad request [close-src]', 'TENANT_INACTIVE: 409,', 'TENANT_INACTIVE: 400,', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/errors.ts', 'a cycle that cannot be seen is reported as forbidden [close-src]', '  NOT_FOUND: 404,\n  AUDIT_CLOSED', '  NOT_FOUND: 403,\n  AUDIT_CLOSED', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'the closing time is never reported [close-src]', 'closedAt: (row.closed_at as Date | null) ?? null', 'closedAt: null', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'the closing person is never reported [close-src]', 'closedBy: (row.closed_by as string | null) ?? null', 'closedBy: null', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'the closing person is shown by address, even when they have a name [close-src]', "COALESCE(NULLIF(btrim(u.full_name), ''), u.email) AS closed_by", 'u.email AS closed_by', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'the closing person is blank when they have no name [close-src]', "COALESCE(NULLIF(btrim(u.full_name), ''), u.email) AS closed_by", 'u.full_name AS closed_by', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'a cycle that cannot be seen is reported as forbidden (service) [close-src]', '"Audit not found or not visible to you.", 404, "NOT_FOUND"', '"Audit not found or not visible to you.", 403, "NOT_FOUND"', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'a refused close is reported as a server error [close-src]', 'await c.query("SELECT audit_close($1)", [auditId]);\n      return await getAuditOn(c, auditId);\n    } catch (e) {\n      throw e instanceof AppError ? e : mapDbError(e);', 'await c.query("SELECT audit_close($1)", [auditId]);\n      return await getAuditOn(c, auditId);\n    } catch (e) {\n      throw e;', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'a refused reopen is reported as a server error [close-src]', 'await c.query("SELECT audit_reopen($1, $2)", [auditId, reason]);\n      return await getAuditOn(c, auditId);\n    } catch (e) {\n      throw e instanceof AppError ? e : mapDbError(e);', 'await c.query("SELECT audit_reopen($1, $2)", [auditId, reason]);\n      return await getAuditOn(c, auditId);\n    } catch (e) {\n      throw e;', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'reopening ignores the reason that was typed [close-src]', '"SELECT audit_reopen($1, $2)", [auditId, reason]', '"SELECT audit_reopen($1, $2)", [auditId, "Reopened"]', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'closing returns the cycle as it was before closing [close-src]', 'await c.query("SELECT audit_close($1)", [auditId]);\n      return await getAuditOn(c, auditId);', 'const before = await getAuditOn(c, auditId);\n      await c.query("SELECT audit_close($1)", [auditId]);\n      return before;', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/audits.ts', 'reopening returns the cycle as it was before reopening [close-src]', 'await c.query("SELECT audit_reopen($1, $2)", [auditId, reason]);\n      return await getAuditOn(c, auditId);', 'const before = await getAuditOn(c, auditId);\n      await c.query("SELECT audit_reopen($1, $2)", [auditId, reason]);\n      return before;', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/http/routes/controls.ts', 'reopening is sent without the reason [close-src]', 'pid(req, "auditId"), b.reason)', 'pid(req, "auditId"), "")', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/http/routes/controls.ts', 'closing is done by the reopen function [close-src]', 'audits.closeAudit(deps.pool, req.userId!, pid(req, "auditId"))', 'audits.reopenAudit(deps.pool, req.userId!, pid(req, "auditId"), "closing")', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'an upload session is opened on a closed cycle [close-src]', '  if (ctx.auditClosed) throw closedForEvidence(); // before any folder is created or upload session opened in the storage\n', '', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'a file is recorded on a closed cycle after the upload finished [close-src]', '  if (ctx.auditClosed) throw closedForEvidence(" The file you sent has not been recorded; it is still in your storage folder.");\n', '', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'a cycle is never seen as closed when uploading [close-src]', "(a.status = 'closed') AS audit_closed", 'false AS audit_closed', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'the upload refusal is a bad request [close-src]', 'admin can reopen it.`, 409, "AUDIT_CLOSED");', 'admin can reopen it.`, 400, "AUDIT_CLOSED");', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'the upload refusal has the wrong code [close-src]', 'organisation admin can reopen it.`, 409, "AUDIT_CLOSED");', 'organisation admin can reopen it.`, 409, "NOT_APPLICABLE");', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'the integrity check does not know the cycle is closed [close-src]', "SELECT status = 'closed' AS closed FROM audits WHERE id = $1", 'SELECT false AS closed FROM audits WHERE id = $1', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'a missing file in a closed cycle changes its control (flagging treats the cycle as open) [close-src]', '"missing", auditClosed);', '"missing", false);', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'a changed file in a closed cycle changes its control (flagging treats the cycle as open) [close-src]', '"modified", auditClosed);', '"modified", false);', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', "a closed cycle's control is moved back to review [close-src]", 'const r = auditClosed ? { rows: [] as', 'const r = false ? { rows: [] as', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'the flag on a closed cycle is not logged as such [close-src]', 'change: auditClosed ? { status, auditClosed: true } : { status },', 'change: { status },', ['tests/55-close-audit-cycle-http.test.ts']),
  ('src/services/evidence.ts', 'every flag is logged as being on a closed cycle [close-src]', 'change: auditClosed ? { status, auditClosed: true } : { status },', 'change: { status, auditClosed: true },', ['tests/55-close-audit-cycle-http.test.ts']),

  # --- the no-Docker launcher (scripts/local.mjs), the web server's Windows guards, and "am I the main file?" [launcher] ---
  ('scripts/local.mjs', 'the database address does not encode the password [launcher]', 'encodeURIComponent(password)', 'password', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the user name is not encoded in the address [launcher]', '`postgres://${encodeURIComponent(user)}:', '`postgres://${user}:', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a byte-order mark from Notepad spoils the first setting [launcher]', 'const line = raw.trim();', 'const line = raw.replace(/\\s+$/, "");', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a comment after a setting becomes part of the value [launcher]', 'value = value.replace(/\\s+#.*$/, "").trim();', 'value = value.trim();', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a quoted value keeps its opening quote [launcher]', 'value = end === -1 ? value.slice(1) : value.slice(1, end);', 'value = end === -1 ? value.slice(1) : value.slice(0, end);', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the real environment no longer wins over .env [launcher]', 'if (v !== undefined && v !== "" && k in fromFile) settings[k] = v;', 'if (false) settings[k] = v;', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a blank POSTGRES_PORT line breaks the port [launcher]', 'Number(settings.POSTGRES_PORT || 5432)', 'Number(settings.POSTGRES_PORT ?? 5432)', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the placeholders from .env.example are accepted [launcher]', 'const isPlaceholder = (v) => /^change-me/i.test(v);', 'const isPlaceholder = (v) => false;', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'an empty value is accepted [launcher]', 'if (v === undefined || v === "") out.push(`${n} has no value`);', 'if (v === undefined) out.push(`${n} has no value`);', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'libraries for another kind of computer are accepted [launcher]', 'if (have.includes(want)) add("ok"', 'if (have.length > 0) add("ok"', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'an old Node version is only a warning [launcher]', 'else add("fail", `Node.js ${nodeVersion} is too old`', 'else add("warn", `Node.js ${nodeVersion} is too old`', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a missing web app is not noticed [launcher]', 'else add("fail", "The built web app is missing (frontend/dist/index.html)"', 'else add("ok", "The built web app is missing (frontend/dist/index.html)"', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the wrong-password message prints the password [launcher]', 'for the user "${pg.adminUser}". POSTGRES_PASSWORD must be', 'for the user "${pg.adminUser}" (${pg.adminPassword}). POSTGRES_PASSWORD must be', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the wrong-password message does not say where to change it [launcher]', 'Open .env (type: notepad .env), change that line', 'Change that line', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'db: the control list is loaded before the tables exist [launcher]', 'for (const file of ["src/db/migrate-cli.ts", "src/db/seed-cli.ts"])', 'for (const file of ["src/db/seed-cli.ts", "src/db/migrate-cli.ts"])', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'db: carries on after a step failed [launcher]', 'if (code !== 0) { io.error(`Stopped: ${file} failed (exit code ${code}).`); return code || 1; }', 'if (code !== 0) { io.error(`Stopped: ${file} failed (exit code ${code}).`); }', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'db: tries to create a database that exists [launcher]', 'if (found.rowCount) { io.log(`Database "${DATABASE_NAME}" already exists.`); return true; }', 'if (false) { io.log(`Database "${DATABASE_NAME}" already exists.`); return true; }', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'db: runs from the wrong folder, so the migrations are not found [launcher]', 'deps.runNode(programArgs(deps.root, file), { cwd: deps.root,', 'deps.runNode(programArgs(deps.root, file), { cwd: deps.root + "/scripts",', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'db: the migration is not given the app role password [launcher]', 'const env = { ...settings, DATABASE_URL: adminUrl(pg) };', 'const env = { DATABASE_URL: adminUrl(pg) };', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'admin: the organisation name is replaced by the domain [launcher]', 'ORG_NAME: flags.org,', 'ORG_NAME: flags.domain,', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'admin: the email check is skipped [launcher]', 'if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(flags.email)) throw', 'if (false) throw', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'admin: a domain with an @ is accepted [launcher]', 'if (/[\\s@/]/.test(flags.domain)) throw', 'if (false) throw', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'admin: the exit code of the program is lost (always success) [launcher]', 'return runProgram(deps, "src/db/bootstrap-admin-cli.ts", { ...settings, DATABASE_URL: adminUrl(pg),', 'await runProgram(deps, "src/db/bootstrap-admin-cli.ts", { ...settings, DATABASE_URL: adminUrl(pg),', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'api: runs as the database owner instead of the restricted role [launcher]', 'return runProgram(deps, "src/server.ts", { ...settings, DATABASE_URL: appUrl(pg) });', 'return runProgram(deps, "src/server.ts", { ...settings, DATABASE_URL: adminUrl(pg) });', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'api: starts without checking that the restricted role can sign in [launcher]', 'try { probe = await deps.connectPg(appUrl(pg)); }', 'try { probe = undefined; }', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'api: the settings from .env are not passed on [launcher]', 'return runProgram(deps, "src/server.ts", { ...settings, DATABASE_URL: appUrl(pg) });', 'return runProgram(deps, "src/server.ts", { DATABASE_URL: appUrl(pg) });', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a program is started through a shell [launcher]', '{ cwd, env, stdio: "inherit", windowsHide: false }', '{ cwd, env, stdio: "inherit", shell: true }', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the exit code of a started program is lost [launcher]', 'child.on("exit", (code) => done(code ?? 1));', 'child.on("exit", () => done(0));', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'the launcher does nothing when started through a link or a folder with a space [launcher]', 'import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href', 'import.meta.url === `file://${process.argv[1]}`', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'check: the PostgreSQL login is not tried [launcher]', 'admin = await deps.connectPg(adminUrl(pg, "postgres"));\n      results.push', 'admin = { query: async () => ({ rowCount: 1 }), end: async () => {} };\n      results.push', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'check: a taken port is not reported [launcher]', "if (await deps.portIsFree(port)) results.push", "if (true) results.push", ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'a port is checked on one address only [launcher]', 'return (await tryListen(port, "127.0.0.1")) && (await tryListen(port, undefined));', 'return await tryListen(port, "127.0.0.1");', ['tests/58-local-launcher.test.ts']),
  ('src/isMainModule.ts', 'the main-file check ignores links [launcher]', 'pathToFileURL(realpathSync(argv1)).href', 'pathToFileURL(argv1).href', ['tests/58-local-launcher.test.ts']),
  ('src/isMainModule.ts', 'the main-file check is always true [launcher]', 'if (!argv1) return false;', 'if (!argv1) return true;', ['tests/58-local-launcher.test.ts']),
  ('src/isMainModule.ts', 'the main-file check compares text instead of addresses [launcher]', 'try { return moduleUrl === pathToFileURL(realpathSync(argv1)).href; }', 'try { return moduleUrl === `file://${realpathSync(argv1)}`; }', ['tests/58-local-launcher.test.ts']),
  ('src/server.ts', 'the server only starts when the path happens to match its address (silent on Windows) [launcher]', 'if (isMainModule(import.meta.url)) startServer();', 'if (import.meta.url === `file://${process.argv[1]}`) startServer();', ['tests/58-local-launcher.test.ts']),
  ('scripts/serve-web.mjs', 'the web server accepts Windows device names and streams [launcher]', 'if (isWindowsSpecialPath(path)) return reply(res, 404,', 'if (false) return reply(res, 404,', ['tests/56-serve-web.test.ts']),
  ('scripts/serve-web.mjs', 'a colon in a path is allowed [launcher]', 'part.includes(":") || ', '', ['tests/56-serve-web.test.ts']),
  ('scripts/serve-web.mjs', 'device names are only caught in lower case [launcher]', '(\\.|$)/i.test(part)', '(\\.|$)/.test(part)', ['tests/56-serve-web.test.ts']),
  ('scripts/serve-web.mjs', 'the device name com1 is not caught [launcher]', 'com[0-9]|lpt[0-9]', 'lpt[0-9]', ['tests/56-serve-web.test.ts']),
  ('scripts/serve-web.mjs', 'a name merely starting like a device name is refused [launcher]', '/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\.|$)/i', '/^(con|prn|aux|nul|com[0-9]|lpt[0-9])/i', ['tests/56-serve-web.test.ts']),
  ('scripts/serve-web.mjs', 'the web server does nothing when started through a link [launcher]', 'import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href', 'import.meta.url === pathToFileURL(process.argv[1]).href', ['tests/56-serve-web.test.ts']),

  # --- the one-window start [launcher] ---
  ('scripts/local.mjs', 'start: the API runs as the database owner instead of the restricted role [launcher]', 'DATABASE_URL: appUrl(pg) },\n    onLine: (line) => { if (/listening', 'DATABASE_URL: adminUrl(pg) },\n    onLine: (line) => { if (/listening', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: announces the portal as soon as one part is up [launcher]', 'announce = () => { if (apiReady && webReady) ok(); };', 'announce = () => { if (apiReady || webReady) ok(); };', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: the web server is given the secrets [launcher]', 'env: { ...deps.env, ...pick(["WEB_PORT", "WEB_HOST"]) },', 'env: { ...deps.env, ...settings },', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: only the API is stopped, the web app is left running [launcher]', 'stopped = true; api.stop(); web.stop(); };', 'stopped = true; api.stop(); };', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: an unexpected stop is reported as success [launcher]', 'return interrupted ? 0 : (ended.code || 1);', 'return 0;', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: a stop before readiness loses the exit code [launcher]', 'return outcome.code || 1;', 'return 1;', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: never looks for an existing administrator [launcher]', 'hasUsers = (await admin.query("SELECT 1 FROM users LIMIT 1")).rowCount > 0;', 'hasUsers = false;', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: carries on after the administrator could not be created [launcher]', 'if (created !== 0) { io.error(`Stopped: creating the administrator failed (exit code ${created}).`); return created || 1; }', 'if (created !== 0) { io.error(`Stopped: creating the administrator failed (exit code ${created}).`); }', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: does not check that the ports are free [launcher]', 'if (!(await deps.portIsFree(port))) {\n      io.error(`Port ${port} (needed by', 'if (false) {\n      io.error(`Port ${port} (needed by', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: ignores PORT and WEB_PORT [launcher]', 'const raw = settings[name] || deps.env[name] || String(fallback);', 'const raw = String(fallback);', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: does not prepare the database [launcher]', 'const prepared = await prepareDatabase(deps, io, pg, settings);', 'const prepared = 0;', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: Ctrl+C does not stop anything [launcher]', 'interrupted = true; stopAll(); });', '});', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: the sign-in link is not picked out of the output [launcher]', 'inviteLink ??= line.match(INVITE_LINK)?.[0];', '', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'start: the administrator step is run without details [launcher]', 'if (!wantsAdmin) {\n      io.error(\'There is no administrator yet.', 'if (false) {\n      io.error(\'There is no administrator yet.', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'launch: lines are not labelled [launcher]', 'const tag = label ? `[${label}] ` : "";', 'const tag = "";', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'launch: the CR of a Windows line end is kept [launcher]', 'emit(buffer.slice(0, i).replace(/\\r$/, ""));', 'emit(buffer.slice(0, i));', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'launch: a last line without a line end is lost [launcher]', 'stream.on("end", () => { if (buffer) emit(buffer.replace(/\\r$/, "")); buffer = ""; });', 'stream.on("end", () => { buffer = ""; });', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'launch: the program is given a keyboard that never closes [launcher]', 'stdio: ["ignore", "pipe", "pipe"]', 'stdio: ["pipe", "pipe", "pipe"]', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'launch: stop() does nothing [launcher]', 'stop: () => { try { child.kill(); } catch { /* already gone */ } }', 'stop: () => {}', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'launch: a program that cannot start is not reported [launcher]', 'child.on("error", (e) => { err.write(`${tag}Could not start: ${e.message}\\n`); ok(1); });', 'child.on("error", () => {});', ['tests/58-local-launcher.test.ts']),
  ('scripts/local.mjs', 'programs are started through tsx\'s two-process wrapper again [launcher]', 'export const programArgs = (root, file) => ["--import", pathToFileURL(tsxLoader(root)).href, join(root, file)];', 'export const programArgs = (root, file) => [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, file)];', ['tests/58-local-launcher.test.ts']),

  # --- Google's refusals explained [drive-refusal] ---
  ('src/storage/googleDrive.ts', 'a Google rate limit sent as 403 is reported as a permission problem [drive-refusal]', 'if (refusal.retryable) {', 'if (false) {', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'the Drive API being switched off is not recognised from the newer details block [drive-refusal]', 'has("accessNotConfigured", "SERVICE_DISABLED")', 'has("accessNotConfigured")', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'the Drive API being switched off is not recognised from the older error list [drive-refusal]', 'has("accessNotConfigured", "SERVICE_DISABLED")', 'has("SERVICE_DISABLED")', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', "the trailing full stop stays on Google's link [drive-refusal]", r'[^\s]*[^\s.,;)]/)?.[0]', r'[^\s]*/)?.[0]', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'a missing Drive permission is not recognised [drive-refusal]', 'has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientScopes")', 'has("nothing")', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'a full Drive is not recognised [drive-refusal]', 'has("storageQuotaExceeded")', 'has("nothing")', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'a withdrawn connection (401) is not recognised [drive-refusal]', 'if (status === 401 || has("authError", "invalid_grant")) {', 'if (false) {', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', "Google's own words are not shortened [drive-refusal]", 'googleMessage.slice(0, 240)', 'googleMessage', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'the body of the refusal is never read [drive-refusal]', 'explainDriveRefusal(res.status, await res.text().catch(() => ""))', 'explainDriveRefusal(res.status, "")', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'a repeated reason is listed twice [drive-refusal]', '!reasons.includes(reason)', 'true', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'sharingRateLimitExceeded is not waited out [drive-refusal]', 'new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded"])', 'new Set(["rateLimitExceeded", "userRateLimitExceeded"])', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'a refusal is retried although it is permanent [drive-refusal]', 'retryable: false, message: `${prefix}: the Google Drive API', 'retryable: true, message: `${prefix}: the Google Drive API', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'a reason found only in the details list is ignored [drive-refusal]', 'for (const list of [error.errors, error.details])', 'for (const list of [error.errors])', ["tests/05-storage-google-drive.test.ts"]),
  ('src/storage/googleDrive.ts', 'the message loses the plain prefix [drive-refusal]', 'const prefix = `Drive permission denied (${status})`;', 'const prefix = `Drive problem`;', ["tests/05-storage-google-drive.test.ts", "tests/26-storage-resolver-http.test.ts"]),
  # --- keeping evidence on this server's disk or in S3 [storage-options] ---
  ("src/storage/uploadTokens.ts", "an expired upload link still works [storage-options]", "if (p.e <= now) return null;", "", ["tests/62-upload-tokens.test.ts", "tests/63-local-storage-http.test.ts"]),
  ("src/storage/uploadTokens.ts", "an upload link's signature is not compared [storage-options]", "if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;", "", ["tests/62-upload-tokens.test.ts", "tests/63-local-storage-http.test.ts"]),
  ("src/storage/uploadTokens.ts", "upload links are signed with the plain server secret, so a session token could pass for one [storage-options]", 'const key = (secret: string) => createHmac("sha256", secret).update(LABEL).digest();', "const key = (secret: string) => Buffer.from(secret);", ["tests/62-upload-tokens.test.ts"]),
  ("src/storage/uploadTokens.ts", "an upload link for a zero-byte file is accepted [storage-options]", "!Number.isInteger(t.sizeBytes) || t.sizeBytes <= 0) return null;", "!Number.isInteger(t.sizeBytes)) return null;", ["tests/62-upload-tokens.test.ts"]),
  ("src/http/routes/uploads.ts", "the upload link is not checked [storage-options]", 'if (!payload) throw new AppError("This upload link has expired', 'if (false) throw new AppError("This upload link has expired', ["tests/63-local-storage-http.test.ts"]),
  ("src/http/routes/uploads.ts", "a file of another size than announced is accepted by the route [storage-options]", "if (Number(declared) !== payload.target.sizeBytes) throw", "if (false) throw", ["tests/63-local-storage-http.test.ts"]),
  ("src/http/routes/uploads.ts", "an upload that does not say its size is accepted [storage-options]", "if (declared === undefined || !/^\\d{1,12}$/.test(declared)) throw", "if (false) throw", ["tests/63-local-storage-http.test.ts"]),
  ("src/services/evidence.ts", "a file from another folder can be recorded as this control's evidence [storage-options]", "if (meta.folderId !== ctx.folderId) {", "if (false) {", ["tests/63-local-storage-http.test.ts", "tests/26-storage-resolver-http.test.ts"]),
  ("src/services/evidence.ts", "a file can be recorded before any upload was announced [storage-options]", 'if (!ctx.folderId) throw new AppError("No upload has been started', 'if (false) throw new AppError("No upload has been started', ["tests/63-local-storage-http.test.ts"]),
  ("src/services/evidence.ts", "downloads are not written to the audit log under their own name [storage-options]", 'action: "evidence.downloaded"', 'action: "evidence.viewed"', ["tests/63-local-storage-http.test.ts"]),
  ("src/services/evidence.ts", "a download is logged even when the file could not be opened [storage-options]", "  const opened = await withStorageErrors(() => open(row.provider_file_id));\n  try {", "  try { await withUser(pool, userId, (c) => logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: \"evidence.downloaded\", entity: \"evidence_file\", entityId: row.id })); } catch { /* ignored */ }\n  const opened = await withStorageErrors(() => open(row.provider_file_id));\n  try {", ["tests/63-local-storage-http.test.ts"]),
  ("src/http/routes/controls.ts", "a download is sent with the file's own type, which a browser may display or run [storage-options]", '    res.setHeader("Content-Type", "application/octet-stream");\n', "", ["tests/63-local-storage-http.test.ts"]),
  ("src/http/routes/controls.ts", "a download may be sniffed as another type [storage-options]", '    res.setHeader("X-Content-Type-Options", "nosniff");\n', "", ["tests/63-local-storage-http.test.ts"]),
  ("src/http/routes/controls.ts", "a download may be kept in shared caches [storage-options]", '    res.setHeader("Cache-Control", "no-store");\n', "", ["tests/63-local-storage-http.test.ts"]),
  ("src/http/contentDisposition.ts", "a download opens in the browser instead of being saved [storage-options]", "return `attachment; filename=", "return `inline; filename=", ["tests/63-local-storage-http.test.ts", "tests/65-storage-config-and-headers.test.ts"]),
  ("src/http/contentDisposition.ts", "a download name is put in the header unencoded [storage-options]", "const encoded = encodeURIComponent(fileName)", "const encoded = (fileName)", ["tests/65-storage-config-and-headers.test.ts"]),
  ("src/http/routes/controls.ts", "the browser's page address is passed to Drive even if it is a stranger's [storage-options]", "return own.has(header) ? header : undefined;", "return header;", ["tests/26-storage-resolver-http.test.ts"]),
  ("src/storage/resolver.ts", "a stored disk folder name is used without checking it [storage-options]", "return isSafeSegment(segment) ? path.join(baseDir, segment) : null;", "return path.join(baseDir, segment);", ["tests/63-local-storage-http.test.ts"]),
  ("src/storage/resolver.ts", "S3 connections ignore the owner's rule about private addresses [storage-options]", "createS3Client(cfg, { allowPrivate: deps.allowPrivateAddresses === true })", "createS3Client(cfg, { allowPrivate: true })", ["tests/64-s3-storage-http.test.ts"]),
  ("src/storage/resolver.ts", "stored S3 details are used without checking their shape [storage-options]", "cfg = parseS3Config(JSON.parse(deps.secretStore.decrypt(cred.out_token_ref as string)));", "cfg = JSON.parse(deps.secretStore.decrypt(cred.out_token_ref as string));", ["tests/64-s3-storage-http.test.ts"]),
  ("src/storage/resolver.ts", "names promised in one request are forgotten in the next (disk) [storage-options]", "makeUploadUrl, now: deps.now, reservations })", "makeUploadUrl, now: deps.now })", ["tests/63-local-storage-http.test.ts"]),
  ("src/storage/resolver.ts", "names promised in one request are forgotten in the next (S3) [storage-options]", "prefix: cfg.prefix, makeUploadUrl, now: deps.now, reservations })", "prefix: cfg.prefix, makeUploadUrl, now: deps.now })", ["tests/64-s3-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "anyone can choose where evidence is kept [storage-options]", 'if (role !== "org_admin") throw new AppError(`Only an org admin can ${what}.`, 403, "FORBIDDEN");', "", ["tests/63-local-storage-http.test.ts", "tests/64-s3-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "the organisation's disk folder follows a rename, so its files seem to vanish [storage-options]", "existing?.startsWith(LOCAL_REF_PREFIX) ? existing.slice(LOCAL_REF_PREFIX.length) : safeSegment", "false ? existing!.slice(LOCAL_REF_PREFIX.length) : safeSegment", ["tests/63-local-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "the disk folder is not tried out before it is saved [storage-options]", "try { await testLocalDirectory(folder); }", "try { void folder; }", ["tests/63-local-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "an S3 bucket is saved without being tried [storage-options]", "await testS3Connection(client, checked.bucket, checked.prefix);", "void client;", ["tests/64-s3-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "the S3 address is not checked when it is saved [storage-options]", "checked.endpoint = await checkEndpoint(cfg.endpoint, policy);", "checked.endpoint = cfg.endpoint;", ["tests/64-s3-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "the S3 access keys are stored in plain text [storage-options]", "secretStore.encrypt(JSON.stringify(verified))", "JSON.stringify(verified)", ["tests/64-s3-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "the S3 bucket can be changed after evidence exists [storage-options]", "if (previous && !sameLocation(previous, verified)) {", "if (false) {", ["tests/64-s3-storage-http.test.ts"]),
  ("src/services/storageSettings.ts", "a storage that was never connected can be chosen [storage-options]", 'if (!conn || conn.status !== "active") {', "if (false) {", ["tests/63-local-storage-http.test.ts", "tests/64-s3-storage-http.test.ts"]),
  ("src/http/routes/storage.ts", "the owner's rule about private addresses is ignored when testing or saving S3 [storage-options]", "allowPrivate: deps.storageOptions?.allowPrivateAddresses === true", "allowPrivate: true", ["tests/64-s3-storage-http.test.ts"]),
  ("src/errors.ts", "a locked storage choice is a plain 400 instead of a 409 [storage-options]", "  STORAGE_PROVIDER_LOCKED: 409,\n", "", ["tests/63-local-storage-http.test.ts"]),
  ("src/services/storageErrors.ts", "sending to a taken name is reported as a server fault [storage-options]", 'e.code === "ALREADY_EXISTS" ? 409 : ', "", ["tests/63-local-storage-http.test.ts"]),
  ("src/storage/localDisk.ts", "a link placed in the evidence folder leads out of it [storage-options]", "if (real !== base && !real.startsWith(base + path.sep)) throw", "if (false) throw", ["tests/60-local-disk-storage.test.ts"]),
  ("src/storage/localDisk.ts", "a file that is already there can be overwritten through an upload link [storage-options]", 'flags: "wx"', 'flags: "w"', ["tests/60-local-disk-storage.test.ts", "tests/63-local-storage-http.test.ts"]),
  ("src/storage/localDisk.ts", "a half-sent file is left on the disk [storage-options]", "if (!clash) await fsp.unlink(abs)", "if (false) await fsp.unlink(abs)", ["tests/60-local-disk-storage.test.ts", "tests/63-local-storage-http.test.ts"]),
  ("src/storage/localDisk.ts", "a file that was merely touched counts as changed [storage-options]", "version: hash, webUrl", "version: String(st.mtimeMs), webUrl", ["tests/60-local-disk-storage.test.ts", "tests/63-local-storage-http.test.ts"]),
  ("src/storage/safeNames.ts", "a name starting with a dot (hidden) is allowed [storage-options]", 's = s.replace(/^\\.+/, (dots) => "_".repeat(dots.length));', "", ["tests/60-local-disk-storage.test.ts"]),
  ("src/storage/safeNames.ts", "Windows device names (CON, NUL...) are allowed [storage-options]", "  if (WINDOWS_DEVICE.test(s)) s = `_${s}`;\n", "", ["tests/60-local-disk-storage.test.ts"]),
  ("src/storage/safeNames.ts", "a stored name with forbidden characters is trusted [storage-options]", "&& !FORBIDDEN_CHARS.test(s)", "", ["tests/60-local-disk-storage.test.ts"]),
  ("src/storage/safeNames.ts", "a stored name ending in a dot or space is trusted [storage-options]", "&& !/[. ]$/.test(s)", "", ["tests/60-local-disk-storage.test.ts"]),
  ("src/storage/safeNames.ts", "a stored name starting with a dot is trusted [storage-options]", '&& !s.startsWith(".")', "", ["tests/60-local-disk-storage.test.ts"]),
  ("src/storage/addressGuard.ts", "the cloud metadata address range is allowed [storage-options]", 'if (a === 169 && b === 254) return "never";', "", ["tests/61-s3-storage.test.ts", "tests/64-s3-storage-http.test.ts"]),
  ("src/storage/addressGuard.ts", "AWS's IPv6 metadata address is treated as an ordinary private address [storage-options]", 'if (g[0] === 0xfd00 && g[1] === 0x0ec2) return "never";', "", ["tests/61-s3-storage.test.ts", "tests/64-s3-storage-http.test.ts"]),
  ("src/storage/addressGuard.ts", "a name pointing to a private address is connected to [storage-options]", 'if (verdict === "never" || (verdict === "private" && !policy.allowPrivate)) return callback(', 'if (verdict === "never") return callback(', ["tests/61-s3-storage.test.ts"]),
  ("src/storage/addressGuard.ts", "an address typed as numbers skips the private-network rule [storage-options]", "if (net.isIP(host) === 0) return;\n  const verdict", "return;\n  const verdict", ["tests/61-s3-storage.test.ts"]),
  ("src/storage/addressGuard.ts", "a password inside the S3 address is accepted [storage-options]", "if (u.username || u.password) throw", "if (false) throw", ["tests/61-s3-storage.test.ts", "tests/64-s3-storage-http.test.ts"]),
  ("src/storage/s3.ts", "S3 clients skip the numeric-address check [storage-options]", "try { assertLiteralAllowed(cfg.endpoint, policy); }", "try { void policy; }", ["tests/61-s3-storage.test.ts"]),
  ("src/storage/s3.ts", "S3 connections use the plain name lookup, so rebinding gets through [storage-options]", "const lookup = guardedLookup(policy);", "const lookup = undefined as never;", ["tests/61-s3-storage.test.ts"]),
  ("src/storage/s3.ts", "S3 writes do not ask the service to refuse an existing object [storage-options]", '...(conditional ? { IfNoneMatch: "*" } : {}),', "", ["tests/61-s3-storage.test.ts"]),
  ("src/storage/s3.ts", "S3 objects are stored without their SHA-256 [storage-options]", "Metadata: { [SHA256_KEY]: sha256 },", "Metadata: {},", ["tests/61-s3-storage.test.ts"]),
  ("src/storage/s3.ts", "an S3 object can be replaced because the existence check is gone [storage-options]", "if (await this.objectExists(key)) throw taken();", "", ["tests/61-s3-storage.test.ts"]),
  ("src/config.ts", "LOCAL_STORAGE_DIR may contain '..' [storage-options]", 'if (dir.split(/[\\\\/]/).includes("..")) throw', "if (false) throw", ["tests/65-storage-config-and-headers.test.ts"]),
  ("src/config.ts", "LOCAL_STORAGE_DIR may be a relative path [storage-options]", "if (!isAbsolute) throw", "if (false) throw", ["tests/65-storage-config-and-headers.test.ts"]),
  ("src/config.ts", "LOCAL_STORAGE_DIR may be the top of a drive [storage-options]", "if (path.parse(dir).root === dir || path.win32.parse(dir).root === dir) throw", "if (false) throw", ["tests/65-storage-config-and-headers.test.ts"]),
  ("scripts/local.mjs", "the default evidence folder is inside the portal's folder, which a new version replaces [storage-options]", 'join(deps.home ?? os.homedir(), "EvidencePortal", "files")', 'join(deps.root, "evidence-files")', ["tests/58-local-launcher.test.ts"]),
]

PROJECT_ITEMS = ["src", "tests", "db", "scripts", ".github", "package.json", "tsconfig.json", "vitest.config.ts", ".env.example", "docker-compose.yml", "Dockerfile", "README.md", "start-portal.cmd", ".gitattributes"]

# A breakage is caught the moment ANY test fails, so a mutated run can stop at the first failure instead of finishing
# the whole suite. (A breakage that survives still runs everything: nothing fails, so nothing stops it.) The baseline
# run, which must pass in full, never uses this. Set MUTATION_NO_BAIL=1 to run every test regardless.
# A mutated run that takes longer than this is reported as a timeout and counted as caught (a breakage that makes the
# suite hang is noticed by whoever runs it). The whole suite takes several minutes on a slow machine, so the limit is
# generous; set MUTATION_TIMEOUT (seconds) to change it.
RUN_TIMEOUT = int(os.environ.get("MUTATION_TIMEOUT", "900"))

def bail_args(_tests):
    return [] if os.environ.get("MUTATION_NO_BAIL") else ["--bail=1"]

def tests_ran(out):
    """True only if vitest got as far as running tests and printed their tally. A setup that never started
    (the test database could not be created, an import crashed) is NOT a detected breakage."""
    return re.search(r"Tests\s+.*\d+\s+(passed|failed)", out) is not None

def failed_count(out):
    m = re.search(r"Tests\s+(\d+) failed", out)
    return int(m.group(1)) if m else 0

def run_in_copy(target_file, new_content, tests):
    """Runs `tests` in a throwaway COPY of the project, with target_file replaced by new_content (or untouched
    if None). The real tree is never touched. Returns vitest's cleaned-up output."""
    # Not under /tmp/claude-0 and world-traversable: the test database runs as another user and must be able to
    # reach node_modules/.../initdb through this directory.
    # (Only the build sandbox has /home/claude; anywhere else the normal temp folder is used.)
    d = tempfile.mkdtemp(prefix="mutation-", dir="/home/claude" if os.path.isdir("/home/claude") else None)
    os.chmod(d, 0o755)
    try:
        for item in PROJECT_ITEMS:
            if os.path.isdir(item): shutil.copytree(item, os.path.join(d, item))
            elif os.path.exists(item): shutil.copy(item, os.path.join(d, item))
        os.symlink(os.path.abspath("node_modules"), os.path.join(d, "node_modules"))
        if new_content is not None:
            open(os.path.join(d, target_file), "w").write(new_content)
        try:
            r = subprocess.run(["npx", "vitest", "run", *bail_args(tests), *tests], cwd=d, capture_output=True, text=True, timeout=RUN_TIMEOUT)
        except subprocess.TimeoutExpired:
            return "TIMEOUT"
        return re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr) + f"\n[exit {r.returncode}]"
    finally:
        shutil.rmtree(d, ignore_errors=True)

def baseline_ok(tests):
    out = run_in_copy("", None, tests)
    if out == "TIMEOUT" or not tests_ran(out) or failed_count(out) or "[exit 0]" not in out:
        print(f"BASELINE FAILED for {tests}: the UNMODIFIED copy does not pass, so no result here can be trusted.\n" + out[-1500:])
        return False
    return True

def run_source_one(target_file, name, old, new, tests):
    base = open(target_file).read()
    if old not in base:
        print(f"SKIP (pattern not found): [{target_file}] {name}")
        return None
    out = run_in_copy(target_file, base.replace(old, new, 1), tests)
    if out == "TIMEOUT":
        print(f"TIMEOUT (treated as caught: mutation hung the tests)  [{target_file}] {name}")
        return True
    if not tests_ran(out):
        print(f"BROKEN RUN (tests never ran, so this proves nothing)  [{target_file}] {name}\n" + out[-600:])
        return False
    failed = failed_count(out)
    ok = failed > 0 or ("Unhandled" in out and "[exit 0]" not in out)
    print(f"{'CAUGHT   (%2d tests failed)' % failed if ok else 'SURVIVED                  '}  [{target_file}] {name}")
    return ok

def run_one(target_file, name, old, new, only_tests=()):
    base = open(os.path.join(MIGRATIONS_DIR, target_file)).read()
    if old not in base:
        print(f"SKIP (pattern not found): [{target_file}] {name}")
        return None
    d = tempfile.mkdtemp()
    for f in ALL_MIGRATIONS:
        shutil.copy(os.path.join(MIGRATIONS_DIR, f), os.path.join(d, f))
    open(os.path.join(d, target_file), "w").write(base.replace(old, new, 1))
    try:
        r = subprocess.run(["npx", "vitest", "run", *bail_args(only_tests), *only_tests], env={**os.environ, "MIGRATIONS_DIR": d},
                            capture_output=True, text=True, timeout=RUN_TIMEOUT)
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT (treated as caught: mutation hung the suite)  [{target_file}] {name}")
        shutil.rmtree(d)
        return True
    out = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr)
    shutil.rmtree(d)
    if not tests_ran(out):
        print(f"BROKEN RUN (tests never ran, so this proves nothing)  [{target_file}] {name}\n" + out[-600:])
        return False
    failed = failed_count(out)
    ok = r.returncode != 0 and failed > 0
    print(f"{'CAUGHT   (%2d tests failed)' % failed if ok else 'SURVIVED                  '}  [{target_file}] {name}")
    return ok

def main():
    # Optional: `python3 scripts/mutation-check.py expired state` re-runs only the breakages whose
    # file name or description contains that text — handy after adding a test for one specific rule.
    # Optional: `--tests=tests/38-mfa-db.test.ts` runs only those test files for each database breakage (quick,
    # for development; a breakage that survives a targeted run must be re-run against the full suite).
    args = sys.argv[1:]
    only_tests = tuple(t for a in args if a.startswith("--tests=") for t in a[len("--tests="):].split(",") if t)
    # Optional: `--exclude=text` leaves out the breakages mentioning that text (e.g. ones already re-checked against
    # code that has not changed since).
    excluded = [a[len("--exclude="):].lower() for a in args if a.startswith("--exclude=")]
    needle = " ".join(a for a in args if not a.startswith("--tests=") and not a.startswith("--exclude=")).lower()
    keep = lambda m: (not needle or needle in f"{m[0]} {m[1]}".lower()) and not any(x and x in f"{m[0]} {m[1]}".lower() for x in excluded)
    chosen = [m for m in MUTATIONS if keep(m)]
    chosen_src = [m for m in SOURCE_MUTATIONS if keep(m)]
    if not chosen and not chosen_src:
        print(f"No breakage matches {needle!r}"); sys.exit(2)
    caught = 0; missed = []
    for target_file, name, old, new in chosen:
        r = run_one(target_file, name, old, new, only_tests)
        if r is None:
            missed.append(f"[{target_file}] {name} [pattern missing]")
        elif r:
            caught += 1
        else:
            missed.append(f"[{target_file}] {name}")
    if chosen_src:
        for tests in sorted({tuple(m[4]) for m in chosen_src}):
            if not baseline_ok(list(tests)): sys.exit(3)
        print("baseline: the unmodified project copy passes these tests, so a failure below is caused by the breakage.\n")
    for target_file, name, old, new, tests in chosen_src:
        r = run_source_one(target_file, name, old, new, tests)
        if r is None:
            missed.append(f"[{target_file}] {name} [pattern missing]")
        elif r:
            caught += 1
        else:
            missed.append(f"[{target_file}] {name}")
    total = len(chosen) + len(chosen_src)
    print(f"\n{caught} of {total} deliberate breakages were caught by the test suite")
    if missed:
        print("Not caught:", *missed, sep="\n  - ")
        sys.exit(1)

main()
