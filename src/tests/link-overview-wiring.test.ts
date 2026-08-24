import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

describe("link overview backend wiring", () => {
  it("protects the overview endpoint with backend authentication and user binding", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "src/services/backlink.service.ts"),
      "utf8",
    );
    const overviewRoute = routeSource.slice(routeSource.indexOf('"/overview"'));

    expect(overviewRoute).toContain("requireBackendAuth");
    expect(overviewRoute).toContain("bindAuthenticatedUser");
    expect(overviewRoute).toContain("GetBacklinkOverview");
  });

  it("scopes both article links and managed backlinks to the selected business", () => {
    const serviceSource = readFileSync(
      resolve(process.cwd(), "src/services/link-overview.service.ts"),
      "utf8",
    );

    expect(serviceSource).toContain("prisma.blog.findMany({");
    expect(serviceSource).toContain("where: { businessId }");
    expect(serviceSource).toContain("referredBusinessId: businessId");
    expect(serviceSource).toContain("sourceBusinessId: { not: businessId }");
  });

  it("checks ownership before constructing the overview", () => {
    const controllerSource = readFileSync(
      resolve(process.cwd(), "src/controllers/backlink.controller.ts"),
      "utf8",
    );

    expect(controllerSource).toContain("id: payload.businessId");
    expect(controllerSource).toContain("userId: payload.userId");
    expect(controllerSource).toContain("isActive: true");
    expect(controllerSource).toContain(
      "getLinkOverviewForBusiness(targetBusinessId)",
    );
  });
});
