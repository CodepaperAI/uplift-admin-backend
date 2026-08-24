import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  RECOVERY_APPROVED_MANIFEST,
  RECOVERY_DRAFT_PACKAGE,
  computeRecoveryPackageDigest,
} from "../services/recovery-blog-importer.service";
import {
  assembleIsolatedRecoveryCandidate,
  assembleProductionRecoveryCanary,
} from "../services/recovery-package-assembler.service";

const RUN_ROOT = resolve(
  import.meta.dir,
  "../../../experiments/seo-pilot-10/runs/2026-07-16-recovery-audit",
);
const source = JSON.parse(
  readFileSync(
    resolve(
      RUN_ROOT,
      "drafts/painting-doctorz/painting-doctorz-paint-dry.source.json",
    ),
    "utf8",
  ),
);
const snapshot = JSON.parse(
  readFileSync(
    resolve(RUN_ROOT, "cohort/canary-expansion-preflight-refresh.json"),
    "utf8",
  ),
);
const now = new Date("2026-07-17T01:30:00.000Z");

function assemble(editorialSource: unknown = source, planSnapshot: unknown = snapshot) {
  return assembleIsolatedRecoveryCandidate({
    editorialSource,
    planSnapshot,
    options: {
      scope: "isolated-development-only",
      productionAuthorized: false,
      approvedBy: "Recovery assembler test",
      now,
      manifestTtlMinutes: 30,
    },
  });
}

describe("isolated recovery-package assembler", () => {
  test("assembles the Painting Doctorz editorial body into exact importer shapes", () => {
    const result = assemble();

    expect(RECOVERY_DRAFT_PACKAGE.parse(result.package)).toEqual(result.package);
    expect(RECOVERY_APPROVED_MANIFEST.parse(result.manifest)).toEqual(
      result.manifest,
    );
    expect(result.package.blog.status).toBe("DRAFT");
    expect(result.package.blog.blogPublishInfo).toEqual({
      date: "2026-07-13",
      time: "08:00",
    });
    expect(result.package.blog.featured_media).toBe("");
    expect(result.package).not.toHaveProperty("canonical");
    expect(result.package).not.toHaveProperty("structuredData");
    expect(result.package.blog).not.toHaveProperty("seoScore");
    expect(result.package.blog).not.toHaveProperty("analytics");
    expect(result.package.provenance.sourceUrls).toContain(
      "https://www.paintingdoctorz.com/interior-painting",
    );
  });

  test("creates one short-lived development manifest bound to the package digest", () => {
    const result = assemble();

    expect(result.manifest.entries).toHaveLength(1);
    expect(result.manifest.mode).toBe("canary");
    expect(result.manifest.approval.approvedBy).toStartWith(
      "ISOLATED DEVELOPMENT ONLY",
    );
    expect(result.manifest.entries[0]?.approvedCanonicalUrl).toBeNull();
    expect(result.manifest.entries[0]?.approvedBusinessHost).toBe(
      "www.paintingdoctorz.com",
    );
    expect(result.manifest.entries[0]?.packageDigest).toBe(
      computeRecoveryPackageDigest(result.package),
    );
    expect(
      new Date(result.manifest.expiresAt).getTime() -
        new Date(result.manifest.generatedAt).getTime(),
    ).toBe(30 * 60_000);
    expect(result.receipt.productionAuthorized).toBe(false);
    expect(result.receipt.publicationAuthorized).toBe(false);
    expect(result.receipt.databaseWritesPerformed).toBe(0);
  });

  test("is deterministic for the same source, snapshot, and assembly time", () => {
    const first = assemble();
    const second = assemble();

    expect(second.package).toEqual(first.package);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.receipt.packageDigest).toBe(first.receipt.packageDigest);
  });

  test("rejects failed editorial validation and stale or malformed Plan state", () => {
    const failedEditorial = structuredClone(source);
    failedEditorial.validation.summary.fail = 1;
    expect(() => assemble(failedEditorial)).toThrow();

    const publicationAuthorized = structuredClone(source);
    publicationAuthorized.metadata.publicationAuthorized = true;
    expect(() => assemble(publicationAuthorized)).toThrow();

    const importAuthorized = structuredClone(source);
    importAuthorized.validation.importAuthorized = true;
    expect(() => assemble(importAuthorized)).toThrow();

    const usedPlan = structuredClone(snapshot);
    usedPlan.plans[0].isUsed = true;
    expect(() => assemble(source, usedPlan)).toThrow();

    const malformedSchedule = structuredClone(snapshot);
    malformedSchedule.plans[0].publishTime = "8am";
    expect(() => assemble(source, malformedSchedule)).toThrow();
  });
});

describe("production recovery canary assembler", () => {
  const approvedArticleSha256 = createHash("sha256")
    .update(source.articleHtml)
    .digest("hex");

  function assembleProduction(
    optionPatch: Record<string, unknown> = {},
    snapshotPatch: Record<string, unknown> = {},
  ) {
    const freshSnapshot = {
      ...structuredClone(snapshot),
      capturedAt: "2026-07-17T01:29:00.000Z",
      ...snapshotPatch,
    };
    return assembleProductionRecoveryCanary({
      editorialSource: source,
      planSnapshot: freshSnapshot,
      options: {
        scope: "production-canary-draft-only",
        productionAuthorized: true,
        publicationAuthorized: false,
        approval: "APPROVE_PRODUCTION_CANARY",
        approvedBy: "User in Codex task",
        approvedArticleSha256,
        now,
        maximumSnapshotAgeMinutes: 5,
        manifestTtlMinutes: 10,
        ...optionPatch,
      },
    });
  }

  test("assembles one digest-bound DRAFT package after the exact canary approval", () => {
    const result = assembleProduction();

    expect(RECOVERY_DRAFT_PACKAGE.parse(result.package)).toEqual(result.package);
    expect(RECOVERY_APPROVED_MANIFEST.parse(result.manifest)).toEqual(
      result.manifest,
    );
    expect(result.package.blog.status).toBe("DRAFT");
    expect(result.package.blog.featured_media).toBe("");
    expect(result.package).not.toHaveProperty("canonical");
    expect(result.package).not.toHaveProperty("structuredData");
    expect(result.manifest.mode).toBe("canary");
    expect(result.manifest.entries).toHaveLength(1);
    expect(result.manifest.entries[0]?.packageDigest).toBe(
      computeRecoveryPackageDigest(result.package),
    );
    expect(result.receipt.approval).toBe("APPROVE_PRODUCTION_CANARY");
    expect(result.receipt.exactProposedMutation).toEqual({
      blogRowsCreated: 1,
      planRowsLinked: 1,
      forcedStatus: "DRAFT",
      publishingSideEffects: 0,
    });
  });

  test("rejects wrong approval, content drift, stale snapshots, and publication authority", () => {
    expect(() =>
      assembleProduction({ approval: "APPROVE_PRODUCTION_BATCH_IMPORT" }),
    ).toThrow();
    expect(() =>
      assembleProduction({ approvedArticleSha256: "0".repeat(64) }),
    ).toThrow("Editorial article hash");
    expect(() =>
      assembleProduction({}, { capturedAt: "2026-07-17T01:20:00.000Z" }),
    ).toThrow("fresh read-only Plan snapshot");
    expect(() =>
      assembleProduction({ publicationAuthorized: true }),
    ).toThrow();
  });
});
