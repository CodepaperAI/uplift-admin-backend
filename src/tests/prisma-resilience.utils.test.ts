import { describe, expect, it } from "bun:test";
import {
  getPrismaErrorCode,
  isTransientPrismaConnectionError,
  runWithTransientPrismaRetry,
} from "../utils/prisma-resilience.utils";

describe("prisma connection resilience", () => {
  it("detects Neon closed-connection errors from the Prisma log message", () => {
    const error = new Error(
      "Error in PostgreSQL connection: Error { kind: Closed, cause: None }",
    );

    expect(isTransientPrismaConnectionError(error)).toBe(true);
  });

  it("detects transient Prisma connection codes", () => {
    const error = {
      code: "P1001",
      message: "Can't reach database server.",
    };

    expect(getPrismaErrorCode(error)).toBe("P1001");
    expect(isTransientPrismaConnectionError(error)).toBe(true);
  });

  it("retries transient failures and eventually succeeds", async () => {
    let attempts = 0;

    const result = await runWithTransientPrismaRetry(
      async () => {
        attempts += 1;

        if (attempts < 3) {
          throw new Error(
            "Error in PostgreSQL connection: Error { kind: Closed, cause: None }",
          );
        }

        return "ok";
      },
      {
        operationName: "testPersistence",
        maxAttempts: 3,
        retryDelayMs: 0,
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;

    await expect(
      runWithTransientPrismaRetry(
        async () => {
          attempts += 1;
          throw new Error("Unique constraint failed");
        },
        {
          operationName: "testPersistence",
          maxAttempts: 3,
          retryDelayMs: 0,
        },
      ),
    ).rejects.toThrow("Unique constraint failed");

    expect(attempts).toBe(1);
  });
});
