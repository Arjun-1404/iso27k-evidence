import type { Request, Response, NextFunction } from "express";

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Recursively converts snake_case object keys to camelCase. Leaves arrays, Dates, and primitives
 *  alone; only plain objects have their keys rewritten. */
export function camelizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeDeep);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [toCamel(k), camelizeDeep(v)]));
  }
  return value;
}

/**
 * Wraps res.json so every response is camelCased before it leaves the server. This is what lets
 * service functions return whatever shape is natural for their SQL (sometimes a manually-mapped
 * object, sometimes a raw `RETURNING ...` row) while the API's actual contract — what a frontend or
 * any other client sees — stays consistently camelCase either way.
 */
export function camelCaseJson(_req: Request, res: Response, next: NextFunction) {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => original(camelizeDeep(body))) as Response["json"];
  next();
}
