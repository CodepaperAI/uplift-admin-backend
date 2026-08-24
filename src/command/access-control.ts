export const COMMAND_CAPABILITIES = [
  "view.financials",
  "view.pipeline.all",
  "view.deals.all",
  "view.team.all",
  "view.own",
  "view.own.financials",
  "view.own.coaching",
  "view.ghl",
  "view.costs",
  "view.coaching",
  "edit.leads",
  "edit.deals",
  "edit.activity",
  "edit.calls",
  "edit.costs",
  "manage.reps",
  "edit.services",
  "edit.settings",
  "stripe.sync",
  "manage.roles",
  "data.reset",
] as const;

export type CommandCapability = (typeof COMMAND_CAPABILITIES)[number];
export type CommandPanelRole = "SUPERADMIN" | "ADMIN" | "SALES" | "USER";

export type CapabilityOverride = {
  capability: string;
  enabled: boolean;
};

const ALL_CAPABILITIES: ReadonlySet<CommandCapability> = new Set(
  COMMAND_CAPABILITIES,
);

// Conservative defaults derived from the role intent in Section 3. They are
// bootstrap values only: persisted CommandRoleCapability rows override them so
// the matrix can be changed without a deploy.
const DEFAULT_ROLE_CAPABILITIES: Record<
  CommandPanelRole,
  ReadonlySet<CommandCapability>
> = {
  SUPERADMIN: ALL_CAPABILITIES,
  ADMIN: new Set([
    "view.financials",
    "view.pipeline.all",
    "view.deals.all",
    "view.team.all",
    "view.ghl",
    "view.costs",
    "view.coaching",
    "edit.leads",
    "edit.deals",
    "edit.activity",
    "edit.calls",
    "edit.costs",
    "manage.reps",
    "stripe.sync",
  ]),
  SALES: new Set([
    "view.own",
    "view.own.financials",
    "edit.leads",
    "edit.deals",
    "edit.activity",
    "edit.calls",
  ]),
  USER: new Set(["view.own"]),
};

export function isCommandCapability(
  value: string,
): value is CommandCapability {
  return ALL_CAPABILITIES.has(value as CommandCapability);
}

export function isCommandPanelRole(value: string): value is CommandPanelRole {
  return (
    value === "SUPERADMIN" ||
    value === "ADMIN" ||
    value === "SALES" ||
    value === "USER"
  );
}

export function canEnterCommandPanel(input: {
  role: string;
  commandPanelEnabled: boolean;
}): boolean {
  if (input.role === "SUPERADMIN") return true;
  return isCommandPanelRole(input.role) && input.commandPanelEnabled;
}

export function resolveCommandCapabilities(
  role: CommandPanelRole,
  overrides: readonly CapabilityOverride[],
): CommandCapability[] {
  if (role === "SUPERADMIN") return [...COMMAND_CAPABILITIES];

  const resolved = new Set(DEFAULT_ROLE_CAPABILITIES[role]);

  for (const override of overrides) {
    if (!isCommandCapability(override.capability)) continue;
    if (override.enabled) resolved.add(override.capability);
    else resolved.delete(override.capability);
  }

  return COMMAND_CAPABILITIES.filter((capability) =>
    resolved.has(capability),
  );
}

export function hasCommandCapability(
  capabilities: readonly CommandCapability[],
  capability: CommandCapability,
): boolean {
  return capabilities.includes(capability);
}

export function canAccessRepScope(input: {
  capabilities: readonly CommandCapability[];
  actorRepId: string | null;
  requestedRepId: string;
}): boolean {
  if (
    input.capabilities.includes("view.team.all") ||
    input.capabilities.includes("view.deals.all") ||
    input.capabilities.includes("view.pipeline.all")
  ) {
    return true;
  }

  return (
    input.capabilities.includes("view.own") &&
    input.actorRepId !== null &&
    input.actorRepId === input.requestedRepId
  );
}
