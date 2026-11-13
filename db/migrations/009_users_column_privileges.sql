-- Evidence Portal: stop the application's database role reading or writing the secret columns of `users`.
--
-- Since stage 5 the app role has been able to read EVERY column of every user row it is allowed to see by
-- row-level security — including password_hash and invite_token_hash — and (through its table-wide INSERT
-- grant) to set them on a new row. No HTTP route returns or sets those columns, so nothing was exploitable
-- through the API, but the whole design rests on the database refusing what the application must never do, so
-- that a future bug (an injection, a careless SELECT *) cannot weaken it. 004 narrowed UPDATE; this narrows
-- SELECT and INSERT the same way.
--
-- After this migration the app role works with the ordinary profile columns only. Everything that needs a
-- secret column (login, invite acceptance, password reset, session checks, and the multi-factor functions that
-- follow) goes through the narrow SECURITY DEFINER functions, which run as the table's owner and are
-- unaffected.

REVOKE SELECT ON users FROM portal_app;
GRANT SELECT (id, org_id, tenant_id, email, full_name, role, status, created_at) ON users TO portal_app;

REVOKE INSERT ON users FROM portal_app;
GRANT INSERT (org_id, tenant_id, email, full_name, role, status, invite_token_hash, invite_token_expires_at) ON users TO portal_app;
-- (UPDATE has been column-limited since 004: email, full_name, role, status, invite_token_hash, invite_token_expires_at.)
