import { prisma } from "../config/db.config";
import {
  canEnterCommandPanel,
  isCommandPanelRole,
  resolveCommandCapabilities,
  type CommandCapability,
  type CommandPanelRole,
} from "./access-control";

export type CommandActor = {
  userId: string;
  role: CommandPanelRole;
  repId: string | null;
  capabilities: CommandCapability[];
};

export async function resolveCommandActor(
  userId: string,
): Promise<CommandActor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      commandPanelEnabled: true,
      CommandRepProfile: { select: { id: true, isActive: true } },
    },
  });

  if (
    !user ||
    !isCommandPanelRole(user.role) ||
    !canEnterCommandPanel({
      role: user.role,
      commandPanelEnabled: user.commandPanelEnabled,
    })
  ) {
    return null;
  }

  const overrides = await prisma.commandRoleCapability.findMany({
    where: { role: user.role },
    select: { capability: true, enabled: true },
  });

  return {
    userId: user.id,
    role: user.role,
    repId:
      user.CommandRepProfile?.isActive === true
        ? user.CommandRepProfile.id
        : null,
    capabilities: resolveCommandCapabilities(user.role, overrides),
  };
}
