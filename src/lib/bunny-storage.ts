import { createHash, randomUUID } from "node:crypto";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type BunnyStorageEnv = Record<string, string | undefined>;

export type BunnyStorageConfig = {
  accessKey: string;
  cdnBaseUrl: string;
  endpoint: string;
  storageZone: string;
  verifyPublicUpload: boolean;
};

export type BunnyImageUploadReceipt = {
  bytes: number;
  checksumSha256: string;
  format: string;
  objectKey: string;
  provider: "bunny";
  storageZone: string;
  url: string;
};

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required for Bunny image storage`);
  }
  return normalized;
}

function normalizeHttpsUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function getBunnyStorageConfig(
  env: BunnyStorageEnv = process.env,
): BunnyStorageConfig {
  return {
    accessKey: required(env.BUNNY_STORAGE_ACCESS_KEY, "BUNNY_STORAGE_ACCESS_KEY"),
    cdnBaseUrl: normalizeHttpsUrl(
      required(env.BUNNY_CDN_BASE_URL, "BUNNY_CDN_BASE_URL"),
      "BUNNY_CDN_BASE_URL",
    ),
    endpoint: normalizeHttpsUrl(
      env.BUNNY_STORAGE_ENDPOINT?.trim() || "https://storage.bunnycdn.com",
      "BUNNY_STORAGE_ENDPOINT",
    ),
    storageZone: required(env.BUNNY_STORAGE_ZONE, "BUNNY_STORAGE_ZONE"),
    verifyPublicUpload: env.BUNNY_VERIFY_PUBLIC_UPLOADS !== "false",
  };
}

function sanitizeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return !normalized || normalized === "." || normalized === ".."
    ? fallback
    : normalized;
}

export function buildBunnyObjectKey(input: {
  folder?: string;
  mimeType: string;
  publicId?: string;
}): string {
  const extension = MIME_EXTENSIONS[input.mimeType.toLowerCase()];
  if (!extension) {
    throw new Error(`Unsupported Bunny image MIME type: ${input.mimeType}`);
  }
  const folder = (input.folder ?? "social-creatives")
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment, "images"));
  const publicId = sanitizeSegment(
    input.publicId ?? randomUUID(),
    randomUUID(),
  ).replace(/\.(avif|gif|jpe?g|png|webp)$/i, "");
  return [...folder, `${publicId}.${extension}`].join("/");
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function objectKeyFromPublicUrl(url: string, config: BunnyStorageConfig): string {
  const candidate = new URL(url);
  const base = new URL(config.cdnBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const prefix = `${basePath}/`;
  if (
    candidate.protocol !== base.protocol ||
    candidate.host !== base.host ||
    !candidate.pathname.startsWith(prefix)
  ) {
    throw new Error("Image URL does not belong to the configured Bunny CDN");
  }
  const segments = candidate.pathname
    .slice(prefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment));
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Image URL contains an invalid Bunny object key");
  }
  return segments.join("/");
}

async function responseMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body.trim().slice(0, 300) || response.statusText || "Unknown error";
}

async function verifyPublicDelivery(url: string, _expectedBytes: number) {
  const waits = [0, 250, 750];
  let lastError = "Public Bunny CDN verification failed";

  for (const waitMs of waits) {
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    try {
      const response = await fetch(url, {
        method: "HEAD",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const contentType = response.headers.get("content-type")?.toLowerCase();
        if (contentType && !contentType.startsWith("image/")) {
          lastError = `Bunny CDN returned unexpected content type ${contentType}`;
          continue;
        }
        return;
      }
      lastError = `Bunny CDN returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError);
}

export async function uploadImageBufferToBunny(
  buffer: Buffer,
  mimeType: string,
  options: {
    folder?: string;
    publicId?: string;
    config?: BunnyStorageConfig;
  } = {},
): Promise<BunnyImageUploadReceipt> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Bunny image upload requires a non-empty buffer");
  }
  const config = options.config ?? getBunnyStorageConfig();
  const objectKey = buildBunnyObjectKey({
    folder: options.folder,
    mimeType,
    publicId: options.publicId,
  });
  const format = MIME_EXTENSIONS[mimeType.toLowerCase()];
  if (!format) {
    throw new Error(`Unsupported Bunny image MIME type: ${mimeType}`);
  }
  const checksumSha256 = createHash("sha256")
    .update(buffer)
    .digest("hex")
    .toUpperCase();
  const uploadUrl = `${config.endpoint}/${encodeURIComponent(config.storageZone)}/${encodedPath(objectKey)}`;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: config.accessKey,
      Checksum: checksumSha256,
      "Content-Type": mimeType,
    },
    body: Uint8Array.from(buffer),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 201) {
    throw new Error(
      `Bunny image upload failed with HTTP ${response.status}: ${await responseMessage(response)}`,
    );
  }

  const url = `${config.cdnBaseUrl}/${encodedPath(objectKey)}`;
  if (config.verifyPublicUpload) {
    await verifyPublicDelivery(url, buffer.length);
  }

  return {
    bytes: buffer.length,
    checksumSha256,
    format,
    objectKey,
    provider: "bunny",
    storageZone: config.storageZone,
    url,
  };
}

export async function deleteImageFromBunny(
  publicUrl: string,
  options: {
    config?: BunnyStorageConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ deleted: boolean; objectKey: string }> {
  const config = options.config ?? getBunnyStorageConfig();
  const objectKey = objectKeyFromPublicUrl(publicUrl, config);
  const deleteUrl = `${config.endpoint}/${encodeURIComponent(config.storageZone)}/${encodedPath(objectKey)}`;
  const response = await (options.fetchImpl ?? fetch)(deleteUrl, {
    method: "DELETE",
    headers: { AccessKey: config.accessKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(
      `Bunny image deletion failed with HTTP ${response.status}: ${await responseMessage(response)}`,
    );
  }
  return { deleted: response.status === 200, objectKey };
}
