import { describe, expect, it, mock } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import { publicApiCors } from "../middleware/public-api-cors";

function invokeCors(origin: string, method = "POST") {
  const headers = new Map<string, string>();
  const next = mock(() => undefined);
  const response = {
    statusCode: 200,
    ended: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };

  publicApiCors(
    { method, headers: { origin } } as Request,
    response as unknown as Response,
    next as unknown as NextFunction,
  );

  return { headers, next, response };
}

describe("public API CORS", () => {
  it("does not grant browser access to an untrusted origin", () => {
    const result = invokeCors("https://evil.example");

    expect(result.headers.has("access-control-allow-origin")).toBe(false);
    expect(result.headers.get("vary")).toBe("Origin");
    expect(result.next).toHaveBeenCalledTimes(1);
  });

  it("echoes an explicitly allowed application origin", () => {
    const result = invokeCors("https://dashboard.upliftai.co");

    expect(result.headers.get("access-control-allow-origin")).toBe(
      "https://dashboard.upliftai.co",
    );
  });

  it("ends preflight without granting an untrusted origin", () => {
    const result = invokeCors("https://evil.example", "OPTIONS");

    expect(result.response.statusCode).toBe(200);
    expect(result.response.ended).toBe(true);
    expect(result.headers.has("access-control-allow-origin")).toBe(false);
    expect(result.next).not.toHaveBeenCalled();
  });
});
