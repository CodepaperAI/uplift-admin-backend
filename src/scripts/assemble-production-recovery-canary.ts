import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { assembleProductionRecoveryCanary } from "../services/recovery-package-assembler.service";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  const value = inline?.slice(prefix.length).trim();
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8") as string) as unknown;
}

const sourcePath = resolve(argument("source"));
const snapshotPath = resolve(argument("plan-snapshot"));
const outputDirectory = resolve(argument("output-dir"));
const approvedBy = argument("approved-by");
const approval = argument("approval");
const approvedArticleSha256 = argument("approved-article-sha256");
const now = new Date(argument("now"));
if (!Number.isFinite(now.getTime())) throw new Error("--now must be ISO datetime");

const result = assembleProductionRecoveryCanary({
  editorialSource: readJson(sourcePath),
  planSnapshot: readJson(snapshotPath),
  options: {
    scope: "production-canary-draft-only",
    productionAuthorized: true,
    publicationAuthorized: false,
    approval,
    approvedBy,
    approvedArticleSha256,
    now,
    maximumSnapshotAgeMinutes: 5,
    manifestTtlMinutes: 10,
  },
});

const stem = result.receipt.sourceStem;
const packageName = `${stem}.production-canary.recovery-package.json`;
const manifestName = `${stem}.production-canary.manifest.json`;
const receiptName = `${stem}.production-canary.assembly-receipt.json`;
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
      dryRunRequired: true,
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
      productionAuthorized: true,
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
