import { describe, expect, it } from "bun:test";
import type { AIMessage } from "@langchain/core/messages";
import { shouldContinueWithGuards } from "../llm/utils/graph-guard";

// Minimal AIMessage-like builder: one tool call with the given name + args.
function toolMsg(name: string, args: Record<string, unknown>): AIMessage {
  return {
    content: "",
    tool_calls: [{ name, args, id: `${name}-${JSON.stringify(args)}` }],
  } as unknown as AIMessage;
}

const base = {
  workflowName: "test",
  maxToolRounds: 50,
  duplicateToolCallLimit: 2,
  successMarkers: ["Blog Uploaded & Saved"],
  failureMarkers: ["Error:"],
};

describe("graph-guard per-tool loop limits", () => {
  it("stops a generic tool after the default same-name streak (3)", () => {
    // 3 consecutive same-tool (different args) rounds → stop.
    const msgs = [
      toolMsg("find-links", { scope: "a" }),
      toolMsg("find-links", { scope: "b" }),
      toolMsg("find-links", { scope: "c" }),
    ];
    expect(shouldContinueWithGuards(msgs, base)).toBe("__end__");
  });

  it("lets save-blog-info run past the default limit when given a higher per-tool limit", () => {
    const opts = {
      ...base,
      perToolNameLoopLimits: { "save-blog-info": 5 },
    };
    // 4 consecutive save-blog-info drafts (different content) — below limit 5 → continue.
    const four = [
      toolMsg("save-blog-info", { content: "v1" }),
      toolMsg("save-blog-info", { content: "v2" }),
      toolMsg("save-blog-info", { content: "v3" }),
      toolMsg("save-blog-info", { content: "v4" }),
    ];
    expect(shouldContinueWithGuards(four, opts)).toBe("tools");

    // 5th consecutive → hits the raised limit → stop.
    const five = [...four, toolMsg("save-blog-info", { content: "v5" })];
    expect(shouldContinueWithGuards(five, opts)).toBe("__end__");
  });

  it("still stops IDENTICAL save-blog-info resubmissions at the exact-duplicate limit", () => {
    const opts = {
      ...base,
      perToolNameLoopLimits: { "save-blog-info": 5 },
    };
    // Same content twice = a real stuck loop; exact-duplicate limit (2) stops it
    // regardless of the higher same-name allowance.
    const dup = [
      toolMsg("save-blog-info", { content: "same" }),
      toolMsg("save-blog-info", { content: "same" }),
    ];
    expect(shouldContinueWithGuards(dup, opts)).toBe("__end__");
  });

  it("stops on the success marker", () => {
    const msgs = [
      { content: "Blog Uploaded & Saved", tool_calls: [] } as unknown as AIMessage,
    ];
    expect(shouldContinueWithGuards(msgs, base)).toBe("__end__");
  });
});
