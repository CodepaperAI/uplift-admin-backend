import dns from "node:dns/promises";
import net from "node:net";

/**
 * Guards against SSRF when accepting URLs from untrusted input.
 *
 * Rejects:
 *  - non-http(s) schemes
 *  - RFC1918 private IPs (10/8, 172.16/12, 192.168/16)
 *  - link-local (169.254/16)
 *  - loopback (127/8, ::1)
 *  - IPv6 ULA (fc00::/7)
 *  - AWS/GCP/Azure instance metadata endpoints
 *
 * Resolves DNS first and rejects if ANY resolved A/AAAA record is private.
 *
 * Consumers:
 *  - framer-plugin audit endpoint
 *  - (follow-up PR) public-audit.controller.ts — patches pre-existing bug at line ~74
 */

export class SsrfBlocked extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
    this.name = "SsrfBlocked";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

const METADATA_IPS = new Set(["169.254.169.254", "100.100.100.200"]);

function isPrivateIp(ip: string): boolean {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    if (METADATA_IPS.has(ip)) return true;
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 0 && parts[2] === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarks
    if (a === 198 && b === 51 && parts[2] === 100) return true;
    if (a === 203 && b === 0 && parts[2] === 113) return true;
    if (a === 0) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fec0")) return true; // deprecated site-local
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("2001:db8")) return true; // documentation range
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped
    return isPrivateIp(lower.slice("::ffff:".length));
  }
  return false;
}

export interface GuardedUrl {
  url: URL;
  resolvedIps: string[];
}

/**
 * Validate + resolve a user-supplied URL.
 * Throws SsrfBlocked on rejection.
 */
export async function guardUrl(raw: string): Promise<GuardedUrl> {
  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    throw new SsrfBlocked("Invalid URL", "invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlocked("Only http(s) URLs are allowed", "bad_scheme");
  }
  if (url.username || url.password) {
    throw new SsrfBlocked("URL credentials are not allowed", "url_credentials");
  }
  if (
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  ) {
    throw new SsrfBlocked("Non-standard network ports are not allowed", "bad_port");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new SsrfBlocked("Hostname is not allowed", "blocked_hostname");
  }

  // If hostname is a literal IP, check directly
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfBlocked("IP address is private or reserved", "private_ip");
    }
    return { url, resolvedIps: [hostname] };
  }

  // Resolve and re-check every A/AAAA record
  const resolved: string[] = [];
  try {
    const a = await dns.resolve4(hostname).catch(() => [] as string[]);
    const aaaa = await dns.resolve6(hostname).catch(() => [] as string[]);
    resolved.push(...a, ...aaaa);
  } catch {
    throw new SsrfBlocked("Could not resolve hostname", "dns_failure");
  }

  if (resolved.length === 0) {
    throw new SsrfBlocked("Hostname resolved to no IPs", "dns_empty");
  }

  for (const ip of resolved) {
    if (isPrivateIp(ip)) {
      throw new SsrfBlocked(
        `Resolved IP ${ip} is private or reserved`,
        "resolved_private_ip"
      );
    }
  }

  return { url, resolvedIps: resolved };
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Remote response is too large");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error("Remote response is too large");
    return new TextDecoder().decode(bytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Remote response is too large");
      throw new Error("Remote response is too large");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Convenience wrapper: guards the URL then performs a fetch with a bounded
 * redirect chain (cap at 3). Safer default than raw fetch for user-supplied URLs.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15000;

  let currentUrl = rawUrl;
  let redirectsLeft = maxRedirects;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { url } = await guardUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || redirectsLeft <= 0) {
          return res;
        }
        redirectsLeft -= 1;
        // Resolve redirect against current URL (may be relative)
        currentUrl = new URL(location, url).toString();
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}
