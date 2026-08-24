import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { prisma } from "../config/db.config";
import { salesAuth } from "./sales-auth";
import { SALES_AUTH_SURFACE } from "./sales-auth-policy";

export type SalesSessionContext = {
  sessionId: string;
  user: { id: string; name: string; email: string };
};

export async function resolveSalesSession(
  headers: IncomingHttpHeaders,
): Promise<SalesSessionContext | null> {
  const result = await salesAuth.api.getSession({
    headers: fromNodeHeaders(headers),
  });
  if (!result?.user?.id) return null;
  const session = result.session as typeof result.session & { surface?: unknown };
  if (session.surface !== SALES_AUTH_SURFACE) return null;

  const user = await prisma.user.findUnique({
    where: { id: result.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      commandPanelEnabled: true,
    },
  });
  if (user?.role !== "SALES" || !user.commandPanelEnabled) return null;
  return {
    sessionId: session.id,
    user: { id: user.id, name: user.name, email: user.email },
  };
}
