import type { CommandCapability } from "./access-control";

export function canAccessPipelineRep(input: {
  capabilities: readonly CommandCapability[];
  actorRepId: string | null;
  requestedRepId: string;
}): boolean {
  return (
    input.capabilities.includes("view.pipeline.all") ||
    (input.capabilities.includes("view.own") &&
      input.actorRepId !== null &&
      input.actorRepId === input.requestedRepId)
  );
}
