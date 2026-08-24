import { describe, expect, test } from "bun:test";
import {
  ADMIN_API_ROUTES,
  configuredCorsOrigins,
} from "../src/admin-api-config";

describe("admin API boundary", () => {
  test("publishes only the three intended route families", () => {
    expect(ADMIN_API_ROUTES).toEqual([
      "/api/v1/auth/admin",
      "/api/v1/command",
      "/api/v1/superadmin/agencies",
    ]);
  });

  test("normalizes and deduplicates configured origins", () => {
    const origins = configuredCorsOrigins({
      ADMIN_FRONTEND_URL: "https://admin.upliftai.co/path",
      CORS_ALLOWED_ORIGINS:
        "https://admin.upliftai.co/,https://preview.example.com/path,invalid",
    });
    expect(origins.filter((value) => value === "https://admin.upliftai.co")).toHaveLength(1);
    expect(origins).toContain("https://preview.example.com");
    expect(origins).not.toContain("invalid");
  });

  test("entrypoint keeps health checks and copied non-admin surfaces closed", async () => {
    const entrypoint = await Bun.file("index.ts").text();
    expect(entrypoint).toContain('app.get("/health/live"');
    expect(entrypoint).toContain('app.get("/health/ready"');
    expect(entrypoint).toContain('app.use("/api/v1/command"');
    expect(entrypoint).toContain('app.use("/api/v1/superadmin/agencies"');
    expect(entrypoint).not.toContain('app.use("/api/inngest"');
    expect(entrypoint).not.toContain('app.use("/api/public');
    expect(entrypoint).not.toContain("DashboardRouter");
    expect(entrypoint).not.toContain("SalesPanelRouter");
  });
});
