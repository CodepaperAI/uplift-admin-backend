import { isPlatformStaffSubscriptionBypassRole } from "./platform-role.utils";

export type BlogGenerationAccessUser = {
  role: string;
  trialStatus: string | null;
  trialStartDate?: Date | null;
  trialEndDate: Date | null;
  Subscription: {
    status: string;
  } | null;
};

export type BlogGenerationWebsiteSubscription = {
  status: string;
  trialStatus: string;
  trialStartDate?: Date | null;
  trialEndDate: Date | null;
} | null;

function isCurrentTrialWindow(input: {
  status: string | null | undefined;
  startDate?: Date | null;
  endDate: Date | null | undefined;
  now: Date;
}): boolean {
  return Boolean(
    input.status === "trialing" &&
      input.endDate &&
      input.endDate > input.now &&
      (!input.startDate || input.startDate <= input.now),
  );
}

export function hasActiveBlogGenerationAccess(input: {
  user: BlogGenerationAccessUser;
  websiteSubscription: BlogGenerationWebsiteSubscription;
  now: Date;
}): boolean {
  if (isPlatformStaffSubscriptionBypassRole(input.user.role)) return true;
  if (
    input.websiteSubscription?.status === "active" &&
    ["none", "converted"].includes(input.websiteSubscription.trialStatus)
  ) {
    return true;
  }
  if (input.user.Subscription?.status === "active") return true;
  if (
    ["active", "trialing"].includes(
      input.websiteSubscription?.status ?? "",
    ) &&
    isCurrentTrialWindow({
      status: input.websiteSubscription?.trialStatus,
      startDate: input.websiteSubscription?.trialStartDate,
      endDate: input.websiteSubscription?.trialEndDate,
      now: input.now,
    })
  ) {
    return true;
  }
  return isCurrentTrialWindow({
    status:
      input.user.trialStatus === "active"
        ? "trialing"
        : input.user.trialStatus,
    startDate: input.user.trialStartDate,
    endDate: input.user.trialEndDate,
    now: input.now,
  });
}

export function isBlogGenerationBusinessLifecycleActive(input: {
  isActive: boolean;
  websiteStatus: string | null;
  websiteSubscription: BlogGenerationWebsiteSubscription;
  now: Date;
}): boolean {
  if (!input.isActive) return false;
  if (input.websiteStatus === "active") return true;
  if (input.websiteStatus !== "trial") return false;
  return Boolean(
    ["active", "trialing"].includes(
      input.websiteSubscription?.status ?? "",
    ) &&
      isCurrentTrialWindow({
        status: input.websiteSubscription?.trialStatus,
        startDate: input.websiteSubscription?.trialStartDate,
        endDate: input.websiteSubscription?.trialEndDate,
        now: input.now,
      }),
  );
}
