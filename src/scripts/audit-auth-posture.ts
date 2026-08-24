import { prisma } from "../config/db.config";

function assertProductionReadAcknowledged(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is missing or invalid");
  }

  const looksProduction =
    process.env.NODE_ENV === "production" ||
    host.includes("neon.tech") ||
    host.includes("uplift");
  if (
    looksProduction &&
    process.env.SECURITY_AUDIT_PRODUCTION_READ_CONFIRMED !== "true"
  ) {
    throw new Error(
      "Set SECURITY_AUDIT_PRODUCTION_READ_CONFIRMED=true for a production read",
    );
  }
}

function isDefaultScryptHash(value: string): boolean {
  return /^[0-9a-f]{32}:[0-9a-f]{128}$/i.test(value);
}

function tokenStorageClass(value: string | null): string {
  if (!value) return "absent";
  if (/^\$ba\$\d+\$[0-9a-f]+$/i.test(value)) {
    return "versioned-encrypted";
  }
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return "legacy-encrypted-or-hex";
  }
  return "plaintext-likely";
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce(
    (counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    },
    {} as Record<T, number>,
  );
}

async function main(): Promise<void> {
  assertProductionReadAcknowledged();
  const now = new Date();

  const [users, accounts, sessions, verifications, twoFactors] =
    await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          emailVerified: true,
          twoFactorEnabled: true,
          accounts: { select: { providerId: true } },
        },
      }),
      prisma.account.findMany({
        select: {
          providerId: true,
          password: true,
          accessToken: true,
          refreshToken: true,
          idToken: true,
        },
      }),
      prisma.session.findMany({
        select: { expiresAt: true, createdAt: true, updatedAt: true },
      }),
      prisma.verification.findMany({
        select: { identifier: true, expiresAt: true },
      }),
      prisma.twoFactor.findMany({ select: { userId: true } }),
    ]);

  const credentialAccounts = accounts.filter(
    (account) => account.providerId === "credential",
  );
  const oauthAccounts = accounts.filter(
    (account) => account.providerId !== "credential",
  );
  const classifyOAuthField = (
    field: "accessToken" | "refreshToken" | "idToken",
  ) => countBy(oauthAccounts.map((account) => tokenStorageClass(account[field])));
  const identifierFamilies = verifications.map((verification) => {
    const separator = verification.identifier.indexOf(":");
    return separator > 0
      ? verification.identifier.slice(0, separator)
      : "other";
  });

  const result = {
    generatedAt: now.toISOString(),
    valuesExposed: false,
    users: {
      total: users.length,
      verified: users.filter((user) => user.emailVerified).length,
      unverified: users.filter((user) => !user.emailVerified).length,
      unverifiedCredentialUsers: users.filter(
        (user) =>
          !user.emailVerified &&
          user.accounts.some((account) => account.providerId === "credential"),
      ).length,
      unverifiedUsersWithGoogleAndCredential: users.filter(
        (user) =>
          !user.emailVerified &&
          user.accounts.some((account) => account.providerId === "credential") &&
          user.accounts.some((account) => account.providerId === "google"),
      ).length,
    },
    passwordStorage: {
      credentialAccounts: credentialAccounts.length,
      populatedHashes: credentialAccounts.filter((account) => account.password)
        .length,
      recognizedScryptHashes: credentialAccounts.filter(
        (account) => account.password && isDefaultScryptHash(account.password),
      ).length,
      unknownHashFormats: credentialAccounts.filter(
        (account) => account.password && !isDefaultScryptHash(account.password),
      ).length,
      plaintextValuesReturned: 0,
    },
    oauthTokenStorage: {
      accountCount: oauthAccounts.length,
      providers: countBy(oauthAccounts.map((account) => account.providerId)),
      accessToken: classifyOAuthField("accessToken"),
      refreshToken: classifyOAuthField("refreshToken"),
      idToken: classifyOAuthField("idToken"),
      tokenValuesReturned: 0,
    },
    sessions: {
      total: sessions.length,
      active: sessions.filter((session) => session.expiresAt > now).length,
      expired: sessions.filter((session) => session.expiresAt <= now).length,
      tokenValuesReturned: 0,
    },
    verifications: {
      total: verifications.length,
      active: verifications.filter(
        (verification) => verification.expiresAt > now,
      ).length,
      expired: verifications.filter(
        (verification) => verification.expiresAt <= now,
      ).length,
      identifierFamilies: countBy(identifierFamilies),
      valuesReturned: 0,
    },
    twoFactor: {
      enabledUserFlags: users.filter((user) => user.twoFactorEnabled).length,
      storedRecords: twoFactors.length,
      enabledWithoutStoredRecord: users.filter(
        (user) =>
          user.twoFactorEnabled &&
          !twoFactors.some((record) => record.userId === user.id),
      ).length,
      recordsWithoutEnabledFlag: twoFactors.filter(
        (record) =>
          !users.some(
            (user) => user.id === record.userId && user.twoFactorEnabled,
          ),
      ).length,
      secretValuesReturned: 0,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(
      "Auth posture audit failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
