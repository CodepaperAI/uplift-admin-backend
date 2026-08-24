import type { CommandCapability } from "./access-control";

export function canAccessDealRep(input: {
  capabilities: readonly CommandCapability[];
  actorRepId: string | null;
  requestedRepId: string;
}): boolean {
  return (
    input.capabilities.includes("view.deals.all") ||
    (input.capabilities.includes("view.own.financials") &&
      input.actorRepId !== null &&
      input.actorRepId === input.requestedRepId)
  );
}
