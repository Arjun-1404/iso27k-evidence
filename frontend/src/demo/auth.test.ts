// @vitest-environment node
// Signing in, passwords, lock-outs, sessions and two-step sign-in, as the app's screens use them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import { DEMO_PASSWORD } from "./accounts";
import { makeKit, PEOPLE, refusal, TEST_BASE_URL, type Kit } from "./testkit";
import { stepAt, totpAtStep } from "./totp";

let kit: Kit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.stop());

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${TEST_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const login = (email: string, password: string) => post("/auth/login", { email, password });

/** Turns two-step sign-in on for someone and returns what a phone would hold. */
async function enrol(api: ApiClient, password = DEMO_PASSWORD) {
  const { secret } = await api.startMfaEnrollment(password);
  const code = await totpAtStep(secret, stepAt(kit.clock.now));
  const { recoveryCodes } = await api.confirmMfaEnrollment(code);
  return { secret, recoveryCodes };
}
const codeNow = (secret: string, offset = 0) => totpAtStep(secret, stepAt(kit.clock.now) + offset);

describe("signing in", () => {
  it("accepts the demo password, in any letter case for the address", async () => {
    const r = await login("DECLAN.WALSH@Harbourview.Example", DEMO_PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: "lead_auditor", tenantId: null });
    expect(typeof r.body.token).toBe("string");
  });

  it("gives the same answer for a wrong password and for an unknown address", async () => {
    const wrong = await login(PEOPLE.declan, "not-the-password");
    const unknown = await login("nobody@harbourview.example", "whatever-1234");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("locks an account after five wrong passwords for fifteen minutes, then lets it in", async () => {
    for (let i = 0; i < 5; i++) expect((await login(PEOPLE.tom, "wrong-password-" + i)).status).toBe(401);
    expect((await login(PEOPLE.tom, DEMO_PASSWORD)).status).toBe(423); // even the right password is refused now
    kit.clock.now += 14 * 60 * 1000;
    expect((await login(PEOPLE.tom, DEMO_PASSWORD)).status).toBe(423);
    kit.clock.now += 2 * 60 * 1000;
    expect((await login(PEOPLE.tom, DEMO_PASSWORD)).status).toBe(200);
  });

  it("a request with no session, or a made-up one, is refused", async () => {
    expect(await refusal(kit.anonymous().listTenants())).toMatchObject({ status: 401 });
    const forged = new ApiClient({ baseUrl: TEST_BASE_URL, getToken: async () => "demo.not-a-user.0" });
    expect(await refusal(forged.listTenants())).toMatchObject({ status: 401 });
  });

  it("an invited person who never set a password cannot sign in, and demo invites cannot be accepted", async () => {
    expect((await login("niamh.kelly@harbourview.example", DEMO_PASSWORD)).status).toBe(401);
    const accept = await post("/auth/accept-invite", { token: "x".repeat(20), password: "A-long-enough-pass-1" });
    expect(accept.status).toBe(400);
    expect(accept.body.error.message).toMatch(/demo/i);
  });

  it("forgot-password answers the same for every address and says no email is sent", async () => {
    const a = await post("/auth/forgot-password", { email: PEOPLE.priya });
    const b = await post("/auth/forgot-password", { email: "nobody@example.com" });
    expect(a.status).toBe(202);
    expect(a.body).toEqual(b.body);
    expect(a.body.message).toMatch(/demo/i);
  });
});

describe("changing the password", () => {
  it("needs the current password, rejects weak or unchanged ones, and signs the person out elsewhere", async () => {
    const first = await kit.as(PEOPLE.priya);
    expect(await refusal(first.changePassword("wrong-password-1", "A-new-long-password-1"))).toMatchObject({ status: 403, code: "INVALID_PASSWORD" });
    expect(await refusal(first.changePassword(DEMO_PASSWORD, "short"))).toMatchObject({ status: 422, code: "WEAK_PASSWORD" });
    expect(await refusal(first.changePassword(DEMO_PASSWORD, DEMO_PASSWORD))).toMatchObject({ status: 422, code: "SAME_PASSWORD" });

    const second = await kit.as(PEOPLE.priya); // another device
    const fresh = await first.changePassword(DEMO_PASSWORD, "A-new-long-password-1");
    expect(fresh.token).toBeTruthy();
    expect(await refusal(second.listTenants())).toMatchObject({ status: 401 }); // the other session ended
    expect(await refusal(first.listTenants())).toMatchObject({ status: 401 }); // and so did the one that asked: it carries on with the new token
    const carryOn = new ApiClient({ baseUrl: TEST_BASE_URL, getToken: async () => fresh.token });
    expect(await carryOn.listTenants()).toHaveLength(1);
    expect((await login(PEOPLE.priya, DEMO_PASSWORD)).status).toBe(401);
    expect((await login(PEOPLE.priya, "A-new-long-password-1")).status).toBe(200);
  });
});

describe("two-step sign-in", () => {
  it("is off to begin with, can be turned on with a real authenticator code, and then asks for one at sign-in", async () => {
    const api = await kit.as(PEOPLE.declan);
    expect(await api.getMfaStatus()).toMatchObject({ enabled: false, recoveryRemaining: 0, required: false, available: true });

    expect(await refusal(api.startMfaEnrollment("wrong-password-1"))).toMatchObject({ status: 403 });
    const { secret, otpauthUri } = await api.startMfaEnrollment(DEMO_PASSWORD);
    expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(await refusal(api.confirmMfaEnrollment("000000"))).toMatchObject({ status: 403, code: "INVALID_CODE" });
    const { recoveryCodes } = await api.confirmMfaEnrollment(await codeNow(secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(await api.getMfaStatus()).toMatchObject({ enabled: true, recoveryRemaining: 10 });

    const first = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect(first.body.mfaRequired).toBe(true);
    expect(first.body.token).toBeUndefined(); // not signed in until the second step
    kit.clock.now += 30_000; // the code that turned it on cannot be used again, so the phone shows the next one
    const second = await post("/auth/mfa/verify", { mfaToken: first.body.mfaToken, code: await codeNow(secret) });
    expect(second.status).toBe(200);
    expect(second.body.token).toBeTruthy();
  });

  it("a code works only once", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { secret } = await enrol(api);
    kit.clock.now += 30_000;
    const code = await codeNow(secret);
    const a = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code })).status).toBe(200);
    const b = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: b.body.mfaToken, code })).status).toBe(401);
  });

  it("allows a code from the neighbouring thirty seconds, but not from further away", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { secret } = await enrol(api);
    kit.clock.now += 60_000;
    const a = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: await codeNow(secret, -1) })).status).toBe(200);
    kit.clock.now += 120_000;
    const b = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: b.body.mfaToken, code: await codeNow(secret, -3) })).status).toBe(401);
  });

  it("a recovery code works once and is counted off", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { recoveryCodes } = await enrol(api);
    const a = await login(PEOPLE.declan, DEMO_PASSWORD);
    const ok = await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: recoveryCodes[0]! });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodeUsed).toBe(true);
    const again = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: again.body.mfaToken, code: recoveryCodes[0]! })).status).toBe(401);
    const signedIn = new ApiClient({ baseUrl: TEST_BASE_URL, getToken: async () => ok.body.token });
    expect((await signedIn.getMfaStatus()).recoveryRemaining).toBe(9);
  });

  it("five wrong codes lock two-step sign-in for fifteen minutes; a badly formed code is not counted", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { secret } = await enrol(api);
    const a = await login(PEOPLE.declan, DEMO_PASSWORD);
    for (let i = 0; i < 3; i++) expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: "12" })).status).toBe(400); // wrong shape: free
    for (let i = 0; i < 4; i++) expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: "000000" })).status).toBe(401);
    expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: "000000" })).status).toBe(423);
    kit.clock.now += 30_000;
    expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: await codeNow(secret) })).status).toBe(423); // right code, still locked
    kit.clock.now += 16 * 60 * 1000;
    const b = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: b.body.mfaToken, code: await codeNow(secret) })).status).toBe(200);
  });

  it("the half-signed-in ticket expires and cannot be forged", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { secret } = await enrol(api);
    const a = await login(PEOPLE.declan, DEMO_PASSWORD);
    kit.clock.now += 6 * 60 * 1000;
    expect((await post("/auth/mfa/verify", { mfaToken: a.body.mfaToken, code: await codeNow(secret) })).status).toBe(401);
    expect((await post("/auth/mfa/verify", { mfaToken: "demo-mfa.whoever.99999999999999", code: "123456" })).status).toBe(401);
  });

  it("turning it off needs the password and a code; the same for new recovery codes (which replace the old ones)", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { secret, recoveryCodes } = await enrol(api);
    kit.clock.now += 30_000;
    expect(await refusal(api.regenerateRecoveryCodes("wrong-password-1", await codeNow(secret)))).toMatchObject({ status: 403 });
    const fresh = await api.regenerateRecoveryCodes(DEMO_PASSWORD, await codeNow(secret));
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toEqual(recoveryCodes);
    const old = await login(PEOPLE.declan, DEMO_PASSWORD);
    expect((await post("/auth/mfa/verify", { mfaToken: old.body.mfaToken, code: recoveryCodes[1]! })).status).toBe(401);

    kit.clock.now += 30_000;
    await api.disableMfa(DEMO_PASSWORD, await codeNow(secret));
    expect((await api.getMfaStatus()).enabled).toBe(false);
    expect((await login(PEOPLE.declan, DEMO_PASSWORD)).body.token).toBeTruthy();
  });

  it("changing the password needs a code too when two-step is on, and a typo costs no code", async () => {
    const api = await kit.as(PEOPLE.declan);
    const { secret } = await enrol(api);
    kit.clock.now += 30_000;
    expect(await refusal(api.changePassword(DEMO_PASSWORD, "A-new-long-password-1"))).toMatchObject({ status: 400, code: "MFA_CODE_REQUIRED" });
    const code = await codeNow(secret);
    expect(await refusal(api.changePassword(DEMO_PASSWORD, "short", code))).toMatchObject({ code: "WEAK_PASSWORD" }); // refused before the code was looked at
    const changed = await api.changePassword(DEMO_PASSWORD, "A-new-long-password-1", code); // so the same code still works
    expect(changed.token).toBeTruthy();
  });
});

describe("the organisation's two-step policy", () => {
  it("an admin cannot require it before turning it on for themself; once required, others are shut out until they set it up", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    expect(await aoife.getMfaPolicy()).toMatchObject({ policy: "off", available: true });
    expect(await refusal(aoife.setMfaPolicy("staff"))).toMatchObject({ status: 409, code: "MFA_ADMIN_NEEDS_MFA" });
    await enrol(aoife);
    const set = await aoife.setMfaPolicy("staff");
    expect(set.policy).toBe("staff");
    expect(set.staff.enrolled).toBe(1);

    // staff must now use it: Declan can reach only the two-step setup until he has done it
    const declan = await kit.as(PEOPLE.declan);
    expect(await declan.getMfaStatus()).toMatchObject({ enabled: false, required: true });
    expect(await refusal(declan.listTenants())).toMatchObject({ status: 403, code: "MFA_SETUP_REQUIRED" });
    expect(await refusal(declan.getDashboard("whatever"))).toMatchObject({ status: 403, code: "MFA_SETUP_REQUIRED" });
    await enrol(declan);
    expect(await declan.listTenants()).toHaveLength(2);

    // the client's people are not covered by "staff"
    const priya = await kit.as(PEOPLE.priya);
    expect(await priya.listTenants()).toHaveLength(1);
    // and someone covered by the policy cannot switch it off
    kit.clock.now += 30_000;
    expect(await refusal(declan.disableMfa(DEMO_PASSWORD, "000000"))).toMatchObject({ status: 403, code: "MFA_REQUIRED_BY_POLICY" });
  });

  it("an admin can reset someone's two-step sign-in, which signs that person out everywhere", async () => {
    const declan = await kit.as(PEOPLE.declan);
    await enrol(declan);
    const aoife = await kit.as(PEOPLE.aoife);
    const declanId = (await aoife.listOrgUsers()).find((u) => u.email === PEOPLE.declan)!.id;
    expect((await aoife.listOrgUsers()).find((u) => u.id === declanId)!.mfaEnabled).toBe(true);
    expect(await aoife.resetUserMfa(declanId)).toEqual({ reset: true });
    expect(await refusal(declan.listTenants())).toMatchObject({ status: 401 });
    expect((await login(PEOPLE.declan, DEMO_PASSWORD)).body.token).toBeTruthy(); // straight in: nothing to enter any more
    expect(await aoife.resetUserMfa(declanId)).toEqual({ reset: false });
    const again = await kit.as(PEOPLE.declan);
    expect(await refusal(again.resetUserMfa(declanId))).toMatchObject({ status: 403 });
  });
});
