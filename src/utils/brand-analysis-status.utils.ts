export const ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION = "3.0-pending";
export const MANUAL_BRAND_ANALYSIS_PENDING_VERSION = "manual-pending";

export function isBrandAnalysisPending(
  analysisVersion: string | null | undefined,
): boolean {
  return analysisVersion?.trim().toLowerCase().endsWith("-pending") === true;
}
