import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BACKEND_ROOT = resolve(import.meta.dir, "../..");
const CLI_PATH = resolve(
  import.meta.dir,
  "../scripts/import-recovery-drafts.ts",
);
const VALID_FIXTURE_PATH = resolve(
  BACKEND_ROOT,
  "../experiments/seo-pilot-10/runs/2026-07-16-recovery-audit/validation/importer-fixtures/valid-package.json",
);
const VALID_MANIFEST_PATH = resolve(
  BACKEND_ROOT,
  "../experiments/seo-pilot-10/runs/2026-07-16-recovery-audit/validation/importer-fixtures/valid-approved-manifest.json",
);
const MULTI_PACKAGE_FIXTURE_PATH = resolve(
  BACKEND_ROOT,
  "../experiments/seo-pilot-10/runs/2026-07-16-recovery-audit/validation/importer-fixtures/two-packages.json",
);
const CONFIRMED_BATCH = "recovery-cli-guard-batch";
const UNREACHABLE_TEST_DATABASE =
  "postgresql://recovery_test:recovery_test@127.0.0.1:1/recovery_cli_guard?connect_timeout=1";

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function isolatedEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  for (const key of [
    "RECOVERY_DRAFT_IMPORT_ENABLED",
    "RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED",
    "APP_ENV",
    "DEPLOY_ENV",
    "ENVIRONMENT",
    "NODE_ENV",
  ]) {
    delete environment[key];
  }

  return {
    ...environment,
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: UNREACHABLE_TEST_DATABASE,
    PRISMA_QUERY_LOGGING: "false",
    PRISMA_QUERY_LOG: "false",
    ...overrides,
  };
}

async function runCli(
  args: string[],
  environmentOverrides: Record<string, string> = {},
): Promise<CliResult> {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", CLI_PATH, ...args],
    cwd: BACKEND_ROOT,
    env: isolatedEnvironment(environmentOverrides),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function applyArguments(...extra: string[]): string[] {
  return [
    `--input=${VALID_FIXTURE_PATH}`,
    "--apply",
    `--manifest=${VALID_MANIFEST_PATH}`,
    `--confirm-batch=${CONFIRMED_BATCH}`,
    ...extra,
  ];
}

function expectPreDatabaseGuard(
  result: CliResult,
  expectedMessage: string,
): void {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(expectedMessage);
  expect(result.stdout).toBe("");

  // DATABASE_URL is deliberately an unreachable loopback endpoint. Seeing any
  // Prisma connection error here would prove the guard did not fail closed.
  expect(result.stderr).not.toContain("PrismaClient");
  expect(result.stderr).not.toContain("Can't reach database server");
  expect(result.stderr).not.toContain("P1001");
}

describe("recovery draft importer CLI apply guards", () => {
  test("blocks apply when RECOVERY_DRAFT_IMPORT_ENABLED is missing", async () => {
    const result = await runCli(applyArguments());

    expectPreDatabaseGuard(
      result,
      "Apply blocked: RECOVERY_DRAFT_IMPORT_ENABLED must be explicitly set to true",
    );
  });

  test("blocks apply when --confirm-batch does not match the package", async () => {
    const result = await runCli(
      [
        `--input=${VALID_FIXTURE_PATH}`,
        "--apply",
        `--manifest=${VALID_MANIFEST_PATH}`,
        "--confirm-batch=another-recovery-batch",
      ],
      { RECOVERY_DRAFT_IMPORT_ENABLED: "true" },
    );

    expectPreDatabaseGuard(
      result,
      "does not match the confirmed batch",
    );
  });

  test("blocks production apply when the production enable flag is missing", async () => {
    const result = await runCli(
      applyArguments("--approval=APPROVE_PRODUCTION_CANARY"),
      {
        APP_ENV: "production",
        NODE_ENV: "production",
        RECOVERY_DRAFT_IMPORT_ENABLED: "true",
      },
    );

    expectPreDatabaseGuard(
      result,
      "Production apply blocked: RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED must be explicitly set to true",
    );
  });

  test("blocks production apply when approval is missing", async () => {
    const result = await runCli(applyArguments(), {
      APP_ENV: "production",
      NODE_ENV: "production",
      RECOVERY_DRAFT_IMPORT_ENABLED: "true",
      RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED: "true",
    });

    expectPreDatabaseGuard(
      result,
      "Apply blocked: --approval must be provided",
    );
  });

  test("blocks production apply when approval is invalid", async () => {
    const result = await runCli(
      applyArguments("--approval=APPROVE_SOMETHING_ELSE"),
      {
        APP_ENV: "production",
        NODE_ENV: "production",
        RECOVERY_DRAFT_IMPORT_ENABLED: "true",
        RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED: "true",
      },
    );

    expectPreDatabaseGuard(
      result,
      "Apply blocked: approval phrase does not match manifest mode",
    );
  });

  test("blocks apply when the independently approved manifest is missing", async () => {
    const result = await runCli(
      [
        `--input=${VALID_FIXTURE_PATH}`,
        "--apply",
        `--confirm-batch=${CONFIRMED_BATCH}`,
        "--approval=APPROVE_PRODUCTION_CANARY",
      ],
      { RECOVERY_DRAFT_IMPORT_ENABLED: "true" },
    );

    expectPreDatabaseGuard(result, "Apply blocked: --manifest must be provided");
  });

  test("rejects contradictory production runtime markers", async () => {
    const result = await runCli(
      applyArguments("--approval=APPROVE_PRODUCTION_CANARY"),
      {
        APP_ENV: "staging",
        NODE_ENV: "production",
        RECOVERY_DRAFT_IMPORT_ENABLED: "true",
        RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED: "true",
      },
    );

    expectPreDatabaseGuard(
      result,
      "Apply blocked: runtime environment markers are contradictory",
    );
  });

  test("restricts apply to one package per independently receipted invocation", async () => {
    const result = await runCli(
      [
        `--input=${MULTI_PACKAGE_FIXTURE_PATH}`,
        "--apply",
        `--manifest=${VALID_MANIFEST_PATH}`,
        `--confirm-batch=${CONFIRMED_BATCH}`,
        "--approval=APPROVE_PRODUCTION_CANARY",
      ],
      { RECOVERY_DRAFT_IMPORT_ENABLED: "true" },
    );

    expectPreDatabaseGuard(result, "exactly one package is allowed per invocation");
  });

  test("reports dry-run mode by default when --apply is omitted", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing --input");
    expect(result.stderr).toContain('"mode":"dry-run"');
    expect(result.stderr).not.toContain('"mode":"apply"');
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("PrismaClient");
    expect(result.stderr).not.toContain("P1001");
  });
});
