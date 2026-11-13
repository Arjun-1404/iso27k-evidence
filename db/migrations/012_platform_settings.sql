-- Evidence Portal: server settings that can be changed from the web app (stage 13)
--
-- Until now the mail server, the malware scanner and the Google "app" credentials could only be set in the server's
-- environment (.env). This lets the owner of an installation enter them in the web app instead, and keeps the same
-- discipline as 008, 010 and 011: nothing here loosens a row-level-security policy, and the new data is reachable only
-- through narrow SECURITY DEFINER functions.
--
-- What the database enforces, so no application bug can weaken it:
--   * there is an "owner" of the installation (users.is_platform_owner). The application's own role cannot read, set or
--     change that flag (users has column-limited privileges since 009 and this column is in none of them): it is set by
--     whoever controls the server (the migration, the bootstrap script, the grant-platform-owner script). Being the
--     owner also requires being an active organisation admin;
--   * the settings table has no privileges for the application's role at all. The owner reads and changes settings
--     only through platform_settings_read / platform_setting_save / platform_setting_clear, each of which checks that
--     the SIGNED-IN person (taken from the session, never a parameter) is the owner;
--   * secrets (the mail password, the Google client secret) arrive already encrypted by the application with the
--     server's SECRET_ENCRYPTION_KEY. The database keeps only ciphertext, and the one function the running server uses
--     (platform_settings_load) returns ciphertext only. The owner's read function returns no ciphertext at all, just
--     which secrets are set;
--   * every save and every removal is written to the tamper-evident audit log, naming the FIELDS that changed and
--     never a value;
--   * only the three known groups exist (email, scanner, google), each may hold only its own secret names, and the
--     ciphertext is present exactly when a secret is.

ALTER TABLE users ADD COLUMN is_platform_owner boolean NOT NULL DEFAULT false;

-- An installation that already has people in it: its first administrator becomes the owner, so nobody is locked out of
-- the new settings page. (A fresh installation has no users yet; the bootstrap script sets the flag on the first admin.)
UPDATE users SET is_platform_owner = true
WHERE id = (SELECT u.id FROM users u WHERE u.role = 'org_admin' AND u.status IN ('active', 'invited') ORDER BY u.created_at, u.id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_owner);

CREATE TABLE platform_settings (
  key         text PRIMARY KEY CHECK (key IN ('email', 'scanner', 'google')),
  config      jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND length(config::text) <= 4000),
  secret_enc  text CHECK (secret_enc IS NULL OR length(secret_enc) <= 8000),
  secrets_set text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Ciphertext exactly when a secret is set; and only the secrets that group is allowed to have.
  CONSTRAINT platform_settings_secrets_consistent CHECK ((secret_enc IS NOT NULL) = (cardinality(secrets_set) > 0)),
  CONSTRAINT platform_settings_secret_names CHECK (
    (key = 'email'   AND secrets_set <@ ARRAY['password']) OR
    (key = 'google'  AND secrets_set <@ ARRAY['clientSecret']) OR
    (key = 'scanner' AND cardinality(secrets_set) = 0))
);
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
-- (No policies and no grants: the application's role can reach this table only through the functions below.)

-- ---- who is the owner -----------------------------------------------------------------------------------------------

CREATE FUNCTION platform_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = ctx_user_id() AND status = 'active' AND role = 'org_admin' AND is_platform_owner)
$$;

-- ---- what the running server needs ----------------------------------------------------------------------------------

-- The settings in effect, for building the mail sender, the scanner and the Google client. Needs no signed-in person
-- (a forgotten-password request has none). It returns ciphertext only; the key that opens it lives in the server's
-- environment, never here.
CREATE FUNCTION platform_settings_load() RETURNS TABLE (out_key text, out_config jsonb, out_secret_enc text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT key, config, secret_enc FROM platform_settings
$$;

-- ---- what the owner's settings page needs ---------------------------------------------------------------------------

-- No ciphertext here: only which secrets are set, when it was last saved and by whom (an address, for the page to show).
CREATE FUNCTION platform_settings_read() RETURNS TABLE (out_key text, out_config jsonb, out_secrets_set text[], out_updated_at timestamptz, out_updated_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF NOT platform_is_owner() THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only the owner of this installation can see or change the server settings.' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    SELECT s.key, s.config, s.secrets_set, s.updated_at, u.email
    FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by
    ORDER BY s.key;
END
$$;

-- p_changed is the list of FIELD NAMES the owner changed, for the audit log. It is never a value.
CREATE FUNCTION platform_setting_save(p_key text, p_config jsonb, p_secret_enc text, p_secrets_set text[], p_changed text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_actor uuid := ctx_user_id(); v_org uuid; v_name text;
BEGIN
  IF NOT platform_is_owner() THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only the owner of this installation can see or change the server settings.' USING ERRCODE = 'P0001';
  END IF;
  IF p_key IS NULL OR p_key NOT IN ('email', 'scanner', 'google') THEN
    RAISE EXCEPTION 'VALIDATION: Unknown settings group.' USING ERRCODE = 'P0001';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'VALIDATION: The settings must be an object.' USING ERRCODE = 'P0001';
  END IF;
  p_secrets_set := coalesce(p_secrets_set, '{}');
  IF (p_secret_enc IS NOT NULL) <> (cardinality(p_secrets_set) > 0) THEN
    RAISE EXCEPTION 'VALIDATION: Encrypted secrets must be sent exactly when a secret is set.' USING ERRCODE = 'P0001';
  END IF;
  p_changed := coalesce(p_changed, '{}');
  IF cardinality(p_changed) > 20 THEN
    RAISE EXCEPTION 'VALIDATION: Too many changed fields.' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY p_changed LOOP
    IF v_name IS NULL OR v_name !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' THEN
      RAISE EXCEPTION 'VALIDATION: A changed-field name is not valid.' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT org_id INTO v_org FROM users WHERE id = v_actor;
  INSERT INTO platform_settings (key, config, secret_enc, secrets_set, updated_at, updated_by)
  VALUES (p_key, p_config, p_secret_enc, p_secrets_set, now(), v_actor)
  ON CONFLICT (key) DO UPDATE
    SET config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, secrets_set = EXCLUDED.secrets_set,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_actor, 'platform.setting_saved', 'platform_setting', p_key, jsonb_build_object('fields', to_jsonb(p_changed)));
END
$$;

-- Removing a group puts it back to "not set up here" (or to whatever the server's environment says).
CREATE FUNCTION platform_setting_clear(p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE v_actor uuid := ctx_user_id(); v_org uuid;
BEGIN
  IF NOT platform_is_owner() THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Only the owner of this installation can see or change the server settings.' USING ERRCODE = 'P0001';
  END IF;
  IF p_key IS NULL OR p_key NOT IN ('email', 'scanner', 'google') THEN
    RAISE EXCEPTION 'VALIDATION: Unknown settings group.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM platform_settings WHERE key = p_key;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT org_id INTO v_org FROM users WHERE id = v_actor;
  INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, change)
  VALUES (v_org, v_actor, 'platform.setting_cleared', 'platform_setting', p_key, '{}'::jsonb);
  RETURN true;
END
$$;

GRANT EXECUTE ON FUNCTION platform_is_owner() TO portal_app;
GRANT EXECUTE ON FUNCTION platform_settings_load() TO portal_app;
GRANT EXECUTE ON FUNCTION platform_settings_read() TO portal_app;
GRANT EXECUTE ON FUNCTION platform_setting_save(text, jsonb, text, text[], text[]) TO portal_app;
GRANT EXECUTE ON FUNCTION platform_setting_clear(text) TO portal_app;
