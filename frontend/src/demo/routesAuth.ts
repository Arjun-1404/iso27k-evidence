// Signing in, passwords, and two-step sign-in (the real server's routes/auth.ts, account.ts, mfa.ts and platform.ts).

import type { MfaPolicy, OrgMfaPolicy } from "../api/types";
import type { Ctx, DemoBackend, Route } from "./backend";
import { asObject, DemoHttpError, enumField, fail, textField } from "./http";
import { checkPasswordStrength } from "./rules";
import type { DemoUser } from "./state";
import { classifyCode, generateRecoveryCodes, generateTotpSecret, matchTotp, normalizeRecoveryCode, otpauthUri } from "./totp";

export const MFA_ISSUER = "ISO 27001 evidence portal (demo)";
const LOCK_MS = 15 * 60 * 1000;
const MFA_TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const FAILED_LIMIT = 5;

export const FORGOT_PASSWORD_MESSAGE =
  "This is a demo, so no email is sent. On a real installation, if an account exists for that address, a link to reset the password arrives by email; it works once and expires in 1 hour.";

const GENERIC_LOGIN_ERROR = "Incorrect email or password.";
const FORMAT_HELP = "Enter the 6-digit code from your authenticator app, or one of your recovery codes.";
const expired = () => fail(401, "INVALID_MFA_TOKEN", "Your sign-in has expired. Please enter your password again.");
const tooManyAttempts = () => fail(423, "ACCOUNT_LOCKED", "Too many failed attempts. Please try again in a few minutes.");

const looksLikeEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

function emailField(body: Record<string, unknown>, key: string): string {
  const v = textField(body, key, { max: 254 });
  if (!looksLikeEmail(v)) fail(400, "VALIDATION", `${key}: Invalid email address`);
  return v;
}

const sessionFor = (api: DemoBackend, user: DemoUser) => ({ token: api.sessionToken(user), userId: user.id, role: user.role, tenantId: user.tenantId });

/** "Confirm it's you": a wrong password counts toward the same lock-out as the sign-in page, and answers 403 (not 401) so a typo doesn't sign the person out. */
function confirmPassword(api: DemoBackend, user: DemoUser, password: string): void {
  if (!user.password) fail(409, "NO_LOCAL_PASSWORD", "This account signs in through your organisation's single sign-on, so its password and two-step sign-in are managed there.");
  if (user.lockedUntil && user.lockedUntil > api.now()) fail(423, "ACCOUNT_LOCKED", "Too many failed attempts. Please try again in a few minutes.");
  if (user.password !== password) {
    recordFailure(api, user);
    fail(403, "INVALID_PASSWORD", "Incorrect password.");
  }
}

function recordFailure(api: DemoBackend, user: DemoUser): void {
  user.failedLogins += 1;
  if (user.failedLogins >= FAILED_LIMIT) user.lockedUntil = api.now() + LOCK_MS;
}

/**
 * Checks a typed code (authenticator or recovery) for someone with two-step sign-in on. A badly formatted code is
 * refused first and not counted. A code works once; five wrong ones lock two-step sign-in for 15 minutes.
 * `failStatus` is 401 at sign-in and 403 for a signed-in person confirming a change (a 401 would sign them out for a typo).
 */
async function verifySecondStep(api: DemoBackend, user: DemoUser, rawCode: string, failStatus: 401 | 403): Promise<{ usedRecoveryCode: boolean }> {
  const typed = classifyCode(rawCode);
  if (!typed) fail(400, "INVALID_CODE_FORMAT", FORMAT_HELP);
  const mfa = user.mfa;
  if (!mfa || !mfa.confirmed) fail(409, "MFA_NOT_ENABLED", "Two-step sign-in is not turned on for this account.");
  const locked = () => fail(423, "MFA_LOCKED", "Too many incorrect codes. Two-step sign-in is locked for this account for 15 minutes.");
  if (mfa.lockedUntil && mfa.lockedUntil > api.now()) locked();

  let ok = false;
  let step: number | null = null;
  if (typed.kind === "totp") {
    step = await matchTotp(mfa.secret, typed.code, api.now());
    ok = step !== null && (mfa.lastStep === null || step > mfa.lastStep);
  } else {
    const at = mfa.recoveryCodes.indexOf(typed.code);
    ok = at >= 0;
    if (ok) mfa.recoveryCodes.splice(at, 1);
  }

  if (ok) {
    mfa.failedCodes = 0;
    mfa.lockedUntil = null;
    if (step !== null) mfa.lastStep = step;
    if (typed.kind === "recovery") api.log(user, "user.mfa_recovery_code_used", user.tenantId, "user", user.id, {});
    return { usedRecoveryCode: typed.kind === "recovery" };
  }
  mfa.failedCodes += 1;
  if (mfa.failedCodes >= FAILED_LIMIT) {
    mfa.lockedUntil = api.now() + LOCK_MS;
    mfa.failedCodes = 0;
    api.log(user, "user.mfa_locked", user.tenantId, "user", user.id, {});
    locked();
  }
  return fail(failStatus, "INVALID_CODE", "That code isn't right. Check the latest code in your authenticator app, or use a recovery code.");
}

function newRecoverySet(): { shown: string[]; kept: string[] } {
  const shown = generateRecoveryCodes();
  return { shown, kept: shown.map((c) => normalizeRecoveryCode(c)!) };
}

/** The two-step status a person sees about themselves. */
const mfaStatus = (api: DemoBackend, user: DemoUser) => ({
  enabled: api.mfaEnabled(user),
  recoveryRemaining: api.mfaEnabled(user) ? user.mfa!.recoveryCodes.length : 0,
  available: true,
  required: api.mfaRequired(user),
});

function orgPolicy(api: DemoBackend): OrgMfaPolicy {
  const people = api.state.users.filter((u) => u.status === "active" && u.password !== "");
  const count = (list: DemoUser[]) => ({ total: list.length, enrolled: list.filter((u) => api.mfaEnabled(u)).length });
  return { policy: api.state.org.mfaPolicy, available: true, staff: count(people.filter((u) => u.tenantId === null)), everyone: count(people) };
}

export function authRoutes(): Route[] {
  return [
    // ---- signed-out ------------------------------------------------------------------------------------------------
    {
      method: "POST", path: "/auth/login", open: true,
      handle: ({ api, req }) => {
        const b = asObject(req.body);
        const email = emailField(b, "email");
        const password = textField(b, "password", { max: 1024 });
        const user = api.userByEmail(email);
        if (!user || !user.password || user.status !== "active") fail(401, "INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR);
        if (user.lockedUntil && user.lockedUntil > api.now()) tooManyAttempts();
        if (user.password !== password) {
          recordFailure(api, user);
          fail(401, "INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR);
        }
        // With two-step sign-in on, this is only the first half: the person is not counted as signed in yet.
        if (api.mfaEnabled(user)) return { json: { mfaRequired: true, mfaToken: `demo-mfa.${user.id}.${api.now() + MFA_TOKEN_LIFETIME_MS}` } };
        user.failedLogins = 0;
        user.lockedUntil = null;
        return { json: sessionFor(api, user) };
      },
    },
    {
      method: "POST", path: "/auth/mfa/verify", open: true,
      handle: async ({ api, req }) => {
        const b = asObject(req.body);
        const token = textField(b, "mfaToken", { max: 2048 });
        const code = textField(b, "code", { max: 64 });
        const m = token.match(/^demo-mfa\.([^.]+)\.(\d+)$/);
        const user = m ? api.user(m[1]) : undefined;
        if (!user || Number(m![2]) < api.now() || user.status !== "active" || !user.password) expired();
        if (user!.lockedUntil && user!.lockedUntil! > api.now()) tooManyAttempts();
        let used: { usedRecoveryCode: boolean };
        try {
          used = await verifySecondStep(api, user!, code, 401);
        } catch (e) {
          // Two-step sign-in was switched off after the password step (an admin reset): start again from the top.
          if (e instanceof DemoHttpError && e.code === "MFA_NOT_ENABLED") expired();
          throw e;
        }
        user!.failedLogins = 0;
        user!.lockedUntil = null;
        return { json: used.usedRecoveryCode ? { ...sessionFor(api, user!), recoveryCodeUsed: true } : sessionFor(api, user!) };
      },
    },
    {
      // A demo has no inbox, so an invite link can't reach anyone: say so rather than pretend.
      method: "POST", path: "/auth/accept-invite", open: true,
      handle: ({ req }) => {
        const b = asObject(req.body);
        textField(b, "token", { max: 4096 });
        const check = checkPasswordStrength(textField(b, "password", { max: 1024 }));
        if (!check.ok) fail(422, "WEAK_PASSWORD", check.reason);
        return fail(400, "INVALID_INVITE", "This invite link is invalid or has expired. (This is a demo: no invitation emails are sent.)");
      },
    },
    {
      method: "POST", path: "/auth/forgot-password", open: true,
      handle: ({ req }) => {
        emailField(asObject(req.body), "email");
        return { status: 202, json: { message: FORGOT_PASSWORD_MESSAGE } };
      },
    },
    {
      method: "POST", path: "/auth/reset-password", open: true,
      handle: ({ req }) => {
        const b = asObject(req.body);
        textField(b, "token", { max: 256 });
        const check = checkPasswordStrength(textField(b, "password", { max: 1024 }));
        if (!check.ok) fail(422, "WEAK_PASSWORD", check.reason);
        return fail(400, "INVALID_RESET", "This reset link is invalid or has expired. Request a new one. (This is a demo: no reset emails are sent.)");
      },
    },

    // ---- the signed-in person's own account ----------------------------------------------------------------------------------
    {
      method: "POST", path: "/auth/change-password",
      handle: async ({ api, user, req }) => {
        const b = asObject(req.body);
        const current = textField(b, "currentPassword", { max: 1024 });
        const next = textField(b, "newPassword", { max: 1024 });
        const code = textField(b, "code", { max: 64, optional: true });
        // The cheap checks that cannot use anything up come BEFORE a one-time code is checked: a typo never costs a code.
        const strength = checkPasswordStrength(next);
        if (!strength.ok) fail(422, "WEAK_PASSWORD", strength.reason);
        const twoStep = api.mfaEnabled(user);
        if (twoStep && !code) fail(400, "MFA_CODE_REQUIRED", "Enter a code from your authenticator app (or one of your recovery codes) to change your password.");
        confirmPassword(api, user, current);
        if (next === user.password) fail(422, "SAME_PASSWORD", "Choose a password that is different from your current one.");
        if (twoStep) await verifySecondStep(api, user, code!, 403);
        user.password = next;
        user.failedLogins = 0;
        user.lockedUntil = null;
        user.sessionEpoch += 1; // every other session of theirs ends; the one handed back is the one they carry on with
        api.log(user, "user.password_changed", user.tenantId, "user", user.id, {});
        return { json: sessionFor(api, user) };
      },
    },

    // ---- two-step sign-in, managed by the person themselves -------------------------------------------------------------------
    { method: "GET", path: "/auth/mfa", mfaSetup: true, handle: ({ api, user }) => ({ json: mfaStatus(api, user) }) },
    {
      method: "POST", path: "/auth/mfa/enroll", mfaSetup: true,
      handle: ({ api, user, req }) => {
        confirmPassword(api, user, textField(asObject(req.body), "password", { max: 1024 }));
        if (api.mfaEnabled(user)) fail(409, "MFA_ALREADY_ENABLED", "Two-step sign-in is already turned on for this account.");
        const secret = generateTotpSecret();
        user.mfa = { secret, confirmed: false, recoveryCodes: [], lastStep: null, failedCodes: 0, lockedUntil: null };
        return { json: { secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer: MFA_ISSUER }) } };
      },
    },
    {
      method: "POST", path: "/auth/mfa/enroll/confirm", mfaSetup: true,
      handle: async ({ api, user, req }) => {
        const typed = classifyCode(textField(asObject(req.body), "code", { max: 64 }));
        if (!typed || typed.kind !== "totp") fail(400, "INVALID_CODE_FORMAT", "Enter the 6-digit code from your authenticator app.");
        const pending = user.mfa && !user.mfa.confirmed ? user.mfa : null;
        if (!pending) fail(409, "NO_ENROLLMENT", "Start setting up two-step sign-in first.");
        const step = await matchTotp(pending!.secret, typed!.code, api.now());
        if (step === null) fail(403, "INVALID_CODE", "That code didn't match. Check the latest code in your authenticator app (and that your phone's clock is automatic), then try again.");
        const { shown, kept } = newRecoverySet();
        pending!.confirmed = true;
        pending!.lastStep = step;
        pending!.recoveryCodes = kept;
        api.log(user, "user.mfa_enabled", user.tenantId, "user", user.id, {});
        return { json: { recoveryCodes: shown } };
      },
    },
    {
      method: "POST", path: "/auth/mfa/disable",
      handle: async ({ api, user, req }) => {
        const b = asObject(req.body);
        const password = textField(b, "password", { max: 1024 });
        const code = textField(b, "code", { max: 64 });
        if (!api.mfaEnabled(user)) fail(409, "MFA_NOT_ENABLED", "Two-step sign-in is not turned on for this account.");
        // Refused before a password is checked or a one-time code is spent: it cannot happen, so don't make the person prove anything for it.
        if (api.mfaRequired(user)) fail(403, "MFA_REQUIRED_BY_POLICY", "Your organisation requires two-step sign-in, so it cannot be turned off.");
        confirmPassword(api, user, password);
        await verifySecondStep(api, user, code, 403);
        user.mfa = null;
        api.log(user, "user.mfa_disabled", user.tenantId, "user", user.id, {});
        return { json: { ok: true } };
      },
    },
    {
      method: "POST", path: "/auth/mfa/recovery-codes",
      handle: async ({ api, user, req }) => {
        const b = asObject(req.body);
        const password = textField(b, "password", { max: 1024 });
        const code = textField(b, "code", { max: 64 });
        if (!api.mfaEnabled(user)) fail(409, "MFA_NOT_ENABLED", "Two-step sign-in is not turned on for this account.");
        confirmPassword(api, user, password);
        await verifySecondStep(api, user, code, 403);
        const { shown, kept } = newRecoverySet();
        user.mfa!.recoveryCodes = kept;
        api.log(user, "user.mfa_recovery_codes_regenerated", user.tenantId, "user", user.id, {});
        return { json: { recoveryCodes: shown } };
      },
    },

    // ---- the organisation's two-step policy (organisation admins) ---------------------------------------------------------------
    {
      method: "GET", path: "/org/mfa-policy",
      handle: ({ api, user }) => {
        if (user.role !== "org_admin") fail(403, "FORBIDDEN_ROLE", "Only an organisation admin can see or change the two-step sign-in policy.");
        return { json: orgPolicy(api) };
      },
    },
    {
      method: "PUT", path: "/org/mfa-policy",
      handle: ({ api, user, req }) => {
        if (user.role !== "org_admin") fail(403, "FORBIDDEN_ROLE", "Only an organisation admin can change the two-step sign-in policy.");
        const policy: MfaPolicy = enumField(asObject(req.body), "policy", ["off", "staff", "everyone"] as const);
        if (policy !== "off" && !api.mfaEnabled(user)) {
          fail(409, "MFA_ADMIN_NEEDS_MFA", "Turn on two-step sign-in for your own account first, so you cannot lock yourself out.");
        }
        const before = api.state.org.mfaPolicy;
        if (before !== policy) {
          api.state.org.mfaPolicy = policy;
          api.log(user, "org.mfa_policy_changed", null, "org", api.state.org.id, { from: before, to: policy });
        }
        return { json: orgPolicy(api) };
      },
    },
    {
      method: "POST", path: "/users/:id/reset-mfa",
      handle: ({ api, user, params }: Ctx) => {
        if (user.role !== "org_admin") fail(403, "FORBIDDEN_ROLE", "Only an organisation admin can reset someone else's two-step sign-in.");
        if (params.id === user.id) fail(403, "FORBIDDEN_ROLE", "To turn off your own two-step sign-in, use Security settings (it needs your password and a code).");
        const target = api.user(params.id);
        if (!target) fail(403, "FORBIDDEN_ROLE", "You don't have access to do that.");
        const wasOn = api.mfaEnabled(target!);
        const had = target!.mfa !== null;
        target!.mfa = null;
        if (wasOn) {
          target!.sessionEpoch += 1; // signed out everywhere
          api.log(user, "user.mfa_reset", target!.tenantId, "user", target!.id, {});
        }
        return { json: { reset: had && wasOn } };
      },
    },

    // ---- the installation owner's server settings: nothing to configure in a demo ---------------------------------------------------
    { method: "GET", path: "/platform/owner", handle: () => ({ json: { owner: false } }) },
    { method: "GET", path: "/platform/settings", handle: () => fail(403, "FORBIDDEN_ROLE", "Server settings are not part of the demo.") },
    { method: "PUT", path: "/platform/settings/:group", handle: () => fail(403, "FORBIDDEN_ROLE", "Server settings are not part of the demo.") },
    { method: "POST", path: "/platform/settings/:group/clear", handle: () => fail(403, "FORBIDDEN_ROLE", "Server settings are not part of the demo.") },
    { method: "POST", path: "/platform/settings/email/test", handle: () => fail(403, "FORBIDDEN_ROLE", "Server settings are not part of the demo.") },
    { method: "POST", path: "/platform/settings/scanner/test", handle: () => fail(403, "FORBIDDEN_ROLE", "Server settings are not part of the demo.") },
  ];
}
