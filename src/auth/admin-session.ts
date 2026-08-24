import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { adminAuth } from "./admin-auth";
import {
  ADMIN_AUTH_SURFACE,
  isCurrentMfaAssurance,
  requireSuperadminMfa,
} from "./admin-auth-policy";
import { resolveCommandActor } from "../command/access.service";

export type AdminSessionContext = {
  sessionId: string;
  user: { id: string; email: string; name: string };
  role: "SUPERADMIN" | "ADMIN" | "SALES" | "USER";
  commandPanelEnabled: boolean;
  twoFactorEnabled: boolean;
  mfaVerified: boolean;
  mfaRequired: boolean;
  repId: string | null;
  capabilities: string[];
};

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function resolveAdminSession(
  headers: IncomingHttpHeaders,
): Promise<AdminSessionContext | null> {
  const result = await adminAuth.api.getSession({
    headers: fromNodeHeaders(headers),
  });
  if (!result?.user?.id) return null;

  const session = result.session as typeof result.session & {
    surface?: unknown;
    mfaVerifiedAt?: unknown;
  };
  if (session.surface !== ADMIN_AUTH_SURFACE) return null;

  const actor = await resolveCommandActor(result.user.id);
  if (!actor) return null;

  const user = result.user as typeof result.user & {
    commandPanelEnabled?: unknown;
    twoFactorEnabled?: unknown;
  };
  const mfaRequired = actor.role === "SUPERADMIN" && requireSuperadminMfa();
  const mfaVerifiedAt = asDate(session.mfaVerifiedAt);

  return {
    sessionId: session.id,
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
    },
    role: actor.role,
    commandPanelEnabled:
      actor.role === "SUPERADMIN" || user.commandPanelEnabled === true,
    twoFactorEnabled: user.twoFactorEnabled === true,
    mfaVerified:
      !mfaRequired ||
      (user.twoFactorEnabled === true && isCurrentMfaAssurance(mfaVerifiedAt)),
    mfaRequired,
    repId: actor.repId,
    capabilities: actor.capabilities,
  };
}
