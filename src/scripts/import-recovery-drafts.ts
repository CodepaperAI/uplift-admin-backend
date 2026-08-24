import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

import { prisma } from "../config/db.config";
import {
  RECOVERY_DRAFT_PACKAGE,
  RecoveryImportAuthorizationError,
  getRecoveryImporterVersion,
  getRecoveryRuntimeEnvironment,
  importRecoveryDraft,
  type RecoveryDraftPackage,
  type RecoveryImportResult,
} from "../services/recovery-blog-importer.service";

type CliOptions = {
  inputPath: string;
  receiptPath: string | null;
  apply: boolean;
  manifestPath: string | null;
  confirmBatch: string | null;
  approval: string | null;
};

function argumentValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim() || null;

  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1]?.trim() || null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function defaultReceiptPath(inputPath: string, apply: boolean): string {
  const inputName = basename(inputPath, extname(inputPath));
  const mode = apply ? "apply" : "dry-run";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(
    process.cwd(),
    "reports",
    "recovery-import",
    `${inputName}.${mode}.${timestamp}.receipt.json`,
  );
}

function parseOptions(): CliOptions {
  const input = argumentValue("input");
  if (!input) {
    throw new Error(
      "Missing --input <recovery-package.json>. Dry-run is the default; --apply requires additional guards.",
    );
  }
  const inputPath = resolve(input);
  const apply = hasFlag("apply");
  return {
    inputPath,
    receiptPath: argumentValue("receipt")
      ? resolve(argumentValue("receipt")!)
      : defaultReceiptPath(inputPath, apply),
    apply,
    manifestPath: argumentValue("manifest")
      ? resolve(argumentValue("manifest")!)
      : null,
    confirmBatch: argumentValue("confirm-batch"),
    approval: argumentValue("approval"),
  };
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Invalid ${label} JSON input`);
  }
}

function readPackages(path: string): RecoveryDraftPackage[] {
  const raw = readJson(path, "recovery package");
  const candidates = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { packages?: unknown }).packages)
      ? (raw as { packages: unknown[] }).packages
      : [raw];

  if (candidates.length === 0) {
    throw new Error("Recovery input contains no packages");
  }
  return candidates.map((candidate) => RECOVERY_DRAFT_PACKAGE.parse(candidate));
}

function assertApplyGuards(
  options: CliOptions,
  packages: RecoveryDraftPackage[],
): void {
  if (!options.apply) return;

  if (process.env.RECOVERY_DRAFT_IMPORT_ENABLED !== "true") {
    throw new Error(
      "Apply blocked: RECOVERY_DRAFT_IMPORT_ENABLED must be explicitly set to true",
    );
  }
  if (packages.length !== 1) {
    throw new Error(
      "Apply blocked: exactly one package is allowed per invocation; orchestrate approved batches one package at a time with one receipt each",
    );
  }
  if (!options.manifestPath) {
    throw new Error("Apply blocked: --manifest must be provided");
  }
  if (!options.confirmBatch) {
    throw new Error("Apply blocked: --confirm-batch must be provided");
  }
  if (packages[0]!.batchId !== options.confirmBatch) {
    throw new Error(
      "Apply blocked: package does not match the confirmed batch",
    );
  }
  if (!options.approval) {
    throw new Error("Apply blocked: --approval must be provided");
  }
}

async function main() {
  const options = parseOptions();
  const packages = readPackages(options.inputPath);
  assertApplyGuards(options, packages);
  const manifest = options.apply
    ? readJson(options.manifestPath!, "approved manifest")
    : null;

  const startedAt = new Date();
  const results: RecoveryImportResult[] = [];
  for (const pkg of packages) {
    const result = await importRecoveryDraft(prisma, pkg, {
      apply: options.apply,
      authorization: options.apply
        ? {
            manifest,
            confirmBatch: options.confirmBatch!,
            approval: options.approval!,
            invocationPackageCount: packages.length,
          }
        : undefined,
    });
    results.push(result);
  }

  const summary = {
    totalInputPackages: packages.length,
    evaluatedPackages: results.length,
    ready: results.filter((result) => result.status === "ready").length,
    imported: results.filter((result) => result.status === "imported").length,
    alreadyImported: results.filter(
      (result) => result.status === "already_imported",
    ).length,
    blocked: results.filter((result) => result.status === "blocked").length,
  };
  const receipt = {
    importerVersion: getRecoveryImporterVersion(),
    mode: options.apply ? "apply" : "dry-run",
    runtimeEnvironment: getRecoveryRuntimeEnvironment().value,
    inputFile: basename(options.inputPath),
    manifestFile: options.manifestPath ? basename(options.manifestPath) : null,
    orchestrationPolicy: options.apply
      ? "one-package-per-apply-invocation"
      : "multi-package-read-only-dry-run-allowed",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    summary,
    results,
  };

  if (options.receiptPath) {
    mkdirSync(dirname(options.receiptPath), { recursive: true });
    writeFileSync(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        mode: receipt.mode,
        receiptPath: options.receiptPath,
      },
      null,
      2,
    ),
  );

  if (summary.blocked > 0) {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    const safeError =
      error instanceof RecoveryImportAuthorizationError
        ? error.message
        : error instanceof Error &&
            (error.message.startsWith("Missing --input") ||
              error.message.startsWith("Apply blocked:") ||
              error.message.startsWith("Production apply blocked:") ||
              error.message.startsWith("Invalid ") ||
              error.message === "Recovery input contains no packages")
          ? error.message
          : "Recovery importer failed validation or execution";
    console.error(
      JSON.stringify({
        error: safeError,
        mode: hasFlag("apply") ? "apply" : "dry-run",
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
