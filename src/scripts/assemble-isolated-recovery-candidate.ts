import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { assembleIsolatedRecoveryCandidate } from "../services/recovery-package-assembler.service";

const runtimeMarkers = ["APP_ENV", "DEPLOY_ENV", "ENVIRONMENT", "NODE_ENV"]
  .map((key) => process.env[key]?.trim().toLocaleLowerCase())
  .filter((value): value is string => Boolean(value));
if (runtimeMarkers.some((value) => value === "production" || value === "prod")) {
  throw new Error(
    "Isolated-development candidate assembly is prohibited in production",
  );
}

function argument(name: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  const value = inline?.slice(prefix.length).trim();
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

const sourcePath = resolve(argument("source"));
const snapshotPath = resolve(argument("plan-snapshot"));
const outputDirectory = resolve(argument("output-dir"));
const approvedBy = argument("approved-by");
const now = new Date(argument("now"));
if (!Number.isFinite(now.getTime())) throw new Error("--now must be ISO datetime");

const result = assembleIsolatedRecoveryCandidate({
  editorialSource: readJson(sourcePath),
  planSnapshot: readJson(snapshotPath),
  options: {
    scope: "isolated-development-only",
    productionAuthorized: false,
    approvedBy,
    now,
    manifestTtlMinutes: 30,
  },
});

const stem = result.receipt.sourceStem;
const packageName = `${stem}.isolated-development.recovery-package.json`;
const manifestName = `${stem}.isolated-development.manifest.json`;
const receiptName = `${stem}.isolated-development.assembly-receipt.json`;
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, packageName),
  `${JSON.stringify(result.package, null, 2)}\n`,
);
writeFileSync(
  resolve(outputDirectory, manifestName),
  `${JSON.stringify(result.manifest, null, 2)}\n`,
);
writeFileSync(
  resolve(outputDirectory, receiptName),
  `${JSON.stringify(
    {
      ...result.receipt,
      sourceFile: basename(sourcePath),
      planSnapshotFile: basename(snapshotPath),
      packageFile: packageName,
      manifestFile: manifestName,
      dryRunReady: true,
      dryRunOnly: true,
      applyPerformed: false,
    },
    null,
    2,
  )}\n`,
);

console.log(
  JSON.stringify(
    {
      status: "assembled",
      scope: result.receipt.scope,
      productionAuthorized: false,
      publicationAuthorized: false,
      applyPerformed: false,
      outputDirectory,
      packageFile: packageName,
      manifestFile: manifestName,
      receiptFile: receiptName,
      packageDigest: result.receipt.packageDigest,
      manifestExpiresAt: result.receipt.manifestExpiresAt,
    },
    null,
    2,
  ),
);
