import { describe, expect, test } from "bun:test";

import {
  assertPublicHttpUrl,
  fetchPublicResource,
  isPrivateAddress,
} from "../services/social-creative/safe-fetch";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

describe("social creative public URL boundary", () => {
  test("rejects comprehensive private and reserved IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.1.2",
      "172.31.255.254",
      "192.0.0.9",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.2",
      "198.18.0.1",
      "198.51.100.4",
      "203.0.113.8",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });

  test("rejects reserved IPv6 and private IPv4-mapped IPv6", () => {
    for (const address of [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "64:ff9b::808:808",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "3fff::1",
      "fc00::1",
      "fd00::1",
      "fe80::1%lo0",
      "fec0::1",
      "ff02::1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  test("rejects credentials, local names, and non-standard scheme ports", async () => {
    await expect(
      assertPublicHttpUrl("https://user:pass@example.com/image.png", {
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("credentials");
    await expect(
      assertPublicHttpUrl("https://assets.internal/image.png", {
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("private host");
    await expect(
      assertPublicHttpUrl("https://example.com:8443/image.png", {
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("non-standard port");
    await expect(
      assertPublicHttpUrl("http://example.com:443/image.png", {
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("non-standard port");
  });

  test("rejects HTTPS IP literals before opening a TLS connection", async () => {
    let transportCalled = false;
    await expect(
      fetchPublicResource("https://34.49.205.230/logo.png", {
        pinnedTransportImpl: async () => {
          transportCalled = true;
          throw new Error("transport must not be called");
        },
      }),
    ).rejects.toThrow("must use a valid hostname");
    expect(transportCalled).toBe(false);
  });

  test("contains pinned transport connection failures", async () => {
    await expect(
      fetchPublicResource("https://example.com/logo.png", {
        lookupImpl: publicLookup,
        pinnedTransportImpl: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        },
      }),
    ).rejects.toThrow("connect ECONNREFUSED");
  });

  test("rejects a hostname when any DNS answer is non-public", async () => {
    await expect(
      assertPublicHttpUrl("https://example.com/image.png", {
        lookupImpl: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow("private or reserved");
  });

  test("pins the real/global transport to a DNS answer that was validated", async () => {
    let pinnedAddress = "";
    const result = await fetchPublicResource("https://example.com/image.png", {
      fetchImpl: globalThis.fetch,
      lookupImpl: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 },
      ],
      pinnedTransportImpl: async (_url, options) => {
        pinnedAddress = options.record.address;
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
          status: 200,
        });
      },
    });

    expect(pinnedAddress).toBe("93.184.216.34");
    expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  test("revalidates every redirect target before the next request", async () => {
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return new Response(null, {
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        status: 302,
      });
    };
    await expect(
      fetchPublicResource("https://example.com/image.png", {
        fetchImpl,
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("private or reserved");
    expect(requests).toBe(1);
  });

  test("revalidates public relative redirects and returns the final URL", async () => {
    const requested: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      requested.push(String(input));
      if (requested.length === 1) {
        return new Response(null, {
          headers: { location: "/final.png" },
          status: 302,
        });
      }
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png; charset=binary" },
        status: 200,
      });
    };
    const result = await fetchPublicResource("https://example.com/start.png", {
      fetchImpl,
      lookupImpl: publicLookup,
    });
    expect(requested).toEqual([
      "https://example.com/start.png",
      "https://example.com/final.png",
    ]);
    expect(result.finalUrl).toBe("https://example.com/final.png");
    expect(result.contentType).toBe("image/png");
  });

  test("rejects oversized declared responses before reading the body", async () => {
    let getReaderCalled = false;
    let cancelled = false;
    const response = {
      body: {
        async cancel() {
          cancelled = true;
        },
        getReader() {
          getReaderCalled = true;
          throw new Error("body must not be read");
        },
      },
      headers: new Headers({
        "content-length": "100",
        "content-type": "image/png",
      }),
      ok: true,
      status: 200,
    } as unknown as Response;
    await expect(
      fetchPublicResource("https://example.com/image.png", {
        fetchImpl: async () => response,
        lookupImpl: publicLookup,
        maxBytes: 8,
      }),
    ).rejects.toThrow("maximum allowed size");
    expect(getReaderCalled).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("enforces the byte limit while streaming and cancels the reader", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchPublicResource("https://example.com/image.png", {
        fetchImpl: async () =>
          new Response(body, { headers: { "content-type": "image/png" } }),
        lookupImpl: publicLookup,
        maxBytes: 8,
      }),
    ).rejects.toThrow("maximum allowed size");
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  test("rejects empty bodies and disallowed content types", async () => {
    await expect(
      fetchPublicResource("https://example.com/empty.png", {
        fetchImpl: async () =>
          new Response(new Uint8Array(), {
            headers: { "content-type": "image/png" },
          }),
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("empty");
    await expect(
      fetchPublicResource("https://example.com/not-image", {
        fetchImpl: async () =>
          new Response("hello", {
            headers: { "content-type": "text/plain" },
          }),
        lookupImpl: publicLookup,
      }),
    ).rejects.toThrow("content type is not allowed");
  });
});
