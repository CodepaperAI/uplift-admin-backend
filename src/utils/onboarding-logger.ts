import type { Request } from "express";
import type { RequestWithCorrelationId } from "../middleware/correlation-id";

type OnboardingStage =
  | "quick_scrape_saved"
  | "business_details_confirmed"
  | "services_saved"
  | "trial_enrolled"
  | "complete_onboarding_queued"
  | "complete_onboarding_completed"
  | "complete_onboarding_failed";

type LogPayload = {
  stage: OnboardingStage;
  userId?: string;
  businessId?: string;
  quickScrapeBusinessId?: string;
  websiteUrl?: string;
  reason?: string;
  [key: string]: string | undefined;
};

export function logOnboardingStage(
  req: Request | RequestWithCorrelationId,
  payload: LogPayload,
): void {
  const correlationId =
    "correlationId" in req && typeof req.correlationId === "string"
      ? req.correlationId
      : undefined;
  const line = JSON.stringify({
    ...payload,
    correlationId,
    timestamp: new Date().toISOString(),
  });
  console.log(`[Onboarding] ${line}`);
}

export type OnboardingAlertReason =
  | "complete_onboarding_failed"
  | "missing_quick_business"
  | "ownership_rejected"
  | "payment_entitlement_rejected"
  | "missing_business_after_llm";

export function logOnboardingAlert(
  reason: OnboardingAlertReason,
  context: { userId?: string; businessId?: string; quickScrapeBusinessId?: string; correlationId?: string; message?: string },
): void {
  const line = JSON.stringify({
    alert: true,
    reason,
    ...context,
    timestamp: new Date().toISOString(),
  });
  console.warn(`[OnboardingAlert] ${line}`);
}
