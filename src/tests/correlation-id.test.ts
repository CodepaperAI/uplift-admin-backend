import { describe, it, expect } from "bun:test";
import { logOnboardingStage, logOnboardingAlert } from "../utils/onboarding-logger";

describe("Onboarding audit log correlation ID", () => {
  it("logOnboardingStage includes correlationId in log payload when present on request", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const req = { correlationId: "test-correlation-123" } as Parameters<
        typeof logOnboardingStage
      >[0];
      logOnboardingStage(req, {
        stage: "quick_scrape_saved",
        userId: "user-1",
        quickScrapeBusinessId: "qb-1",
        websiteUrl: "https://example.com",
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const last = logs[logs.length - 1] ?? "";
      const json = last.replace(/^\[Onboarding\]\s*/, "");
      const parsed = JSON.parse(json) as { correlationId?: string; stage?: string };
      expect(parsed.correlationId).toBe("test-correlation-123");
      expect(parsed.stage).toBe("quick_scrape_saved");
    } finally {
      console.log = originalLog;
    }
  });

  it("logOnboardingStage omits correlationId when not on request", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const req = {} as Parameters<typeof logOnboardingStage>[0];
      logOnboardingStage(req, {
        stage: "services_saved",
        userId: "user-1",
        quickScrapeBusinessId: "qb-1",
      });
      const last = logs[logs.length - 1] ?? "";
      const json = last.replace(/^\[Onboarding\]\s*/, "");
      const parsed = JSON.parse(json) as { correlationId?: string };
      expect(parsed.correlationId).toBeUndefined();
    } finally {
      console.log = originalLog;
    }
  });

  it("logOnboardingAlert includes correlationId in context when provided", () => {
    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      logOnboardingAlert("ownership_rejected", {
        userId: "user-1",
        businessId: "b-1",
        correlationId: "alert-correlation-456",
        message: "Rejected",
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const last = logs[logs.length - 1] ?? "";
      const json = last.replace(/^\[OnboardingAlert\]\s*/, "");
      const parsed = JSON.parse(json) as { correlationId?: string; reason?: string };
      expect(parsed.correlationId).toBe("alert-correlation-456");
      expect(parsed.reason).toBe("ownership_rejected");
    } finally {
      console.warn = originalWarn;
    }
  });
});
