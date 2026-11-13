-- Evidence Portal: only people who can actually do the work can be given a control.
--
-- Until now the database only required that the person being assigned belongs to the same client. A read-only
-- viewer, a dashboard-only user or someone whose account was switched off could be handed a control: harmless
-- (they can't act on it) but misleading, because the screen would show work waiting on someone who can never do it.
-- The web app only ever offers the right people, but the rule belongs where it can't be skipped.
--
-- The rule: the person must be a contributor or a client lead, and not disabled ("invited" is allowed, so a
-- control can be lined up for someone who has been invited but hasn't signed in yet).
--
-- Existing assignments are left alone. This only changes who can be assigned from now on.

DROP POLICY control_assignments_insert ON control_assignments;
CREATE POLICY control_assignments_insert ON control_assignments FOR INSERT TO portal_app
  WITH CHECK (org_id = (SELECT app_org()) AND tenant_active(tenant_id) AND (SELECT app_role()) IN ('org_admin', 'lead_auditor', 'tenant_lead')
              AND EXISTS (SELECT 1 FROM users u
                          WHERE u.id = user_id
                            AND u.tenant_id = control_assignments.tenant_id
                            AND u.role IN ('contributor', 'tenant_lead')
                            AND u.status <> 'disabled'));
