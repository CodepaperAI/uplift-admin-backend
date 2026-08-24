import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

describe("website removal retry wiring", () => {
  it("registers the production-default five-minute reconciliation worker", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    const start = source.indexOf("export const websiteRemovalRetryTask");
    const end = source.indexOf("export const siteIntegrityCheckTask", start);
    const task = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(task).toContain('id: "website-removal-retry"');
    expect(task).toContain('cron: "*/5 * * * *"');
    expect(task).toContain(
      'isBackgroundAutomationEnabled("WEBSITE_REMOVAL_RETRY_CRON_ENABLED")',
    );
    expect(task).toContain("processWebsiteRemovalRetryBatch({ limit: 20 })");
    expect(source).toMatch(/export const functions = \[[\s\S]*websiteRemovalRetryTask,/);
  });

  it("keeps remove, retry, and restore behind backend authentication", () => {
    const routes = readFileSync(
      resolve(import.meta.dir, "../routes/website.routes.ts"),
      "utf8",
    );
    expect(routes).toContain("WebsiteRouter.use(requireBackendAuth)");
    expect(routes).toContain('delete("/delete", deleteWebsite)');
    expect(routes).toContain('post("/removal/retry", retryWebsiteRemoval)');
    expect(routes).toContain('post("/restore", restoreWebsite)');
  });
});
