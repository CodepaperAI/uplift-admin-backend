import { prisma } from "../config/db.config";
import { TrialAnalyticsService } from "../services/trial-analytics.service";

type CliOptions = {
  userId: string;
  planName: string;
  periodDays: number;
  dryRun: boolean;
};

type ParsedArg = {
  key: string;
  value: string;
};

function parseKeyValueArg(arg: string): ParsedArg | null {
  if (!arg.startsWith("--")) {
    return null;
  }
  const normalizedArg: string = arg.slice(2);
  const separatorIndex: number = normalizedArg.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }
  const key: string = normalizedArg.slice(0, separatorIndex).trim();
  const value: string = normalizedArg.slice(separatorIndex + 1).trim();
  if (!key) {
    return null;
  }
  return { key, value };
}

function parseBoolean(value: string): boolean {
  return value.toLowerCase() === "true";
}

function printUsage(): void {
  console.log(
    "Usage: bun run src/scripts/enroll-user-to-paid.ts --userId=<USER_ID> [--planName=<PLAN_NAME>] [--periodDays=<DAYS>] [--dryRun=true]"
  );
}

function parseCliOptions(argv: string[]): CliOptions | null {
  const defaults: CliOptions = {
    userId: "",
    planName: "Cash Payment Plan",
    periodDays: 30,
    dryRun: false,
  };

  const positionalArgs: string[] = [];
  let options: CliOptions = { ...defaults };

  for (const arg of argv) {
    const parsed: ParsedArg | null = parseKeyValueArg(arg);
    if (!parsed) {
      positionalArgs.push(arg);
      continue;
    }
    if (parsed.key === "userId") {
      options = { ...options, userId: parsed.value };
      continue;
    }
    if (parsed.key === "planName") {
      options = { ...options, planName: parsed.value };
      continue;
    }
    if (parsed.key === "periodDays") {
      const parsedDays: number = Number(parsed.value);
      if (!Number.isInteger(parsedDays) || parsedDays <= 0) {
        console.error("Invalid --periodDays value. It must be a positive integer.");
        return null;
      }
      options = { ...options, periodDays: parsedDays };
      continue;
    }
    if (parsed.key === "dryRun") {
      options = { ...options, dryRun: parseBoolean(parsed.value) };
      continue;
    }
    console.error(`Unknown argument: --${parsed.key}`);
    return null;
  }

  const positionalUserId = positionalArgs[0];
  if (!options.userId && positionalUserId) {
    options = { ...options, userId: positionalUserId };
  }

  if (!options.userId?.trim()) {
    console.error("Missing required userId.");
    return null;
  }

  if (!options.planName.trim()) {
    console.error("planName cannot be empty.");
    return null;
  }

  return options;
}

async function main(): Promise<void> {
  const options: CliOptions | null = parseCliOptions(process.argv.slice(2));
  if (!options) {
    printUsage();
    process.exit(1);
  }

  const now: Date = new Date();
  const periodEnd: Date = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + options.periodDays);

  const user = await prisma.user.findUnique({
    where: { id: options.userId },
    include: {
      Subscription: true,
    },
  });

  if (!user) {
    console.error(`User not found for id: ${options.userId}`);
    process.exit(1);
  }

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          userId: options.userId,
          planName: options.planName,
          periodDays: options.periodDays,
          now: now.toISOString(),
          periodEnd: periodEnd.toISOString(),
          currentUserState: {
            trialStatus: user.trialStatus,
            trialStartDate: user.trialStartDate,
            trialEndDate: user.trialEndDate,
            hasSubscription: Boolean(user.Subscription),
            subscriptionStatus: user.Subscription?.status ?? null,
          },
        },
        null,
        2
      )
    );
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: options.userId },
      data: {
        trialStatus: "converted",
        trialUsed: true,
        trialEndDate: user.trialEndDate ?? now,
      },
      select: {
        id: true,
        trialStatus: true,
        trialEndDate: true,
      },
    });

    const subscription = await tx.subscription.upsert({
      where: { userId: options.userId },
      create: {
        userId: options.userId,
        status: "active",
        stripeStatus: "active",
        planName: options.planName,
        startDate: now,
        currentPeriodEnd: periodEnd,
        websiteCount: 1,
        maxWebsites: 1,
      },
      update: {
        status: "active",
        stripeStatus: "active",
        planName: options.planName,
        startDate: now,
        currentPeriodEnd: periodEnd,
      },
      select: {
        id: true,
        status: true,
        stripeStatus: true,
        planName: true,
        currentPeriodEnd: true,
      },
    });

    const websiteSubUpdate = await tx.websiteSubscription.updateMany({
      where: {
        business: { userId: options.userId },
      },
      data: {
        status: "active",
        trialStatus: "converted",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });

    const businessUpdate = await tx.business.updateMany({
      where: { userId: options.userId },
      data: { websiteStatus: "active" },
    });

    return {
      updatedUser,
      subscription,
      websiteSubscriptionsUpdated: websiteSubUpdate.count,
      businessesUpdated: businessUpdate.count,
    };
  });

  await TrialAnalyticsService.trackConversion(options.userId);

  console.log(
    JSON.stringify(
      {
        success: true,
        userId: options.userId,
        planName: options.planName,
        periodDays: options.periodDays,
        result,
      },
      null,
      2
    )
  );
}

main()
  .catch((error: unknown) => {
    console.error("Failed to enroll user to paid:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
