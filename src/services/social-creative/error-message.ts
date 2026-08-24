function bounded(value: string): string {
  return value.trim().slice(0, 2_000);
}

function nestedMessage(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth >= 4) return null;
  const candidate = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "details", "reason"]) {
    const nested = candidate[key];
    if (typeof nested === "string" && nested.trim()) return bounded(nested);
    const deeper = nestedMessage(nested, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Provider SDKs sometimes reject with a plain object instead of Error. Keep
 * the useful message while avoiding the unhelpful "[object Object]" value.
 */
export function socialCreativeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return bounded(error.message);
  }
  if (typeof error === "string" && error.trim()) return bounded(error);
  const nested = nestedMessage(error);
  if (nested) return nested;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return bounded(serialized);
  } catch {
    // Fall through to the intentionally generic message below.
  }
  return "Unknown social creative provider error";
}
