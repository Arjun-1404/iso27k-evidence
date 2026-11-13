-- Evidence Portal: remove licensing (stage 5, open-source pivot)
-- This project is now open source and self-hosted rather than sold under a per-tenant/per-user cap.
-- Multi-tenancy itself stays (one self-hosted instance can still serve several client tenants) — only
-- the licence CAP ENFORCEMENT and the licences table go away. Additive migration, per project
-- convention: 001 and 002 are never edited after being applied.

DROP TRIGGER tenants_licence ON tenants;
DROP TRIGGER users_licence ON users;
DROP FUNCTION enforce_licence();

-- Two dependencies run in opposite directions, so each has to be broken explicitly before the other:
-- licences_select's USING clause reads orgs.licence_id (policy depends on the column), and
-- orgs.licence_id's foreign key references licences (the column depends on the table).
DROP POLICY licences_select ON licences;
ALTER TABLE orgs DROP COLUMN licence_id;   -- also drops the now-pointless FK constraint on this column
DROP TABLE licences;
