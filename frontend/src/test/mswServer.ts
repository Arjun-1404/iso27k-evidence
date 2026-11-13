import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const API_BASE = "http://test-api.local";

/**
 * Handlers every test starts with: things the app asks in the background that most tests aren't about.
 *  - "am I the installation owner?" is asked once an org admin signs in;
 *  - the "Assigned to" section and the bulk-assign panel look up the client's people and who a control is assigned to.
 * A test that cares overrides them with server.use(...).
 */
const defaults = [
  http.get(`${API_BASE}/platform/owner`, () => HttpResponse.json({ owner: false })),
  http.get(`${API_BASE}/tenants/:id/users`, () => HttpResponse.json([])),
  http.get(`${API_BASE}/controls/:id/assignments`, () => HttpResponse.json([])),
];
export const server = setupServer(...defaults);

export { http, HttpResponse };

/** JSON helper matching the real API's success/error envelope. */
export const json = (body: unknown, status = 200) => HttpResponse.json(body as Record<string, unknown>, { status });
export const apiError = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });
