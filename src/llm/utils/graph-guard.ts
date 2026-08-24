import type { AIMessage } from "@langchain/core/messages";

type ContinueDecision = "tools" | "__end__";

type GuardOptions = {
  workflowName?: string;
  maxToolRounds: number;
  duplicateToolCallLimit: number;
  successMarkers?: string[];
  failureMarkers?: string[];
  /**
   * Per-tool override of the same-tool-name loop limit. Some tools are LEGITIMATELY
   * called many times in a row — e.g. `save-blog-info` is re-called once per
   * critique-revise draft (plus the occasional validation retry). Without a higher
   * limit the generic guard (duplicateToolCallLimit + 1 = 3) kills a converging
   * critique loop before it can ship. Exact-duplicate detection still applies, so a
   * model resubmitting IDENTICAL content is still stopped.
   */
  perToolNameLoopLimits?: Record<string, number>;
};

type ToolCallLike = {
  name?: string;
  args?: unknown;
};

const DEFAULT_SUCCESS_MARKERS: string[] = ["TASK_COMPLETE", "successfully saved"];
const DEFAULT_FAILURE_MARKERS: string[] = [
  "TASK_FAILED_VALIDATION_NON_RETRYABLE",
  "TASK_FAILED_NON_RETRYABLE",
];

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return (item as { text: string }).text;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = sortObjectKeys(obj[key]);
    }
    return result;
  }
  return value;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortObjectKeys(value));
  } catch {
    return String(value);
  }
}

function getToolCallSignature(message: AIMessage): string {
  const toolCalls = (message.tool_calls ?? []) as ToolCallLike[];
  if (toolCalls.length === 0) {
    return "";
  }
  const normalized = toolCalls.map((toolCall) => ({
    name: toolCall.name ?? "",
    args: stableStringify(toolCall.args),
  }));
  return stableStringify(normalized);
}

function containsAnyMarker(content: string, markers: string[]): boolean {
  return markers.some((marker) => content.includes(marker));
}

function logDecision(
  workflowName: string,
  reason: string,
  metadata: Record<string, unknown>,
): void {
  console.log(
    `[GraphGuard:${workflowName}] ${reason} ${stableStringify(metadata)}`,
  );
}

export function shouldContinueWithGuards(
  messages: AIMessage[],
  options: GuardOptions,
): ContinueDecision {
  const workflowName = options.workflowName ?? "default";
  if (messages.length === 0) {
    logDecision(workflowName, "stop_empty_messages", {});
    return "__end__";
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    logDecision(workflowName, "stop_missing_last_message", {});
    return "__end__";
  }

  const content = normalizeText(lastMessage.content);
  const successMarkers = options.successMarkers ?? DEFAULT_SUCCESS_MARKERS;
  const failureMarkers = options.failureMarkers ?? DEFAULT_FAILURE_MARKERS;

  if (content.length > 0 && containsAnyMarker(content, successMarkers)) {
    logDecision(workflowName, "stop_success_marker", { markerMatched: true });
    return "__end__";
  }

  if (content.length > 0 && containsAnyMarker(content, failureMarkers)) {
    logDecision(workflowName, "stop_failure_marker", { markerMatched: true });
    return "__end__";
  }

  if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
    logDecision(workflowName, "stop_no_tool_calls", {});
    return "__end__";
  }

  const aiMessagesWithTools = messages.filter(
    (message) => message.tool_calls && message.tool_calls.length > 0,
  );

  if (aiMessagesWithTools.length > options.maxToolRounds) {
    logDecision(workflowName, "stop_max_tool_rounds", {
      toolRounds: aiMessagesWithTools.length,
      maxToolRounds: options.maxToolRounds,
    });
    return "__end__";
  }

  const currentSignature = getToolCallSignature(lastMessage);
  if (currentSignature.length === 0) {
    logDecision(workflowName, "continue_tools_empty_signature", {});
    return "tools";
  }

  // --- Exact-signature duplicate detection (original) ---
  // Catches the LLM calling the SAME tool with IDENTICAL args consecutively.
  let duplicateCount = 1;
  for (let i = aiMessagesWithTools.length - 2; i >= 0; i -= 1) {
    const previousMessage = aiMessagesWithTools[i];
    if (!previousMessage) {
      break;
    }
    const previousSignature = getToolCallSignature(previousMessage);
    if (previousSignature === currentSignature) {
      duplicateCount += 1;
      continue;
    }
    break;
  }

  if (duplicateCount >= options.duplicateToolCallLimit) {
    logDecision(workflowName, "stop_duplicate_tool_calls", {
      duplicateCount,
      duplicateToolCallLimit: options.duplicateToolCallLimit,
    });
    return "__end__";
  }

  // --- Same-tool-name loop detection (new) ---
  // Catches the LLM calling the SAME tool repeatedly with DIFFERENT args
  // (e.g., findRelevantLinks with different scope params each time). This is
  // the pattern that caused the "stuck calling links 4 times" bug — args
  // differ slightly so the exact-signature check above doesn't catch it.
  //
  // Rule: if the same tool name appears in the last N consecutive rounds
  // (regardless of args), stop. Threshold = duplicateToolCallLimit + 1 (so
  // a tool that legitimately gets called 2x with different args is fine, but
  // 3+ consecutive rounds with the same tool name triggers the guard).
  const currentToolNames = extractToolNames(lastMessage);
  if (currentToolNames.length > 0) {
    const sameToolNameStreak = countConsecutiveSameToolName(
      aiMessagesWithTools,
      currentToolNames,
    );
    const defaultSameNameLimit = options.duplicateToolCallLimit + 1;
    // Use the most permissive limit among the tools in this round, so a tool
    // with an explicit higher allowance (e.g. save-blog-info during the
    // critique-revise loop) isn't cut off by the generic default.
    const sameNameLimit = Math.max(
      ...currentToolNames.map(
        (name) =>
          options.perToolNameLoopLimits?.[name] ?? defaultSameNameLimit,
      ),
    );
    if (sameToolNameStreak >= sameNameLimit) {
      logDecision(workflowName, "stop_same_tool_loop", {
        toolNames: currentToolNames,
        consecutiveRounds: sameToolNameStreak,
        limit: sameNameLimit,
      });
      return "__end__";
    }
  }

  logDecision(workflowName, "continue_tools", {
    toolRounds: aiMessagesWithTools.length,
    duplicateCount,
  });
  return "tools";
}

/**
 * Extract tool names (without args) from an AI message's tool_calls.
 */
function extractToolNames(message: AIMessage): string[] {
  return ((message.tool_calls ?? []) as ToolCallLike[])
    .map((tc) => tc.name ?? "")
    .filter((n) => n.length > 0);
}

/**
 * Count how many consecutive recent rounds (from the end of the array)
 * called any of the same tool names as the current round. Stops counting
 * when a round doesn't match.
 */
function countConsecutiveSameToolName(
  aiMessagesWithTools: AIMessage[],
  currentToolNames: string[],
): number {
  const currentSet = new Set(currentToolNames);
  let streak = 1; // current round counts as 1
  for (let i = aiMessagesWithTools.length - 2; i >= 0; i--) {
    const prev = aiMessagesWithTools[i];
    if (!prev) break;
    const prevNames = extractToolNames(prev);
    const hasOverlap = prevNames.some((n) => currentSet.has(n));
    if (hasOverlap) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}
