import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
];

type AddressRecord = { address: string; family: 4 | 6 };
type LookupImpl = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<{ address: string; family: number }>>;
type PinnedTransportImpl = (
  url: URL,
  options: {
    headers?: HeadersInit;
    method: string;
    record: AddressRecord;
    timeoutMs: number;
  },
) => Promise<Response>;
type PublicFetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PublicResourceFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  allowedContentTypes?: string[];
  /** Test-only fetch injection. The real/global fetch uses the pinned transport. */
  fetchImpl?: PublicFetchImpl;
  redirects?: number;
  /** Test-only DNS injection. Production callers should use the system resolver. */
  lookupImpl?: LookupImpl;
  /** Test-only transport injection. Production callers use the DNS-pinned transport. */
  pinnedTransportImpl?: PinnedTransportImpl;
};

function ipv4Value(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255,
    )
  ) {
    return null;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function isIpv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Value(base);
  if (baseValue === null) return false;
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(address / blockSize) === Math.floor(baseValue / blockSize);
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === null) return true;

  // IANA special-purpose ranges which are not suitable as remote public media
  // origins. This includes private, loopback, link-local, shared, benchmarking,
  // documentation, multicast, and reserved space.
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefix]) =>
    isIpv4InCidr(value, String(base), Number(prefix)),
  );
}

function parseIpv6(address: string): bigint | null {
  let normalized = address.toLowerCase();
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const embeddedValue = ipv4Value(embeddedIpv4);
    if (embeddedValue === null) return null;
    const high = ((embeddedValue >>> 16) & 0xffff).toString(16);
    const low = (embeddedValue & 0xffff).toString(16);
    normalized = `${normalized.slice(0, -embeddedIpv4.length)}${high}:${low}`;
  }

  const compression = normalized.indexOf("::");
  if (compression !== -1 && compression !== normalized.lastIndexOf("::")) {
    return null;
  }
  const left = (compression === -1 ? normalized : normalized.slice(0, compression))
    .split(":")
    .filter(Boolean);
  const right = (compression === -1 ? "" : normalized.slice(compression + 2))
    .split(":")
    .filter(Boolean);
  const missing = compression === -1 ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function isIpv6InCidr(address: bigint, base: string, prefix: number): boolean {
  const baseValue = parseIpv6(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return address >> shift === baseValue >> shift;
}

function mappedIpv4(address: bigint): string | null {
  // ::ffff:0:0/96 is the IPv4-mapped IPv6 range. Classify the embedded IPv4
  // address rather than allowing mapped loopback/private values through.
  if (address >> 32n !== 0xffffn) return null;
  const value = Number(address & 0xffffffffn);
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function isPrivateIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return true;
  const mapped = mappedIpv4(value);
  if (mapped) return isPrivateIpv4(mapped);

  // Ordinary globally routable unicast space is 2000::/3. Reject everything
  // outside it, plus special ranges within it that can encode another address
  // or are reserved for protocols/documentation.
  return (
    !isIpv6InCidr(value, "2000::", 3) ||
    isIpv6InCidr(value, "2001::", 23) ||
    isIpv6InCidr(value, "2001:db8::", 32) ||
    isIpv6InCidr(value, "2002::", 16) ||
    isIpv6InCidr(value, "3fff::", 20)
  );
}

export function isPrivateAddress(rawAddress: string): boolean {
  const address = String(rawAddress || "")
    .trim()
    .toLowerCase()
    .split("%")[0] ?? "";
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function resolvePublicHttpUrl(
  rawUrl: string,
  lookupImpl: LookupImpl = lookup as LookupImpl,
): Promise<{ records: AddressRecord[]; url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("External image URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("External image URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("External image URL must not contain credentials");
  }
  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) {
    throw new Error("External image URL must not use a non-standard port");
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error("External image URL resolves to a private host");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily && url.protocol === "https:") {
    // IP-literal HTTPS URLs frequently come from scraped storage/CDN aliases
    // whose certificates are issued to a hostname. Fail before opening a
    // socket instead of accepting a reference that cannot establish a valid
    // TLS identity. Public HTTP IPs still go through the normal SSRF checks.
    throw new Error("External HTTPS image URL must use a valid hostname");
  }
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  const records = resolved.map(({ address }) => ({
    address: String(address).split("%")[0] ?? "",
    family: isIP(String(address).split("%")[0] ?? "") as 0 | 4 | 6,
  }));
  if (
    !records.length ||
    records.some(
      (record) =>
        (record.family !== 4 && record.family !== 6) ||
        isPrivateAddress(record.address),
    )
  ) {
    throw new Error(
      "External image URL resolves to a private or reserved network address",
    );
  }
  return { records: records as AddressRecord[], url };
}

export async function assertPublicHttpUrl(
  rawUrl: string,
  options: { lookupImpl?: LookupImpl } = {},
): Promise<URL> {
  const { url } = await resolvePublicHttpUrl(rawUrl, options.lookupImpl);
  return url;
}

function createPinnedLookup(record: AddressRecord): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: record.address, family: record.family }]);
      return;
    }
    callback(null, record.address, record.family);
  };
}

function normalizeUndiciHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const normalized = new Headers(headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function fetchPinned(
  url: URL,
  {
    headers,
    method,
    record,
    timeoutMs,
  }: {
    headers?: HeadersInit;
    method: string;
    record: AddressRecord;
    timeoutMs: number;
  },
): Promise<Response> {
  // Keep the connection pinned to the already-validated public address while
  // preserving the original hostname for TLS SNI/certificate verification.
  // Bun's node:https compatibility layer otherwise verifies the certificate
  // against the pinned IP, which rejects valid CDN certificates.
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 0,
    connect: {
      lookup: createPinnedLookup(record),
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    },
  });

  return (await undiciFetch(url, {
    dispatcher,
    headers: normalizeUndiciHeaders(headers),
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  })) as unknown as Response;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchPublicResponse(
  rawUrl: string,
  options: PublicResourceFetchOptions,
): Promise<{ finalUrl: string; response: Response }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.redirects ?? 3;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("External image timeout must be positive");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("External image redirect limit must be a non-negative integer");
  }

  let current = rawUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const { records, url } = await resolvePublicHttpUrl(
      current,
      options.lookupImpl,
    );
    const headers = { Accept: "image/*" };
    const customFetch =
      options.fetchImpl && options.fetchImpl !== globalThis.fetch
        ? options.fetchImpl
        : null;
    const response = customFetch
      ? await customFetch(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers,
        })
      : await (options.pinnedTransportImpl ?? fetchPinned)(url, {
          headers,
          method: "GET",
          record: records[0]!,
          timeoutMs,
        });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { finalUrl: url.toString(), response };
    }
    await cancelBody(response);
    if (redirect === maxRedirects) {
      throw new Error("External image redirect limit exceeded");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("External image redirect did not include a location");
    }
    try {
      current = new URL(location, url).toString();
    } catch {
      throw new Error("External image redirect location is invalid");
    }
  }
  throw new Error("External image redirect limit exceeded");
}

function parseContentLength(response: Response, maxBytes: number): void {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null) return;
  const trimmed = rawLength.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("External image returned an invalid content length");
  }
  if (BigInt(trimmed) > BigInt(maxBytes)) {
    throw new Error("External image exceeds the maximum allowed size");
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    throw new Error("External image is empty");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("External image exceeds the maximum allowed size");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!total) throw new Error("External image is empty");
  return Buffer.concat(chunks, total);
}

export async function fetchPublicResource(
  rawUrl: string,
  options: PublicResourceFetchOptions = {},
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("External image byte limit must be a positive safe integer");
  }
  const { finalUrl, response } = await fetchPublicResponse(rawUrl, options);
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`External image request failed (${response.status})`);
  }

  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  const allowed = (options.allowedContentTypes ?? ["image/"])
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
  if (
    !allowed.length ||
    !allowed.some((type) => contentType.startsWith(type))
  ) {
    await cancelBody(response);
    throw new Error(
      `External resource content type is not allowed: ${contentType || "unknown"}`,
    );
  }
  try {
    parseContentLength(response, maxBytes);
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
  const buffer = await readBoundedBody(response, maxBytes);
  return { buffer, contentType, finalUrl };
}
