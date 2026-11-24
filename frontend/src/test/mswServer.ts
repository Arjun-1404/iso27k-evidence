import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const API_BASE = "http://test-api.local";

/**
 * Handlers every test starts with: things the app asks in the background that most tests aren't about.
 *  - "am I the installation owner?" is asked once an org admin signs in;
 *  - the access answer (what a person's custom role takes away) is asked once the page knows who is signed in;
 *  - the "Assigned to" section and the bulk-assign panel look up the client's people and who a control is assigned to;
 *  - the dashboard's grid of tiles asks for the audit's controls.
 * A test that cares overrides them with server.use(...).
 */
const defaults = [
  http.get(`${API_BASE}/platform/owner`, () => HttpResponse.json({ owner: false })),
  http.get(`${API_BASE}/tenants/:id/users`, () => HttpResponse.json([])),
  http.get(`${API_BASE}/controls/:id/assignments`, () => HttpResponse.json([])),
  // "what does my custom role take away?": nothing, unless a test says otherwise.
  http.get(`${API_BASE}/me/access`, () => HttpResponse.json({ role: "lead_auditor", customRole: null, denied: [] })),
  // The dashboard asks for the audit's controls (to draw its grid of tiles); most dashboard tests are about the numbers.
  http.get(`${API_BASE}/audits/:id/controls`, () => HttpResponse.json([])),
];
export const server = setupServer(...defaults);

export { http, HttpResponse };

/** JSON helper matching the real API's success/error envelope. */
export const json = (body: unknown, status = 200) => HttpResponse.json(body as Record<string, unknown>, { status });
export const apiError = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });
