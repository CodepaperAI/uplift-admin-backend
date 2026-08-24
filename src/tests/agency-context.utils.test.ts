import { describe, expect, it } from "bun:test";
import type { Request } from "express";

import { extractAgencyDomainFromRequest } from "../utils/agency-context.utils";

function createRequest(headers: Record<string, string | string[] | undefined>): Request {
  return {
    headers,
  } as Request;
}

describe("extractAgencyDomainFromRequest", () => {
  it("uses the configured deployment domain and ignores spoofed headers", () => {
    const req = createRequest({
      "x-agency-host": "attacker.example",
      "x-forwarded-host": "attacker.example",
      host: "api.internal",
      origin: "https://attacker.example",
    });

    expect(
      extractAgencyDomainFromRequest(req, {
        NODE_ENV: "production",
        FRONTEND_URL: "https://xmedia.upliftai.co/dashboard",
      } as NodeJS.ProcessEnv),
    ).toBe("xmedia.upliftai.co");
  });

  it("preserves host with port so local domains can resolve", () => {
    const req = createRequest({
      host: "localhost:3001",
    });

    expect(
      extractAgencyDomainFromRequest(req, {
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv),
    ).toBe("localhost:3001");
  });

  it("fails closed in production when no deployment domain is configured", () => {
    const req = createRequest({
      "x-agency-host": "xmedia.upliftai.co",
      "x-forwarded-host": "xmedia.upliftai.co, proxy.internal",
      host: "xmedia.upliftai.co",
      origin: "https://xmedia.upliftai.co",
    });

    expect(
      extractAgencyDomainFromRequest(req, {
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
