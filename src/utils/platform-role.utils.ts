import type { Role } from "@prisma/client";

export function isSuperAdminRole(role: Role | string): boolean {
  return role === "SUPERADMIN";
}

export function isPlatformStaffSubscriptionBypassRole(
  role: Role | string,
): boolean {
  return role === "ADMIN" || role === "SUPERADMIN";
}
