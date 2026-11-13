// The small vocabulary the pretend server's pieces share: what a request and a response look like, how a refusal is
// raised, and the checks that turn a request body into plain values (with the same kind of message the real server gives).

export class DemoHttpError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "DemoHttpError";
    this.status = status;
    this.code = code;
  }
}

/** Refuses the request. The body the browser sees is `{ error: { code, message } }`, exactly like the real server's. */
export function fail(status: number, code: string, message: string): never {
  throw new DemoHttpError(message, status, code);
}

export interface DemoRequest {
  method: string;
  /** The path after the API's address, without the query string: "/audits/abc/controls". */
  path: string;
  /** The session token the browser sent, or null. */
  token: string | null;
  /** The parsed JSON body, if there was one. */
  body?: unknown;
  /** The raw bytes of an upload (a PUT to an /uploads/ link). */
  upload?: Blob;
}

export interface DemoResponse {
  status: number;
  json?: unknown;
  blob?: Blob;
  headers?: Record<string, string>;
}

export interface RouteResult { status?: number; json?: unknown; blob?: Blob; headers?: Record<string, string> }

export const FORBIDDEN = (): never => fail(403, "FORBIDDEN", "You don't have access to do that.");

// ---- reading a request body ----------------------------------------------------------------------------------------

type Body = Record<string, unknown>;

const describe = (v: unknown) => (v === undefined ? "undefined" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const invalid = (key: string, message: string): never => fail(400, "VALIDATION", `${key}: ${message}`);

export function asObject(body: unknown): Body {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) fail(400, "VALIDATION", "Invalid input: expected object");
  return body as Body;
}

export function textField(b: Body, key: string, opts: { min?: number; max: number }): string;
export function textField(b: Body, key: string, opts: { min?: number; max: number; optional: true }): string | undefined;
export function textField(b: Body, key: string, opts: { min?: number; max: number; optional?: boolean }): string | undefined {
  const v = b[key];
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== "string") return invalid(key, `Invalid input: expected string, received ${describe(v)}`);
  const min = opts.min ?? 1;
  if (v.length < min) return invalid(key, `Too small: expected string to have >=${min} characters`);
  if (v.length > opts.max) return invalid(key, `Too big: expected string to have <=${opts.max} characters`);
  return v;
}

export function enumField<T extends string>(b: Body, key: string, allowed: readonly T[]): T;
export function enumField<T extends string>(b: Body, key: string, allowed: readonly T[], fallback: T): T;
export function enumField<T extends string>(b: Body, key: string, allowed: readonly T[], fallback?: T): T {
  const v = b[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) return invalid(key, `Invalid option: expected one of ${allowed.map((a) => `"${a}"`).join("|")}`);
  return v as T;
}

export function boolField(b: Body, key: string): boolean {
  const v = b[key];
  if (typeof v !== "boolean") return invalid(key, `Invalid input: expected boolean, received ${describe(v)}`);
  return v;
}

export function stringList(b: Body, key: string, opts: { min?: number; max?: number; item: { max: number } }): string[] {
  const v = b[key];
  if (!Array.isArray(v)) return invalid(key, `Invalid input: expected array, received ${describe(v)}`);
  if (opts.min !== undefined && v.length < opts.min) return invalid(key, `Too small: expected array to have >=${opts.min} items`);
  if (opts.max !== undefined && v.length > opts.max) return invalid(key, `Too big: expected array to have <=${opts.max} items`);
  v.forEach((x, i) => {
    if (typeof x !== "string") invalid(`${key}.${i}`, `Invalid input: expected string, received ${describe(x)}`);
    else if (x.length < 1) invalid(`${key}.${i}`, "Too small: expected string to have >=1 characters");
    else if (x.length > opts.item.max) invalid(`${key}.${i}`, `Too big: expected string to have <=${opts.item.max} characters`);
  });
  return v as string[];
}

export function intField(b: Body, key: string, opts: { min: number; max?: number }): number {
  const v = b[key];
  if (typeof v !== "number" || !Number.isInteger(v)) return invalid(key, `Invalid input: expected int, received ${describe(v)}`);
  if (v < opts.min) return invalid(key, `Too small: expected number to be >=${opts.min}`);
  if (opts.max !== undefined && v > opts.max) return invalid(key, `Too big: expected number to be <=${opts.max}`);
  return v;
}
