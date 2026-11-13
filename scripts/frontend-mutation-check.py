#!/usr/bin/env python3
"""
Frontend counterpart of mutation-check.py: deliberately breaks one behaviour at a time in a throwaway COPY of the
frontend and confirms the tests notice. A breakage counts as caught only if the tests actually ran and at least one
failed — a run that never started (a crash, a missing file) is reported as broken, never as a success.

  python3 scripts/frontend-mutation-check.py            # every breakage
  python3 scripts/frontend-mutation-check.py QrCode     # only those whose file or description mentions the text

Run it after changing anything security-relevant in the frontend. Don't run it alongside the normal tests.
"""
import os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
ITEMS = ["src", "index.html", "package.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "vite.config.ts"]

QR = ["src/components/QrCode.test.tsx"]
CLIENT = ["src/auth/builtInAuthClient.twoStep.test.ts", "src/auth/builtInAuthClient.test.ts"]
LOGIN = ["src/pages/LoginPage.twoStep.test.tsx", "src/pages/LoginPage.test.tsx"]
SEC = ["src/pages/SecurityPage.test.tsx"]
USERS = ["src/pages/TenantsUsersPage.twoStep.test.tsx", "src/pages/TenantsUsersPage.test.tsx"]
API = ["src/api/client.twoStep.test.ts"]
NAV = ["src/components/AppShell.test.tsx", "src/App.test.tsx"]
SEC2 = ["src/pages/SecurityPage.password.test.tsx"]
POL = ["src/pages/SecurityPage.policy.test.tsx"]
APPPOL = ["src/App.mfaPolicy.test.tsx"]
APISEC = ["src/api/client.security.test.ts"]
CLISEC = ["src/auth/builtInAuthClient.security.test.ts"]
INT = ["src/pages/IntegrationsPage.test.tsx"]
CL = ["src/api/client.storage.test.ts"]
DR = ["src/components/ControlDetailDrawer.test.tsx"]
SB = ["src/components/saveBlob.test.ts"]

MUTATIONS = [
  # file, name, old, new, tests that must fail
  ("src/components/QrCode.tsx", "no blank border around the QR code", "export const QUIET_ZONE = 4;", "export const QUIET_ZONE = 0;", QR),
  ("src/components/QrCode.tsx", "the QR code is drawn inverted", "if (qr.isDark(r, c))", "if (!qr.isDark(r, c))", QR),
  ("src/components/QrCode.tsx", "the QR code encodes nothing useful", "qr.addData(value);", 'qr.addData("x");', QR),
  ("src/components/QrCode.tsx", "an unencodable value crashes the page", "    } catch {\n      return null;\n    }", "    } finally {\n    }", QR),
  ("src/components/QrCode.tsx", "the QR code is unlabelled", 'role="img" aria-label={label}', "", QR),

  ("src/auth/builtInAuthClient.ts", "the password step signs the person in without the code", "    if (data.mfaRequired) {\n      this.pending = { mfaToken: data.mfaToken, email };\n      return \"mfa-required\";\n    }\n", "", CLIENT),
  ("src/auth/builtInAuthClient.ts", "the half-finished sign-in is saved to storage", "      this.pending = { mfaToken: data.mfaToken, email };\n", "      this.pending = { mfaToken: data.mfaToken, email };\n      localStorage.setItem('evidence-portal-pending', data.mfaToken);\n", CLIENT),
  ("src/auth/builtInAuthClient.ts", "an expired sign-in can be retried forever", 'if (e instanceof ApiError && e.code === "INVALID_MFA_TOKEN") this.pending = null;', "", CLIENT),
  ("src/auth/builtInAuthClient.ts", "a used-up sign-in can be used again", "      this.startSession(await this.post(\"/auth/mfa/verify\", { mfaToken, code }), email);\n      this.pending = null;", "      this.startSession(await this.post(\"/auth/mfa/verify\", { mfaToken, code }), email);", CLIENT),
  ("src/auth/builtInAuthClient.ts", "going back keeps the half-finished sign-in", "  cancelMfa(): void {\n    this.pending = null;\n  }", "  cancelMfa(): void {\n  }", CLIENT),
  ("src/auth/builtInAuthClient.ts", "a new sign-in keeps the old challenge", "    this.pending = null;\n    const data = await this.post(\"/auth/login\"", "    const data = await this.post(\"/auth/login\"", CLIENT),
  ("src/auth/builtInAuthClient.ts", "signing out keeps the half-finished sign-in", "  logout(): void {\n    this.pending = null;", "  logout(): void {", CLIENT),
  ("src/auth/builtInAuthClient.ts", "the code step sends the wrong challenge", "{ mfaToken, code }", '{ mfaToken: "x", code }', CLIENT),

  ("src/pages/LoginPage.tsx", "the password stays in the page after the first step", '        setPassword(""); // not needed again, and not worth keeping around in the page\n', "", LOGIN),
  ("src/pages/LoginPage.tsx", "an expired sign-in leaves the person stranded on the code step", 'if (e instanceof ApiError && e.code === "INVALID_MFA_TOKEN") {', "if (false) {", LOGIN),
  ("src/pages/LoginPage.tsx", "switching to a recovery code keeps the half-typed code", '<button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}', '<button type="button" onClick={() => { setUseRecovery(!useRecovery); setError(null); }}', LOGIN),
  ("src/pages/LoginPage.tsx", "the code is sent untrimmed", "await completeMfa(code.trim());", "await completeMfa(code);", LOGIN),
  ("src/pages/LoginPage.tsx", "a correct code does not finish signing in", "      await completeMfa(code.trim());\n      navigate(\"/\");", "      await completeMfa(code.trim());", LOGIN),
  ("src/pages/LoginPage.tsx", "Back keeps the old error", "    cancelMfa();\n    setCode(\"\");\n    setError(null);", "    cancelMfa();\n    setCode(\"\");", LOGIN),
  ("src/pages/LoginPage.tsx", "an account with two-step on goes straight home", 'if (outcome === "mfa-required") {', 'if (false) {', LOGIN),

  ("src/pages/SecurityPage.tsx", "recovery codes can be dismissed without saying they are saved", "disabled={!saved} onClick={finishRecoveryCodes}", "onClick={finishRecoveryCodes}", SEC),
  ("src/pages/SecurityPage.tsx", "the low-codes warning never appears", "const LOW_RECOVERY_CODES = 3;", "const LOW_RECOVERY_CODES = -1;", SEC),
  ("src/pages/SecurityPage.tsx", "the low-codes warning appears too early", "const LOW_RECOVERY_CODES = 3;", "const LOW_RECOVERY_CODES = 5;", SEC),
  ("src/pages/SecurityPage.tsx", "the first code is sent untrimmed", "api.confirmMfaEnrollment(code.trim())", "api.confirmMfaEnrollment(code)", SEC),
  ("src/pages/SecurityPage.tsx", "turning off sends no code", "api.disableMfa(password, code.trim())", 'api.disableMfa(password, "")', SEC),
  ("src/pages/SecurityPage.tsx", "new recovery codes are requested with the wrong proof", "api.regenerateRecoveryCodes(password, code.trim())", "api.regenerateRecoveryCodes(code.trim(), password)", SEC),
  ("src/pages/SecurityPage.tsx", "a server without a key is offered the setup button", "{status && !status.available && (", "{status && false && (", SEC),
  ("src/pages/SecurityPage.tsx", "copied codes are not one per line", '(recoveryCodes ?? []).join("\\n")', '(recoveryCodes ?? []).join(",")', SEC),
  ("src/pages/SecurityPage.tsx", "the setup key is shown ungrouped", 'secret.replace(/(.{4})/g, "$1 ").trim()', "secret", SEC),
  ("src/pages/SecurityPage.tsx", "the QR code is not shown", "<QrCode value={enrollment.otpauthUri}", "<QrCode value={''}", SEC),
  ("src/pages/SecurityPage.tsx", "turning it off does not ask for the password", "disabled={busy || !password || !code.trim()}", "disabled={busy || !code.trim()}", SEC),
  ("src/pages/SecurityPage.tsx", "cancelling leaves what was typed", "  function go(next: Mode) {\n    setMode(next);\n    setPassword(\"\");\n    setCode(\"\");", "  function go(next: Mode) {\n    setMode(next);", SEC),

  ("src/pages/TenantsUsersPage.tsx", "an admin is offered a reset of their own two-step", "u.id !== me?.userId", "true", USERS),
  ("src/pages/TenantsUsersPage.tsx", "the reset happens on the first click", "<button onClick={() => setConfirmingReset(u.id)} className=\"text-xs text-gray-500\">Reset two-step</button>", "<button onClick={() => { void api.resetUserMfa(u.id); }} className=\"text-xs text-gray-500\">Reset two-step</button>", USERS),
  ("src/pages/TenantsUsersPage.tsx", "the two-step column shows for everyone", "u.mfaEnabled !== undefined &&", "true &&", USERS),
  ("src/pages/TenantsUsersPage.tsx", "reset is offered to people who don't have it on", "{u.mfaEnabled && u.id !== me?.userId", "{u.id !== me?.userId", USERS),

  ("src/api/client.ts", "turning off goes to the wrong address", '"/auth/mfa/disable"', '"/auth/mfa/disabled"', API),
  ("src/api/client.ts", "the admin reset goes to the wrong person's address", "`/users/${userId}/reset-mfa`", "`/users/reset-mfa`", API),
  ("src/api/client.ts", "enrolment sends the password under the wrong name", '"/auth/mfa/enroll", { password }', '"/auth/mfa/enroll", { pw: password }', API),

  ("src/components/AppShell.tsx", "tenant users cannot reach their security settings", '  { to: "/dashboard", label: "Dashboard" },\n  { to: "/settings/security", label: "Security" },\n];\nconst AUDITOR_ROLES', '  { to: "/dashboard", label: "Dashboard" },\n];\nconst AUDITOR_ROLES', NAV),
  ("src/components/AppShell.tsx", "auditor-side users cannot reach their security settings", '  { to: "/settings/server", label: "Server settings", ownerOnly: true },\n  { to: "/settings/security", label: "Security" },\n];\nconst TENANT_NAV', '  { to: "/settings/server", label: "Server settings", ownerOnly: true },\n];\nconst TENANT_NAV', NAV),
  ("src/App.tsx", "the security page is not routed", '      <Route path="/settings/security" element={<RequireAuth><SecurityPage /></RequireAuth>} />\n', "", NAV),
  ("src/App.tsx", "the security page is open to signed-out visitors", '<Route path="/settings/security" element={<RequireAuth><SecurityPage /></RequireAuth>} />', '<Route path="/settings/security" element={<SecurityPage />} />', NAV),
  # --- stage 11: changing your password, and the organisation's two-step policy ---
  ("src/api/client.ts", "changing the password goes to the wrong address [011]", '"/auth/change-password"', '"/auth/password"', APISEC),
  ("src/api/client.ts", "the code is never sent when changing the password [011]", "code ? { currentPassword, newPassword, code } : { currentPassword, newPassword }", "{ currentPassword, newPassword }", APISEC),
  ("src/api/client.ts", "the two passwords are swapped [011]", "{ currentPassword, newPassword, code } : { currentPassword, newPassword }", "{ currentPassword: newPassword, newPassword: currentPassword, code } : { currentPassword: newPassword, newPassword: currentPassword }", APISEC),
  ("src/api/client.ts", "the policy is set with the wrong method [011]", '"PUT", "/org/mfa-policy", { policy }', '"POST", "/org/mfa-policy", { policy }', APISEC),
  ("src/api/client.ts", "'set up two-step first' is signalled for any refusal [011]", 'if (res.status === 403 && (data as ApiErrorBody | null)?.error?.code === "MFA_SETUP_REQUIRED")', 'if (res.status === 403)', APISEC),
  ("src/api/client.ts", "'set up two-step first' is signalled for any status [011]", 'if (res.status === 403 && (data as ApiErrorBody | null)?.error?.code === "MFA_SETUP_REQUIRED")', 'if ((data as ApiErrorBody | null)?.error?.code === "MFA_SETUP_REQUIRED")', APISEC),
  ("src/api/client.ts", "'set up two-step first' is never signalled [011]", 'this.opts.onMfaSetupRequired?.();', ';', APISEC),
  ("src/api/client.ts", "'set up two-step first' signs the person out [011]", 'this.opts.onMfaSetupRequired?.();', 'this.opts.onUnauthorized?.();', APISEC),
  ("src/auth/builtInAuthClient.ts", "a fresh session can be swapped in for somebody else [011]", "if (!this.session || this.session.user.userId !== result.userId) return;", "if (!this.session) return;", CLISEC),
  ("src/auth/builtInAuthClient.ts", "the fresh session is not remembered across a reload [011]", "    this.session = { ...this.session, token: result.token };\n    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));", "    this.session = { ...this.session, token: result.token };", CLISEC),
  ("src/auth/builtInAuthClient.ts", "the old session token is kept after a password change [011]", "this.session = { ...this.session, token: result.token };", "this.session = { ...this.session };", CLISEC),
  ("src/auth/builtInAuthClient.ts", "a password change tells the app someone signed in [011]", "    this.session = { ...this.session, token: result.token };\n    localStorage", "    this.session = { ...this.session, token: result.token };\n    this.listeners.forEach((fn) => fn(this.session!.user));\n    localStorage", CLISEC),
  ("src/auth/AuthProvider.tsx", "the 'set up two-step first' state carries over to the next person who signs in [011]", "  useEffect(() => setMfaSetupRequiredState(false), [userId]);\n", "", APPPOL),
  ("src/components/RequireAuth.tsx", "people who must set up two-step sign-in can use the rest of the app [011]", "  if (mfaSetupRequired && pathname !== SECURITY_PATH) return <Navigate to={SECURITY_PATH} replace />;\n", "", APPPOL),
  ("src/components/RequireAuth.tsx", "the Security page redirects to itself [011]", "if (mfaSetupRequired && pathname !== SECURITY_PATH)", "if (mfaSetupRequired)", APPPOL),
  ("src/components/AppShell.tsx", "the menu isn't narrowed while two-step setup is required [011]", '\n    .filter((item) => !mfaSetupRequired || item.to === "/settings/security");', ";", APPPOL),
  ("src/components/AppShell.tsx", "the menu hides Security while two-step setup is required [011]", 'item.to === "/settings/security");', "false);", APPPOL),
  ("src/pages/SecurityPage.tsx", "the page doesn't notice the rule was switched off [011]", "  useEffect(() => { if (status) setMfaSetupRequired(status.required && !status.enabled); }, [status, setMfaSetupRequired]);\n", "", APPPOL),
  ("src/pages/SecurityPage.tsx", "finishing set-up doesn't lift the redirect [011]", "      setMfaSetupRequired(false); // the server stops refusing everything else from this moment\n", "", APPPOL),
  ("src/pages/SecurityPage.tsx", "the 'your organisation requires it' notice is missing [011]", "{mustSetUp && (", "{false && (", POL),
  ("src/pages/SecurityPage.tsx", "the password form shows while set-up is still required [011]", "{status && !mustSetUp && <ChangePasswordCard", "{status && <ChangePasswordCard", SEC2),
  ("src/pages/SecurityPage.tsx", "the password form never asks for a code [011]", "<ChangePasswordCard twoStepOn={status.enabled} />", "<ChangePasswordCard twoStepOn={false} />", SEC2),
  ("src/pages/SecurityPage.tsx", "the policy card is shown to everyone [011]", "{status && !mustSetUp && isAdmin && <OrgPolicyCard", "{status && !mustSetUp && <OrgPolicyCard", POL),
  ("src/pages/SecurityPage.tsx", "the policy card shows while the admin must still set up two-step [011]", "{status && !mustSetUp && isAdmin && <OrgPolicyCard", "{status && isAdmin && <OrgPolicyCard", POL),
  ("src/pages/SecurityPage.tsx", "the policy card thinks the admin always has two-step on [011]", "<OrgPolicyCard adminHasTwoStep={status.enabled} />", "<OrgPolicyCard adminHasTwoStep={true} />", POL),
  ("src/pages/SecurityPage.tsx", "people the rule covers are offered 'turn off' [011]", '{!status.required && <button type="button" className={secondary} onClick={() => go("disable")}>', '{true && <button type="button" className={secondary} onClick={() => go("disable")}>', POL),
  ("src/pages/SecurityPage.tsx", "'required by your organisation' is not shown [011]", '{status.required && <span className="ml-2 text-xs text-gray-500">Required by your organisation</span>}', "", POL),
  ("src/pages/security/ChangePasswordCard.tsx", "a too-short new password is sent to the server [011]", "    if (next.length < MIN_LENGTH) { setError(`The new password must be at least ${MIN_LENGTH} characters.`); return; }\n", "", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "two different new passwords are sent [011]", "    if (next !== again) { setError(\"The two new passwords don't match.\"); return; }\n", "", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "the fresh session is not swapped in [011]", "replaceSession(await api.changePassword(current, next, twoStepOn ? code.trim() : undefined));", "await api.changePassword(current, next, twoStepOn ? code.trim() : undefined);", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "the code is never sent [011]", "twoStepOn ? code.trim() : undefined", "undefined", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "the code is sent untrimmed [011]", "twoStepOn ? code.trim() : undefined", "twoStepOn ? code : undefined", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "the form keeps the passwords after a change [011]", '      setCurrent(""); setNext(""); setAgain(""); setCode("");\n', "", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "no confirmation after a change [011]", "      setDone(true);\n", "", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "the confirmation stays up after the next attempt fails [011]", "    setDone(false);\n    if (next.length", "    if (next.length", SEC2),
  ("src/pages/security/ChangePasswordCard.tsx", "the form can be sent without the code [011]", "(!twoStepOn || !!code.trim())", "true", SEC2),
  ("src/pages/security/OrgPolicyCard.tsx", "the wrong choice is sent [011]", "api.setMfaPolicy(chosen)", 'api.setMfaPolicy("off")', POL),
  ("src/pages/security/OrgPolicyCard.tsx", "no warning before requiring it [011]", '{chosen !== "off" && chosen !== saved && (', "{false && (", POL),
  ("src/pages/security/OrgPolicyCard.tsx", "the warning also shows when switching it off [011]", '{chosen !== "off" && chosen !== saved && (', "{chosen !== saved && (", POL),
  ("src/pages/security/OrgPolicyCard.tsx", "the options are never disabled up front [011]", 'const disabled = o.value !== "off" && blockedReason !== null && o.value !== saved;', "const disabled = false;", POL),
  ("src/pages/security/OrgPolicyCard.tsx", "a setting already in force can't be kept when the server has lost its key [011]", 'const disabled = o.value !== "off" && blockedReason !== null && o.value !== saved;', 'const disabled = o.value !== "off" && blockedReason !== null;', POL),
  ("src/pages/security/OrgPolicyCard.tsx", "a server without a key isn't explained [011]", ": !data.available ?", ": false ?", POL),
  ("src/pages/security/OrgPolicyCard.tsx", "an admin without two-step on isn't told why [011]", ": !adminHasTwoStep ?", ": false ?", POL),
  ("src/pages/security/OrgPolicyCard.tsx", "the counts are shown against the wrong option [011]", '{o.value === "staff" && <span className="block text-xs text-gray-500 mt-1">{progress(counts.staff)}</span>}', '{o.value === "staff" && <span className="block text-xs text-gray-500 mt-1">{progress(counts.everyone)}</span>}', POL),
  ("src/pages/security/OrgPolicyCard.tsx", "one person is described in the plural [011]", 'c.total === 1 ? "person has" : "people have"', '"people have"', POL),
  ("src/pages/security/OrgPolicyCard.tsx", "'Save policy' is available with nothing changed [011]", "disabled={busy || chosen === saved}", "disabled={busy}", POL),
  ("src/pages/security/OrgPolicyCard.tsx", "the counts aren't refreshed after saving [011]", "      setUpdated(next);\n", "", POL),
  ('src/pages/serverSettings/EmailCard.tsx', 'the mail password is shown as it is typed [013-fe]', 'id="email-mail-password" type="password"', 'id="email-mail-password" type="text"', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', 'an empty mail password is sent, wiping the saved one [013-fe]', '...(password !== "" ? { password } : {}),', 'password,', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', "the mail settings can be saved without the owner's password [013-fe]", 'disabled={a.busy || !complete || !a.confirmed || !canStoreSecrets}', 'disabled={a.busy || !complete || !canStoreSecrets}', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', "the mail settings can be saved on a server that can't store the password [013-fe]", 'disabled={a.busy || !complete || !a.confirmed || !canStoreSecrets}', 'disabled={a.busy || !complete || !a.confirmed}', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', 'the mail settings can be saved half filled in [013-fe]', 'disabled={a.busy || !complete || !a.confirmed || !canStoreSecrets}', 'disabled={a.busy || !a.confirmed || !canStoreSecrets}', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', "settings from the server's configuration can be edited here [013-fe]", '{group.locked ? <LockedValues', '{false ? <LockedValues', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', "saved settings that can't be used are not explained [013-fe]", '{group.problem && <p role="alert"', '{false && <p role="alert"', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', 'the test email button shows before mail is set up [013-fe]', '{group.source !== "none" && (', '{true && (', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/EmailCard.tsx', "saved settings that can't be used can't be removed [013-fe]", 'const canRemove = group.source === "panel" || (group.problem !== null && !group.locked);', 'const canRemove = group.source === "panel";', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/ScannerCard.tsx', 'scanner settings can be removed without the password [013-fe]', 'disabled={a.busy || !a.confirmed} className={secondary}>Remove saved scanner settings', 'disabled={a.busy} className={secondary}>Remove saved scanner settings', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/GoogleCard.tsx', 'the Google app can be saved with no client secret the first time [013-fe]', '&& (secret.trim() !== "" || secretSaved);', '&& true;', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/GoogleCard.tsx', 'the suggested redirect address is wrong [013-fe]', '/oauth/google/callback`;\n  const v', '/oauth/callback`;\n  const v', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/GoogleCard.tsx', 'an empty client secret is sent, wiping the saved one [013-fe]', '...(secret.trim() !== "" ? { clientSecret: secret.trim() } : {})', 'clientSecret: secret.trim()', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/shared.tsx', 'the owner is never asked for a two-step code [013-fe]', '{needsCode && (', '{false && (', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/helpers.ts', 'the two-step code is not sent when saving [013-fe]', 'api.savePlatformGroup(group, settings, password, needsCode ? code.trim() : undefined)', 'api.savePlatformGroup(group, settings, password, undefined)', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/serverSettings/helpers.ts', 'the typed passwords stay in the form after saving [013-fe]', '      setPassword(""); setCode("");\n      onSaved(view, done);', '      onSaved(view, done);', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/ServerSettingsPage.tsx', 'the settings are requested before it is known the person is the owner [013-fe]', '{owner === true && <SettingsContent />}', '{owner !== false && <SettingsContent />}', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/ServerSettingsPage.tsx', 'a server with no encryption key is not warned about [013-fe]', '{!view.canStoreSecrets && (', '{false && (', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/pages/ServerSettingsPage.tsx', 'the "saved" message appears on every card [013-fe]', '(saved?.group === g ? saved.message : undefined)', '(saved?.message)', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/components/AppShell.tsx', 'everyone sees the Server settings menu item [013-fe]', '.filter((item) => !item.ownerOnly || isOwner)', '', ['src/api/PlatformOwnerProvider.test.tsx']),
  ('src/api/PlatformOwnerProvider.tsx', 'everyone is asked whether they own the installation [013-fe]', 'const mightBeOwner = user?.role === "org_admin";', 'const mightBeOwner = true;', ['src/api/PlatformOwnerProvider.test.tsx']),
  ('src/api/PlatformOwnerProvider.tsx', 'not being able to find out is treated as being the owner [013-fe]', '.catch(() => { if (!cancelled) setState({ userId, owner: false }); })', '.catch(() => { if (!cancelled) setState({ userId, owner: true }); })', ['src/api/PlatformOwnerProvider.test.tsx']),
  ('src/api/PlatformOwnerProvider.tsx', "one person's answer is used for the next person who signs in [013-fe]", 'state !== null && state.userId === userId ? state.owner : null', 'state !== null ? state.owner : null', ['src/api/PlatformOwnerProvider.test.tsx']),
  ('src/api/PlatformOwnerProvider.tsx', 'any answer at all counts as "owner" [013-fe]', 'owner: r.owner === true', 'owner: !!r', ['src/api/PlatformOwnerProvider.test.tsx']),
  ('src/pages/IntegrationsPage.tsx', 'everyone is offered the link to Server settings [013-fe]', '{banner.settingsLink && isOwner && <>', '{banner.settingsLink && <>', ['src/pages/IntegrationsPage.test.tsx']),
  ('src/pages/IntegrationsPage.tsx', 'the link to Server settings is offered for any Google problem [013-fe]', 'settingsLink: errorParam === "not_configured"', 'settingsLink: true', ['src/pages/IntegrationsPage.test.tsx']),
  ('src/pages/integrationMessages.ts', '"Google not set up" has no explanation when it arrives as an error code [013-fe]', '  OAUTH_NOT_CONFIGURED: "Google Drive isn\'t set up on this server yet. The owner of this installation can add the Google app details under Server settings.",\n', '', ['src/pages/integrationMessages.test.ts']),
  ('src/api/client.ts', 'the two-step code is dropped from a save request [013-fe]', 'code ? { settings, password, code } : { settings, password }', '{ settings, password }', ['src/pages/ServerSettingsPage.test.tsx']),
  ('src/components/assignment.ts', 'viewers can be given controls [assign-fe]', 'new Set(["contributor", "tenant_lead"])', 'new Set(["contributor", "tenant_lead", "viewer"])', ['src/components/ControlAssignment.test.tsx', 'src/components/BulkAssign.test.tsx']),
  ('src/components/assignment.ts', 'switched-off accounts can be given controls [assign-fe]', ' && u.status !== "disabled"', '', ['src/components/ControlAssignment.test.tsx', 'src/components/BulkAssign.test.tsx']),
  ('src/components/assignment.ts', 'invited people cannot be given controls [assign-fe]', 'u.status !== "disabled"', 'u.status === "active"', ['src/components/ControlAssignment.test.tsx', 'src/components/BulkAssign.test.tsx']),
  ('src/components/assignment.ts', 'client leads cannot be given controls [assign-fe]', 'new Set(["contributor", "tenant_lead"])', 'new Set(["contributor"])', ['src/components/ControlAssignment.test.tsx', 'src/components/BulkAssign.test.tsx']),
  ('src/components/assignment.ts', 'a person is shown by address only [assign-fe]', '(u.fullName ? `${u.fullName} (${u.email})` : u.email)', 'u.email', ['src/components/ControlAssignment.test.tsx', 'src/components/BulkAssign.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'people who already have the control are offered again [assign-fe]', 'canBeAssigned(u) && !assigned.has(u.id)', 'canBeAssigned(u)', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'assigns the first person instead of the chosen one [assign-fe]', 'api.assignControl(control.id, pick)', 'api.assignControl(control.id, candidates[0].id)', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'removes the wrong person [assign-fe]', 'api.unassignControl(control.id, a.userId)', 'api.unassignControl(control.id, "someone-else")', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'the list is not refreshed after a change [assign-fe]', 'setPick(""); assignees.refetch();', 'setPick("");', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'the chosen person stays selected after assigning [assign-fe]', 'setPick(""); assignees.refetch();', 'assignees.refetch();', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'the real reason for a failure is hidden [assign-fe]', 'setError(e instanceof ApiError ? e.message :', 'setError(e instanceof ApiError ? "Failed" :', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'an earlier error stays after a retry works [assign-fe]', 'setBusy(true); setError(null);', 'setBusy(true);', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'assigning is possible without choosing anyone [assign-fe]', 'disabled={busy || !pick} onClick', 'disabled={busy} onClick', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', '"no one to assign" gives no hint [assign-fe]', "Invite the client's people under Users.", '', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'a failure to load the assignees is not shown [assign-fe]', '{assignees.error && <p role="alert"', '{false && <p role="alert"', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'a failure to load the people is not shown [assign-fe]', '{people.error && <p role="alert"', '{false && <p role="alert"', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'the remove buttons are not named [assign-fe]', 'aria-label={`Remove ${a.email}`}', '', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/BulkAssign.tsx', 'not-applicable controls are assigned too [assign-fe]', 'const applicable = controls.filter((c) => c.applicable);', 'const applicable = controls;', ['src/components/BulkAssign.test.tsx', 'src/pages/ControlsPage.test.tsx']),
  ('src/components/BulkAssign.tsx', 'choosing a section still assigns everything [assign-fe]', 'applicable.filter((c) => c.section === scope);', 'applicable;', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'assigns the first person instead of the chosen one [assign-fe]', 'api.assignControlsBulk(auditId, person,', 'api.assignControlsBulk(auditId, candidates[0].id,', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', '"1 control" is written "1 controls" [assign-fe]', 'assigned === 1 ? "" : "s"', '"s"', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'the number already assigned is not mentioned [assign-fe]', 'const already = chosen.length - assigned;', 'const already = 0;', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'assigning is possible without choosing anyone [assign-fe]', 'disabled={busy || !person || chosen.length === 0}', 'disabled={busy || chosen.length === 0}', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'assigning is possible with nothing to assign [assign-fe]', 'disabled={busy || !person || chosen.length === 0}', 'disabled={busy || !person}', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'a failure is announced as a success [assign-fe]', 'role={message.ok ? "status" : "alert"}', 'role="status"', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'a section is listed once per control [assign-fe]', '[...new Set(applicable.map((c) => c.section))]', 'applicable.map((c) => c.section)', ['src/components/BulkAssign.test.tsx']),
  ('src/components/BulkAssign.tsx', 'the form is shown when there is no one to assign to [assign-fe]', 'if (people.data && candidates.length === 0) {', 'if (false) {', ['src/components/BulkAssign.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'an auditor who can only read is offered the assign panel [assign-fe]', 'const ASSIGN_ROLES = new Set(["org_admin", "lead_auditor"]);', 'const ASSIGN_ROLES = new Set(["org_admin", "lead_auditor", "auditor"]);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'a lead auditor is not offered the assign panel [assign-fe]', 'const ASSIGN_ROLES = new Set(["org_admin", "lead_auditor"]);', 'const ASSIGN_ROLES = new Set(["org_admin"]);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'the control drawer offers assignment to everyone [assign-fe]', 'assignTenantId={canAssign ? selectedTenantId : null}', 'assignTenantId={selectedTenantId}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a contributor is offered the Assign button [assign-fe]', 'const isLead = user?.role === "tenant_lead";', 'const isLead = true;', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a client lead is not offered the Assign button [assign-fe]', 'const isLead = user?.role === "tenant_lead";', 'const isLead = false;', ['src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'the assigned-to section always shows [assign-fe]', '{assignTenantId && <ControlAssignment control={control} tenantId={assignTenantId} />}', '{<ControlAssignment control={control} tenantId={assignTenantId ?? ""} />}', ['src/pages/ControlsPage.test.tsx']),
  ('src/api/client.ts', 'bulk assignment goes to the wrong address [assign-fe]', '`/audits/${auditId}/assignments`', '`/audits/${auditId}/assign`', ['src/components/BulkAssign.test.tsx', 'src/pages/ControlsPage.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'the chosen cycle is ignored [cycle-fe]', 'audits.find((a) => a.id === chosen) ?? audits[0] ?? null', 'audits[0] ?? null', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'a remembered cycle that no longer exists leaves nothing shown [cycle-fe]', 'audits.find((a) => a.id === chosen) ?? audits[0] ?? null', 'audits.find((a) => a.id === chosen) ?? null', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', "another client's remembered cycle is not looked up [cycle-fe]", 'picked.tenantId === tenantId ? picked.auditId : remembered(tenantId)', 'picked.auditId', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'every client shares one remembered cycle [cycle-fe]', 'const keyFor = (tenantId: string) => `selectedAudit:${tenantId}`;', 'const keyFor = (tenantId: string) => `selectedAudit`;', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'the choice is not remembered [cycle-fe]', '    remember(tenantId, auditId);\n', '', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'a failure to read browser storage breaks the app [cycle-fe]', 'try { return localStorage.getItem(keyFor(tenantId)); } catch { return null; }', 'return localStorage.getItem(keyFor(tenantId));', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'a failure to write browser storage breaks the app [cycle-fe]', 'try { localStorage.setItem(keyFor(tenantId), auditId); } catch { /* not remembered; nothing else depends on it */ }', 'localStorage.setItem(keyFor(tenantId), auditId);', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'a first cycle is created for a client-side user too [cycle-fe]', 'e instanceof ApiError && e.status === 403', 'false', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'the first cycle ignores the platform default template [cycle-fe]', 'templates.find((t) => t.isPlatformDefault) ?? templates[0]', 'templates[0]', ['src/api/useCurrentAudit.test.tsx']),
  ('src/api/useCurrentAudit.ts', 'no client selected still asks the server [cycle-fe]', 'if (!tenantId) return [];\n    const existing', 'const existing', ['src/api/useCurrentAudit.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a single cycle still shows the chooser to people who cannot add one [cycle-fe]', 'if (audits.length <= 1 && !canCreate) return null;', 'if (audits.length === 0 && !canCreate) return null;', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a closed cycle is not marked [cycle-fe]', '${a.status === "closed" ? " · closed" : ""}', '', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'the start date shows only the month [cycle-fe]', 'iso.slice(0, 10)', 'iso.slice(0, 7)', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'choosing a cycle does nothing [cycle-fe]', 'onChange={(e) => onSelect(e.target.value)}', 'onChange={() => {}}', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'anyone is offered the new-cycle button [cycle-fe]', '{canCreate && !creating && (', '{!creating && (', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'the first template is preselected instead of the platform default [cycle-fe]', 'list.find((t) => t.isPlatformDefault) ?? list[0]', 'list[0]', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'the suggested name leaves out the year [cycle-fe]', '`${template.framework} audit ${new Date().getFullYear()}`', '`${template.framework} audit`', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'the typed name is ignored [cycle-fe]', 'const name = typedName ?? (', 'const name = (', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'the name is not trimmed [cycle-fe]', 'onCreated(await api.createAudit(tenantId, template.id, name.trim()));', 'onCreated(await api.createAudit(tenantId, template.id, name));', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a blank name can be created [cycle-fe]', 'disabled={busy || !template || name.trim() === ""}', 'disabled={busy || !template}', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a failure to create hides the reason [cycle-fe]', 'setError(e instanceof ApiError ? e.message :', 'setError(e instanceof ApiError ? "Failed" :', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'after a failure the form stays stuck on "Creating…" [cycle-fe]', '      setBusy(false);\n    }\n  }', '    }\n  }', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'cancelling does not close the form [cycle-fe]', 'onCancel={() => setCreating(false)}', 'onCancel={() => {}}', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'the form stays open after the cycle is created [cycle-fe]', 'onCreated={(a) => { setCreating(false); onCreated(a); }}', 'onCreated={(a) => { onCreated(a); }}', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a failure to load the templates is not shown [cycle-fe]', '{templates.error && <p role="alert"', '{false && <p role="alert"', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a cycle can be created before any template has loaded [cycle-fe]', 'disabled={busy || !template ||', 'disabled={busy ||', ['src/components/AuditCyclePicker.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a read-only auditor can start cycles [cycle-fe]', 'new Set(["org_admin", "lead_auditor"])', 'new Set(["org_admin", "lead_auditor", "auditor"])', ['src/pages/ControlsPage.test.tsx']),
  ('src/components/AuditCyclePicker.tsx', 'a lead auditor cannot start cycles [cycle-fe]', 'new Set(["org_admin", "lead_auditor"])', 'new Set(["org_admin"])', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'after starting a cycle the page stays where it was [cycle-fe]', 'onCreated={(a) => { selectAudit(a.id); refetchAudits(); }}', 'onCreated={() => { refetchAudits(); }}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'after starting a cycle the list of cycles is not refreshed [cycle-fe]', 'onCreated={(a) => { selectAudit(a.id); refetchAudits(); }}', 'onCreated={(a) => { selectAudit(a.id); }}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'the chooser does nothing on the controls page [cycle-fe]', 'onSelect={selectAudit} onCreated', 'onSelect={() => {}} onCreated', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/DashboardPage.tsx', 'the chooser does nothing on the dashboard [cycle-fe]', 'onSelect={selectAudit} onCreated', 'onSelect={() => {}} onCreated', ['src/pages/DashboardPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', "a client's person is offered the new-cycle button [cycle-fe]", 'canCreate={false}', 'canCreate={true}', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', "the chooser does nothing for a client's person [cycle-fe]", 'onSelect={selectAudit} onCreated={() => {}}', 'onSelect={() => {}} onCreated={() => {}}', ['src/pages/MyControlsPage.test.tsx']),
  ('src/api/TenantProvider.tsx', 'a failure to read browser storage breaks the tenant list [cycle-fe]', 'try { return localStorage.getItem("selectedTenantId"); } catch { return null; }', 'return localStorage.getItem("selectedTenantId");', ['src/api/TenantProvider.test.tsx']),
  ('src/api/TenantProvider.tsx', 'a failure to write browser storage breaks choosing a tenant [cycle-fe]', 'try { localStorage.setItem("selectedTenantId", id); } catch { /* not remembered; nothing else depends on it */ }', 'localStorage.setItem("selectedTenantId", id);', ['src/api/TenantProvider.test.tsx']),
  ('src/api/TenantProvider.tsx', 'the chosen tenant is not remembered [cycle-fe]', '    rememberTenant(id);\n', '', ['src/api/TenantProvider.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'an auditor is offered the Close button [close-fe]', 'new Set(["org_admin", "lead_auditor"])', 'new Set(["org_admin", "lead_auditor", "auditor"])', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a client lead is offered the Close button [close-fe]', 'new Set(["org_admin", "lead_auditor"])', 'new Set(["org_admin", "lead_auditor", "tenant_lead"])', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a lead auditor is not offered the Close button [close-fe]', 'new Set(["org_admin", "lead_auditor"])', 'new Set(["org_admin"])', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'an organisation admin is not offered the Close button [close-fe]', 'new Set(["org_admin", "lead_auditor"])', 'new Set(["lead_auditor"])', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the closing date shows the wrong part of the timestamp [close-fe]', 'iso.slice(0, 10)', 'iso.slice(0, 7)', ['src/components/AuditCycleLock.test.tsx', 'src/pages/ControlsPage.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a reason of two characters can be sent [close-fe]', 'const MIN_REASON = 3;', 'const MIN_REASON = 2;', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a reason must be four characters [close-fe]', 'const MIN_REASON = 3;', 'const MIN_REASON = 4;', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'spaces count towards the reason [close-fe]', 'reason.trim().length < MIN_REASON', 'reason.length < MIN_REASON', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the reason is sent with its spaces [close-fe]', 'api.reopenAudit(audit.id, reason.trim())', 'api.reopenAudit(audit.id, reason)', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the reason box accepts more than the server does [close-fe]', 'maxLength={1000} ', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'every failure shows the same vague message [close-fe]', 'setError(e instanceof ApiError ? e.message : "That didn\'t work. Please try again.");', 'setError("That didn\'t work. Please try again.");', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'an unexpected failure shows no message [close-fe]', 'e instanceof ApiError ? e.message : "That didn\'t work. Please try again."', 'e instanceof ApiError ? e.message : ""', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the page is not told when closing or reopening worked [close-fe]', '      onChanged?.(updated);\n', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the typed reason survives a successful reopen [close-fe]', '      setStep("idle"); setReason("");\n', '      setStep("idle");\n', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'cancelling keeps the typed reason [close-fe]', 'const cancel = () => { setStep("idle"); setReason(""); setError(null); };', 'const cancel = () => { setStep("idle"); setError(null); };', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'cancelling keeps the old error [close-fe]', 'const cancel = () => { setStep("idle"); setReason(""); setError(null); };', 'const cancel = () => { setStep("idle"); setReason(""); };', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'an old error stays on screen when trying again [close-fe]', '    setBusy(true); setError(null);\n', '    setBusy(true);\n', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the buttons stay disabled after a failure [close-fe]', '    } finally {\n      setBusy(false);\n    }\n  }\n\n  const cancel', '    } finally {\n    }\n  }\n\n  const cancel', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'people who cannot reopen are offered Reopen [close-fe]', '{canManage && step !== "reopen" && (', '{step !== "reopen" && (', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'people who cannot close are offered Close [close-fe]', '  if (!canManage) return null;\n', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the closed notice leaves out who closed it [close-fe]', '{audit.closedBy ? ` by ${audit.closedBy}` : ""}', '{""}', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the closed notice leaves out when it was closed [close-fe]', '{audit.closedAt ? `Closed on ${day(audit.closedAt)}', '{false ? `Closed on ${day(audit.closedAt)}', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a missing closing time crashes the notice [close-fe]', '{audit.closedAt ? `Closed on', '{true ? `Closed on', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a "by" is shown when nobody is named [close-fe]', '{audit.closedBy ? ` by ${audit.closedBy}` : ""}', '{` by ${audit.closedBy}`}', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the warning about unaccepted controls is always shown [close-fe]', '{notAccepted > 0 && (', '{true && (', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the warning about unaccepted controls is never shown [close-fe]', '{notAccepted > 0 && (', '{false && (', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the warning says "is" for several controls [close-fe]', '{notAccepted === 1 ? " is" : "s are"} not accepted yet.', '{notAccepted === 1 ? " is" : " is"} not accepted yet.', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the warning counts one control as several [close-fe]', 'control{notAccepted === 1 ? " is" : "s are"}', 'control{"s are"}', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the cycle is closed without asking [close-fe]', 'onClick={() => setStep("confirm-close")}', 'onClick={() => { void run(() => api.closeAudit(audit.id)); }}', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the Close button stays while asking for confirmation [close-fe]', '{step !== "confirm-close" && (', '{true && (', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'Yes-close can be pressed again while closing [close-fe]', '<button type="button" disabled={busy} onClick={() => run(() => api.closeAudit(audit.id))}', '<button type="button" onClick={() => run(() => api.closeAudit(audit.id))}', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the confirmation does not name the cycle [close-fe]', 'Close “{audit.name}”?', 'Close this cycle?', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the confirmation does not say it can be reopened [close-fe]', 'and a lead auditor or\n            organisation admin can reopen it later (with a reason).', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'the reopen form does not say the reason is logged [close-fe]', 'The reason is written to the audit log, together with your name.', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a failed close shows nothing [close-fe]', '{error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/components/AuditCycleLock.tsx', 'a failed reopen shows nothing [close-fe]', '{error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}', '', ['src/components/AuditCycleLock.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'a closed cycle is not treated as closed [close-fe]', 'const closed = audit?.status === "closed";', 'const closed = false;', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'requirements can be edited on a closed cycle [close-fe]', 'AUDITOR_WRITE_ROLES.has(role) && !closed;', 'AUDITOR_WRITE_ROLES.has(role);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'reminders can be sent on a closed cycle [close-fe]', 'REMIND_ROLES.has(role) && !closed;', 'REMIND_ROLES.has(role);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'reviews can be started on a closed cycle [close-fe]', 'REVIEW_ROLES.has(role) && !closed;', 'REVIEW_ROLES.has(role);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'controls can be assigned on a closed cycle [close-fe]', 'ASSIGN_ROLES.has(role) && !closed;', 'ASSIGN_ROLES.has(role);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'everyone who sees the page can close the cycle [close-fe]', 'canManage={CAN_CLOSE_CYCLE.has(role)}', 'canManage={true}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'nobody can close the cycle from the page [close-fe]', 'canManage={CAN_CLOSE_CYCLE.has(role)}', 'canManage={false}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'the heads-up counts not-applicable controls [close-fe]', '.filter((c) => c.applicable && c.status !== "accepted")', '.filter((c) => c.status !== "accepted")', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'the heads-up counts accepted controls [close-fe]', '.filter((c) => c.applicable && c.status !== "accepted")', '.filter((c) => c.applicable)', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'the page does not refresh after closing or reopening [close-fe]', 'onChanged={() => refetchAudits()}', 'onChanged={() => {}}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'a refused reminder on a closed cycle does not say why [close-fe]', '        setRemindError(e.message);\n        refetchAudits();', '        refetchAudits();', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'a refused reminder on a closed cycle leaves the page as it was [close-fe]', '        setRemindError(e.message);\n        refetchAudits();', '        setRemindError(e.message);', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'an old reminder message stays after trying again [close-fe]', '    setRemindError(null);\n    try {\n      await api.remind', '    try {\n      await api.remind', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', 'the review panel can change a closed cycle [close-fe]', 'canReview={canReview} readOnly={closed}', 'canReview={canReview} readOnly={false}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/ControlsPage.tsx', "switching cycles keeps the previous cycle's buttons and text [close-fe]", '<AuditCycleLock key={`lock-${audit.id}`} audit={audit}', '<AuditCycleLock audit={audit}', ['src/pages/ControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a closed cycle is not treated as closed (client page) [close-fe]', 'const closed = audit?.status === "closed";', 'const closed = false;', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'evidence can be uploaded to a closed cycle [close-fe]', 'const canUpload = !closed && (', 'const canUpload = (', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a client lead is offered Assign on a closed cycle [close-fe]', '{closed ? "View" : "Assign"}', '{"Assign"}', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a client lead is only ever offered View [close-fe]', '{closed ? "View" : "Assign"}', '{"View"}', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'the client drawer can change a closed cycle [close-fe]', 'canReview={false} readOnly={closed}', 'canReview={false} readOnly={false}', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a submit refused because the cycle closed does not refresh the page [close-fe]', 'if (e instanceof ApiError && e.code === "AUDIT_CLOSED") refetchAudits();', '', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a refused submit shows only a vague message [close-fe]', 'setSubmitError(e instanceof ApiError ? e.message : "That didn\'t work. Please try again.");', 'setSubmitError("That didn\'t work. Please try again.");', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'the closed notice is missing on the client page [close-fe]', '{audit && <AuditCycleLock key={audit.id} audit={audit} canManage={false} />}', '', ['src/pages/MyControlsPage.test.tsx']),
  ('src/pages/MyControlsPage.tsx', 'a client can reopen a cycle [close-fe]', '{audit && <AuditCycleLock key={audit.id} audit={audit} canManage={false} />}', '{audit && <AuditCycleLock key={audit.id} audit={audit} canManage={true} />}', ['src/pages/MyControlsPage.test.tsx']),
  # (Not included: showing the Reopen form to someone who may not reopen, or the dashboard notice for an open cycle. The first can't be
  # reached because the button that opens the form is already hidden; the second renders nothing either way.)
  ('src/pages/DashboardPage.tsx', 'the dashboard does not say the cycle is closed [close-fe]', '{audit?.status === "closed" && <div', '{false && <div', ['src/pages/DashboardPage.test.tsx']),
  ('src/pages/DashboardPage.tsx', 'the dashboard offers to reopen the cycle [close-fe]', '<AuditCycleLock key={audit.id} audit={audit} canManage={false} />', '<AuditCycleLock key={audit.id} audit={audit} canManage={true} />', ['src/pages/DashboardPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'a closed cycle can be accepted or rejected from the drawer [close-fe]', 'const canDecide = canReview && !readOnly && (', 'const canDecide = canReview && (', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'a closed cycle shows the comment box [close-fe]', '{readOnly ? (', '{false ? (', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'an open cycle has no comment box [close-fe]', '{readOnly ? (', '{true ? (', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', "the drawer's assignments stay editable on a closed cycle [close-fe]", 'tenantId={assignTenantId} readOnly={readOnly} />', 'tenantId={assignTenantId} />', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'a refused decision on a closed cycle gets a misleading message [close-fe]', 'if (e instanceof ApiError && e.code === "AUDIT_CLOSED") setError(e.message);', 'if (false) setError(e.message);', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'a refused comment shows only a vague message [close-fe]', 'setCommentError(e instanceof ApiError ? e.message : "The comment could not be saved. Please try again.");', 'setCommentError("The comment could not be saved. Please try again.");', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'a refused comment shows nothing [close-fe]', '{commentError && <p role="alert" className="text-sm text-red-600 mb-2">{commentError}</p>}', '', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlDetailDrawer.tsx', 'an old comment error stays after trying again [close-fe]', '    setBusy(true);\n    setCommentError(null);\n', '    setBusy(true);\n', ['src/components/ControlDetailDrawer.test.tsx', 'src/pages/ControlsPage.test.tsx', 'src/pages/MyControlsPage.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'a closed cycle shows the usual explanation instead of why [close-fe]', '{readOnly ? "This audit cycle is closed, so assignments can\'t be changed." : "Contributors only', '{false ? "This audit cycle is closed, so assignments can\'t be changed." : "Contributors only', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'assignments can be removed on a closed cycle [close-fe]', '            {!readOnly && (', '            {true && (', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'a closed cycle shows "no one to assign" [close-fe]', '{!readOnly && people.data && candidates.length === 0', '{people.data && candidates.length === 0', ['src/components/ControlAssignment.test.tsx']),
  ('src/components/ControlAssignment.tsx', 'people can be added on a closed cycle [close-fe]', '{!readOnly && candidates.length > 0 && (', '{candidates.length > 0 && (', ['src/components/ControlAssignment.test.tsx']),
  ('src/api/client.ts', 'closing asks for the wrong address [close-fe]', '`/audits/${auditId}/close`', '`/audits/${auditId}/reopen`', ['src/components/AuditCycleLock.test.tsx']),
  ('src/api/client.ts', 'reopening asks for the wrong address [close-fe]', '`/audits/${auditId}/reopen`, { reason }', '`/audits/${auditId}/close`, { reason }', ['src/components/AuditCycleLock.test.tsx']),
  ('src/api/client.ts', 'reopening does not send the reason [close-fe]', '`/audits/${auditId}/reopen`, { reason }', '`/audits/${auditId}/reopen`, {}', ['src/components/AuditCycleLock.test.tsx']),

  # where evidence is kept: choosing, connecting, uploading to the portal, downloading
  ('src/pages/IntegrationsPage.tsx', "switching storage does not ask first, although it clears tenants' folders [storage-fe]", 'if (current !== provider && foldersToClear > 0) setPending', 'if (current !== provider && foldersToClear > 99) setPending', INT),
  ('src/pages/IntegrationsPage.tsx', "saving S3 details does not ask first, although it clears tenants' folders [storage-fe]", 'if (current !== "s3" && foldersToClear > 0) {', 'if (current !== "s3" && foldersToClear > 99) {', INT),
  ('src/pages/IntegrationsPage.tsx', "the server's folder location is shown to every org admin [storage-fe]", 'const where = isOwner ?', 'const where = true ?', INT),
  ('src/pages/IntegrationsPage.tsx', 'the note that the choice is fixed is never shown [storage-fe]', '{locked && current && (', '{false && current && (', INT),
  ('src/pages/IntegrationsPage.tsx', 'a storage is called in use although access was lost [storage-fe]', 'const inUse = current === provider && option?.connected === true && option.status === "active";', 'const inUse = current === provider;', INT),
  ('src/pages/IntegrationsPage.tsx', 'folders can be created although access to the storage was lost [storage-fe]', 'const currentReady = currentOption?.connected === true && currentOption.status === "active";', 'const currentReady = currentOption?.connected === true;', INT),
  ('src/pages/IntegrationsPage.tsx', "a storage this server doesn't offer still gets buttons [storage-fe]", 'const usable = option?.available === true;', 'const usable = true;', INT),
  ('src/pages/IntegrationsPage.tsx', 'choosing a connected storage chooses S3 whatever was clicked [storage-fe]', 'await api.chooseStorageProvider(provider);', 'await api.chooseStorageProvider("s3");', INT),
  ('src/pages/IntegrationsPage.tsx', 'the page is not reloaded after a change [storage-fe]', '      storage.refetch();\n      tenants.refetch();\n    } catch (e) {\n      setBanner({ kind: "error", text: errorText(e, fallback) });', '      tenants.refetch();\n    } catch (e) {\n      setBanner({ kind: "error", text: errorText(e, fallback) });', INT),
  ('src/pages/S3Form.tsx', 'S3 details can be saved without the secret key [storage-fe]', 'form.accessKeyId.trim() !== "" && form.secretAccessKey !== ""', 'form.accessKeyId.trim() !== ""', INT),
  ('src/pages/S3Form.tsx', 'the secret key is shown while typed [storage-fe]', 'type="password"', 'type="text"', INT),
  ('src/pages/S3Form.tsx', 'a test result stays after the details change [storage-fe]', 'setForm((f) => ({ ...f, [key]: value })); setResult(null);', 'setForm((f) => ({ ...f, [key]: value }));', INT),
  ('src/pages/S3Form.tsx', 'the warning that only keys can change is never shown [storage-fe]', '{locked && (', '{false && (', INT),
  ('src/api/client.ts', "an upload to the portal's own address goes to the wrong place [storage-fe]", 'fetch(resolveUploadUrl(api.baseUrl, session.uploadUrl),', 'fetch(session.uploadUrl,', CL),
  ('src/api/client.ts', "a full upload address (Google's) is rewritten [storage-fe]", 'if (/^[a-z][a-z0-9+.-]*:/i.test(uploadUrl)) return uploadUrl;', '', CL),
  ('src/api/client.ts', "a download is requested without the person's session [storage-fe]", 'headers: token ? { Authorization: `Bearer ${token}` } : {} })', 'headers: {} })', CL),
  ('src/api/client.ts', "the portal's reason for refusing an upload is thrown away [storage-fe]", 'const message = data?.error?.message;', 'const message = undefined as string | undefined;', CL),
  ('src/api/client.ts', "an ended session isn't noticed on a download [storage-fe]", 'if (res.status === 401 && token) this.opts.onUnauthorized?.();\n      const data = (await res.json()', 'const data = (await res.json()', CL),
  ('src/components/ControlDetailDrawer.tsx', 'a download error is shown beside every file [storage-fe]', '{downloadError?.fileId === f.id &&', '{downloadError &&', DR),
  ('src/components/ControlDetailDrawer.tsx', 'a downloaded file is saved under the wrong name [storage-fe]', 'saveBlob(await api.downloadEvidence(fileId), fileName);', 'saveBlob(await api.downloadEvidence(fileId), fileId);', DR),
  ('src/components/ControlDetailDrawer.tsx', 'an old download error stays when the next try starts [storage-fe]', '    setDownloading(fileId);\n    setDownloadError(null);', '    setDownloading(fileId);', DR),
  ('src/components/saveBlob.ts', 'the download link is left in the page [storage-fe]', '  link.remove();\n', '', SB),
  ('src/components/saveBlob.ts', 'a saved file has no name [storage-fe]', '  link.download = fileName;', '  link.download = "";', SB),
]

def tests_ran(out): return re.search(r"Tests\s+.*\d+\s+(passed|failed)", out) is not None
def failed_count(out):
    m = re.search(r"Tests\s+(\d+) failed", out); return int(m.group(1)) if m else 0

def run_in_copy(file, content, tests):
    d = tempfile.mkdtemp(prefix="fmut-", dir="/home/claude" if os.path.isdir("/home/claude") else None); os.chmod(d, 0o755)
    try:
        for item in ITEMS:
            src = os.path.join(ROOT, item)
            if os.path.isdir(src): shutil.copytree(src, os.path.join(d, item))
            elif os.path.exists(src): shutil.copy(src, os.path.join(d, item))
        os.symlink(os.path.abspath(os.path.join(ROOT, "node_modules")), os.path.join(d, "node_modules"))
        if content is not None: open(os.path.join(d, file), "w").write(content)
        try:
            r = subprocess.run(["npx", "vitest", "run", *tests], cwd=d, capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            return "TIMEOUT"
        return re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr) + f"\n[exit {r.returncode}]"
    finally:
        shutil.rmtree(d, ignore_errors=True)

def main():
    needle = " ".join(sys.argv[1:]).lower()
    chosen = [m for m in MUTATIONS if not needle or needle in f"{m[0]} {m[1]}".lower()]
    if not chosen: print(f"No breakage matches {needle!r}"); sys.exit(2)
    for tests in sorted({tuple(m[4]) for m in chosen}):
        out = run_in_copy("", None, list(tests))
        if out == "TIMEOUT" or not tests_ran(out) or failed_count(out) or "[exit 0]" not in out:
            print(f"BASELINE FAILED for {list(tests)} — the unmodified copy does not pass, so nothing below can be trusted.\n" + out[-1500:]); sys.exit(3)
    print("baseline: the unmodified frontend copy passes these tests, so a failure below is caused by the breakage.\n")
    caught = 0; missed = []
    for file, name, old, new, tests in chosen:
        path = os.path.join(ROOT, file); base = open(path).read()
        if old not in base:
            print(f"SKIP (pattern not found): [{file}] {name}"); missed.append(f"[{file}] {name} [pattern missing]"); continue
        out = run_in_copy(file, base.replace(old, new, 1), tests)
        if out == "TIMEOUT": print(f"TIMEOUT (treated as caught)  [{file}] {name}"); caught += 1; continue
        if not tests_ran(out):
            print(f"BROKEN RUN (tests never ran, so this proves nothing)  [{file}] {name}\n" + out[-600:]); missed.append(f"[{file}] {name} [broken run]"); continue
        n = failed_count(out)
        if n > 0: caught += 1; print(f"CAUGHT   ({n:2d} tests failed)  [{file}] {name}")
        else: missed.append(f"[{file}] {name}"); print(f"SURVIVED                  [{file}] {name}")
    print(f"\n{caught} of {len(chosen)} deliberate breakages were caught by the test suite")
    if missed: print("Not caught:", *missed, sep="\n  - "); sys.exit(1)

main()
