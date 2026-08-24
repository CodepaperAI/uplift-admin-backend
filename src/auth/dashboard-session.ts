import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { dashboardAuth } from "./dashboard-auth";
import { DASHBOARD_AUTH_SURFACE } from "./dashboard-auth-policy";

export type DashboardSessionContext = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: Date;
    updatedAt: Date;
    phone?: string | null;
  };
};

export async function resolveDashboardSession(
  headers: IncomingHttpHeaders,
): Promise<DashboardSessionContext | null> {
  const result = await dashboardAuth.api.getSession({
    headers: fromNodeHeaders(headers),
  });
  if (!result?.user?.id) return null;
  const session = result.session as typeof result.session & { surface?: unknown };
  if (session.surface !== DASHBOARD_AUTH_SURFACE) return null;
  const user = result.user as typeof result.user & { phone?: string | null };
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      phone: user.phone ?? null,
    },
  };
}
