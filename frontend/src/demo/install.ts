// Makes the web app talk to the pretend server instead of the network. The app calls fetch() with addresses that start
// with a made-up address that can never resolve (".invalid" is reserved for exactly that); this wrapper catches those and
// answers them from the pretend server. Anything else is passed to the browser's real fetch untouched.

import type { DemoBackend } from "./backend";
import type { DemoResponse } from "./http";

export interface InstallOptions {
  /** The address the app was told its API lives at. */
  baseUrl: string;
  /** A little pretend network delay, so loading states are seen the way they would be on a real server. */
  latencyMs?: number;
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

function toResponse(res: DemoResponse): Response {
  if (res.status === 204) return new Response(null, { status: 204 });
  if (res.blob) return new Response(res.blob, { status: res.status, headers: res.headers });
  return new Response(JSON.stringify(res.json ?? null), { status: res.status, headers: { "Content-Type": "application/json", ...res.headers } });
}

const bearer = (headers: Headers): string | null => headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? null;

/** Starts answering the app's requests from `backend`. Returns a function that puts the real fetch back. */
export function installDemoFetch(backend: DemoBackend, opts: InstallOptions): () => void {
  const original = globalThis.fetch;
  const realFetch = (input: RequestInfo | URL, init?: RequestInit) => original.call(globalThis, input, init);
  const prefix = opts.baseUrl.replace(/\/+$/, "");

  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof input === "object" && "url" in input ? (input as Request) : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : request!.url;
    if (!url.startsWith(`${prefix}/`)) return realFetch(input, init);

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const path = url.slice(prefix.length).split("?")[0];
    const headers = new Headers(init?.headers ?? request?.headers);
    const signal = init?.signal ?? request?.signal;

    let body: unknown;
    let upload: Blob | undefined;
    const raw = init?.body;
    if (typeof raw === "string") {
      try { body = JSON.parse(raw); }
      catch { return toResponse({ status: 400, json: { error: { code: "VALIDATION", message: "The request body is not valid JSON." } } }); }
    } else if (raw instanceof Blob) {
      upload = raw;
    }

    if (opts.latencyMs) await sleep(opts.latencyMs, signal);
    const answer = await backend.handle({ method, path, token: bearer(headers), body, upload });
    if (signal?.aborted) throw abortError();
    return toResponse(answer);
  };

  globalThis.fetch = demoFetch as typeof fetch;
  return () => { globalThis.fetch = original; };
}
