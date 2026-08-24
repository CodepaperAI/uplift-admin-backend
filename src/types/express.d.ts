declare namespace Express {
  interface Request {
    authUserId?: string;
    agencyId?: string;
    agencySlug?: string;
    userRole?: string;
    commandRepId?: string;
    commandCapabilities?: import("../command/access-control").CommandCapability[];
    authSurface?: "admin" | "dashboard" | "sales";
    adminMfaVerified?: boolean;
    rawBody?: string;
  }
}
