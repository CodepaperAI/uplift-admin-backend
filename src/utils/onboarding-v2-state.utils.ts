export function resolveOnboardingV2PersistedStep(input: {
  currentStep: string;
  currentStatus: string;
  requestedStep?: string;
  requestedStatus?: string;
}): string {
  const status = input.requestedStatus ?? input.currentStatus;
  if (status === "awaiting_payment") return "payment";
  return input.requestedStep ?? input.currentStep;
}
