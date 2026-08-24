export type CommandCostBucket = "acquisition" | "delivery";

export function normalizeCommandCostBucket(
  category: string,
): CommandCostBucket | null {
  if (category === "acquisition") return "acquisition";
  if (category === "delivery" || category === "system") return "delivery";
  return null;
}
