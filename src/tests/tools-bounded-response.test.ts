import { describe, expect, test } from "bun:test";

import { readBoundedResponseText } from "../utils/tools.utils";

function nodeStreamResponse(
  chunks: Uint8Array[],
  options: { declaredLength?: number; onDestroy?: () => void } = {},
): Response {
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
    destroy() {
      options.onDestroy?.();
    },
  };
  return {
    headers: new Headers(
      options.declaredLength === undefined
        ? undefined
        : { "content-length": String(options.declaredLength) },
    ),
    body,
    arrayBuffer: async () => {
      throw new Error("arrayBuffer fallback must not read a Node stream");
    },
  } as unknown as Response;
}

describe("bounded response reader", () => {
  test("reads node-fetch async-iterable bodies without getReader", async () => {
    const response = nodeStreamResponse([
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("world"),
    ]);
    await expect(readBoundedResponseText(response, 32)).resolves.toBe(
      "hello world",
    );
  });

  test("stops an unbounded stream after the configured byte limit", async () => {
    let destroyed = false;
    const response = nodeStreamResponse(
      [new Uint8Array(6), new Uint8Array(6)],
      { onDestroy: () => { destroyed = true; } },
    );
    await expect(readBoundedResponseText(response, 10)).rejects.toThrow(
      "Remote response is too large",
    );
    expect(destroyed).toBe(true);
  });
});
