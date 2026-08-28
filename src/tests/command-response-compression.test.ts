import { describe, expect, it } from "bun:test";
import compression from "compression";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The compression configuration the entrypoint installs, exercised directly.
 *
 * `createApp` cannot be booted here — it builds a Prisma client at import — so
 * this asserts the behaviour of the middleware as configured rather than the
 * wiring, which `check:surface` covers. What matters is the threshold and that
 * a client which does not ask for gzip is still served a readable body.
 */
function appWithCompression() {
  const app = express();
  app.use(compression({ threshold: 1024 }));
  app.get("/big", (_req, res) => {
    res.json({ rows: Array.from({ length: 400 }, (_, index) => ({
      stripeCustomerId: `cus_${index}`,
      monthlyRecurringMinor: "29900",
      currency: "cad",
      status: "active",
    })) });
  });
  app.get("/small", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/**
 * A raw HTTP client, because `fetch` decompresses transparently.
 *
 * Undici reports `content-encoding: gzip` and then hands back the decoded body,
 * so a fetch-based test cannot see how many bytes actually crossed the wire —
 * which is the entire claim being made here.
 */
function rawGet(
  port: number,
  path: string,
  acceptEncoding: string,
): Promise<{ headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path, headers: { "Accept-Encoding": acceptEncoding } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ headers: response.headers, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
  });
}

async function serve<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = appWithCompression().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(port);
  } finally {
    server.close();
  }
}

describe("response compression", () => {
  it("compresses a roster-sized payload and shrinks it substantially", async () => {
    const { encoding, vary, transferred, decoded } = await serve(async (port) => {
      const { headers, bytes } = await rawGet(port, "/big", "gzip");
      return {
        encoding: headers["content-encoding"],
        vary: headers.vary,
        transferred: bytes.byteLength,
        decoded: Bun.gunzipSync(new Uint8Array(bytes)).byteLength,
      };
    });
    expect(encoding).toBe("gzip");
    // Repeated JSON keys are what make this worth doing at all.
    expect(decoded).toBeGreaterThan(20_000);
    expect(transferred * 10).toBeLessThan(decoded);
    // Without this a shared cache could hand a gzipped body to a client that
    // never asked for one.
    expect(vary).toContain("Accept-Encoding");
  });

  it("leaves a small payload alone", async () => {
    const encoding = await serve(async (port) => {
      const { headers } = await rawGet(port, "/small", "gzip");
      return headers["content-encoding"];
    });
    expect(encoding).toBeUndefined();
  });

  it("serves an uncompressed body to a client that does not negotiate gzip", async () => {
    const { encoding, parsed } = await serve(async (port) => {
      const { headers, bytes } = await rawGet(port, "/big", "identity");
      return {
        encoding: headers["content-encoding"],
        parsed: JSON.parse(bytes.toString("utf8")) as { rows: unknown[] },
      };
    });
    expect(encoding).toBeUndefined();
    expect(parsed.rows).toHaveLength(400);
  });
});
