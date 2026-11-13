import dns from "node:dns";
import net from "node:net";

/**
 * Keeps an address that an organisation's administrator types in (the web address of an S3 service) from being used to
 * make the portal's server talk to things it should not: the cloud provider's secret-handing "metadata" address, the
 * database next door, other services on the server's own network.
 *
 *  - Some addresses are never acceptable: the link-local range that cloud metadata services live in (169.254.x.x and
 *    its IPv6 cousins), "this host" (0.0.0.0), multicast and other reserved ranges.
 *  - Private-network addresses (10.x, 172.16–31.x, 192.168.x, loopback, fc00::/7, 100.64.0.0/10) are refused too, UNLESS
 *    the owner of the installation has allowed them. They are exactly where an organisation's own MinIO or Ceph usually
 *    lives, so the owner switches this on (STORAGE_ALLOW_PRIVATE_ADDRESSES=true) when the installation is the
 *    organisation's own; a shared installation leaves it off.
 *
 * The check is made twice: when the address is saved (to give a clear message), and again when the connection is
 * actually opened (`guardedLookup`), so a name that points somewhere harmless at first and somewhere harmful later
 * ("DNS rebinding") gets nowhere.
 */

export type AddressVerdict = "ok" | "private" | "never";

function v4Bytes(addr: string): number[] | null {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

/** IPv6 → its 8 groups as numbers (handles "::" and a trailing dotted IPv4), or null if it isn't one. */
function v6Groups(addr: string): number[] | null {
  let a = addr.split("%")[0].toLowerCase();
  if (!net.isIPv6(a)) return null;
  const tail = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const b = v4Bytes(tail[1]);
    if (!b) return null;
    a = a.slice(0, -tail[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const [head, rest] = a.split("::");
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = rest === undefined ? [] : Array(8 - h.length - r.length).fill("0");
  const groups = [...h, ...fill, ...r].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function classifyAddress(addr: string): AddressVerdict {
  const v4 = v4Bytes(addr);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a >= 224) return "never";                      // "this host", multicast, reserved, broadcast
    if (a === 169 && b === 254) return "never";                   // link-local: cloud metadata services
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "ok";
  }
  const g = v6Groups(addr);
  if (!g) return "never";                                         // not an address at all
  if (g.every((x) => x === 0)) return "never";                    // ::
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {   // ::ffff:a.b.c.d — judge the IPv4 address inside
    return classifyAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && g[7] === 1)) return "never";   // ::a.b.c.d (deprecated IPv4-compatible)
  if ((g[0] & 0xffc0) === 0xfe80) return "never";                 // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return "never";                 // multicast
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return "never";         // AWS's IPv6 metadata service
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "private";   // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return "private";               // fc00::/7 unique local
  return "ok";
}

export interface AddressPolicy { allowPrivate: boolean }

const why = (verdict: AddressVerdict, host: string) => verdict === "never"
  ? `The address ${host} is not allowed (it is a reserved or internal-service address).`
  : `The address ${host} is on a private network. The owner of this installation has to allow that first: set STORAGE_ALLOW_PRIVATE_ADDRESSES=true in the server's .env file and restart.`;

export class AddressNotAllowedError extends Error {
  constructor(message: string) { super(message); this.name = "AddressNotAllowedError"; }
}

/** `dns.lookup`-shaped function that refuses to hand out an address the policy forbids. */
export function guardedLookup(policy: AddressPolicy, resolve: typeof dns.lookup = dns.lookup): typeof dns.lookup {
  const lookup = ((hostname: string, options: dns.LookupOptions | number | undefined, callback: (...args: unknown[]) => void) => {
    const opts: dns.LookupOptions = typeof options === "number" ? { family: options } : { ...(options ?? {}) };
    resolve(hostname, { ...opts, all: true }, (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[] | string) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      for (const a of list) {
        const verdict = classifyAddress(a.address);
        if (verdict === "never" || (verdict === "private" && !policy.allowPrivate)) return callback(new AddressNotAllowedError(why(verdict, hostname)));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as typeof dns.lookup;
  return lookup;
}

/**
 * Checks an address as typed: web address syntax, http(s) only, no password in it, and the host (looked up now) allowed.
 * Returns the cleaned-up address (no trailing slash). Throws AddressNotAllowedError with a message for the administrator.
 */
export async function checkEndpoint(raw: string, policy: AddressPolicy, resolve: typeof dns.lookup = dns.lookup): Promise<string> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new AddressNotAllowedError("That is not a valid web address. Write it like https://s3.example.com or http://minio.local:9000."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AddressNotAllowedError("The address must start with https:// (or http:// for a service on your own network).");
  if (u.username || u.password) throw new AddressNotAllowedError("Don't put the access key in the address. Enter it in the access key fields.");
  if (u.search || u.hash) throw new AddressNotAllowedError("The address should be just the service, with nothing after the host and port.");
  if (u.pathname !== "/" && u.pathname !== "") throw new AddressNotAllowedError("The address should be just the service (https://host:port), without a path. Enter the bucket name separately.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
    if (!policy.allowPrivate) throw new AddressNotAllowedError(why("private", host));
  }
  const literal = net.isIP(host) !== 0;
  const addresses = literal ? [host] : await new Promise<string[]>((ok, fail) => {
    resolve(host, { all: true }, (err: NodeJS.ErrnoException | null, list: dns.LookupAddress[] | string) => err ? fail(err) : ok((list as dns.LookupAddress[]).map((a) => a.address)));
  }).catch(() => { throw new AddressNotAllowedError(`The address ${host} could not be found. Check the spelling, and that this server can reach it.`); });
  for (const a of addresses) {
    const verdict = classifyAddress(a);
    if (verdict === "never" || (verdict === "private" && !policy.allowPrivate)) throw new AddressNotAllowedError(why(verdict, host));
  }
  return u.origin;
}

/**
 * The part of the check that needs no lookup: an address given as numbers (http://10.0.0.5:9000) never goes through a
 * name lookup when it is connected to, so `guardedLookup` cannot see it. This is called when a client is made.
 */
export function assertLiteralAllowed(endpoint: string, policy: AddressPolicy): void {
  let host: string;
  try { host = new URL(endpoint).hostname.replace(/^\[|\]$/g, ""); } catch { throw new AddressNotAllowedError("That is not a valid web address."); }
  if (net.isIP(host) === 0) return;
  const verdict = classifyAddress(host);
  if (verdict === "never" || (verdict === "private" && !policy.allowPrivate)) throw new AddressNotAllowedError(why(verdict, host));
}
