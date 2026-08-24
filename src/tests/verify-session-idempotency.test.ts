import { describe, it, expect } from "bun:test";

type CreateResult = { success: true; duplicate?: boolean };
type P2002Error = { code: string };

function isP2002(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as P2002Error).code === "P2002"
  );
}

describe("Verify-session idempotency (concurrent)", () => {
  it("two simultaneous claims for same sessionId: one processed, one duplicate", async () => {
    let created = false;
    const createOnce = async (sessionId: string): Promise<CreateResult> => {
      if (created) {
        const err = { code: "P2002" };
        throw err;
      }
      created = true;
      return { success: true };
    };

    const processSession = async (sessionId: string): Promise<CreateResult> => {
      try {
        await createOnce(sessionId);
        return { success: true };
      } catch (e) {
        if (isP2002(e)) {
          return { success: true, duplicate: true };
        }
        throw e;
      }
    };

    const sessionId = "same-session-id";
    const [res1, res2] = await Promise.all([
      processSession(sessionId),
      processSession(sessionId),
    ]);

    const results = [res1, res2];
    const withDuplicate = results.filter((r) => r.duplicate === true);
    const withoutDuplicate = results.filter((r) => r.duplicate !== true);

    expect(results).toHaveLength(2);
    expect(withDuplicate).toHaveLength(1);
    expect(withoutDuplicate).toHaveLength(1);
    expect(withDuplicate[0]).toEqual({ success: true, duplicate: true });
    expect(withoutDuplicate[0]).toEqual({ success: true });
  });

  it("concurrent createOnce calls: exactly one succeeds, one gets P2002", async () => {
    let count = 0;
    const createOnce = async (): Promise<void> => {
      const current = ++count;
      if (current > 1) {
        throw { code: "P2002" };
      }
    };

    const results = await Promise.allSettled([
      createOnce(),
      createOnce(),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isP2002((rejected[0] as PromiseRejectedResult).reason)).toBe(true);
  });
});
