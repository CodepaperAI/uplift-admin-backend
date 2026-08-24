import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const EXPECTED_RECOVERY_FILE_COUNT = 4_541;
const EXPECTED_RECOVERY_MANIFEST_SHA256 =
  "39cda8617d94a67eeb30c7ba3c6d941980ec4e4c7d3ba345011b22124d82e768";

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

describe("production pipeline isolation", () => {
  test("the frozen recovery tree is byte-for-byte unchanged", () => {
    const workspace = resolve(import.meta.dir, "../../..");
    const recovery = resolve(
      workspace,
      "experiments/seo-pilot-10/runs/2026-07-22-global-recovery-audit",
    );
    const files = filesUnder(recovery);
    expect(files).toHaveLength(EXPECTED_RECOVERY_FILE_COUNT);
    const manifest = files
      .map((path) => {
        const fileSha = createHash("sha256").update(readFileSync(path)).digest("hex");
        return `${fileSha}  ${relative(workspace, path)}`;
      })
      .join("\n") + "\n";
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      EXPECTED_RECOVERY_MANIFEST_SHA256,
    );
  });

  test("production modules do not import experiments or invoke a CMS publisher", () => {
    const serviceRoot = resolve(
      import.meta.dir,
      "../services/blog-pipeline-v2",
    );
    const files = filesUnder(serviceRoot);
    const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
    const generatorSource = files
      .filter((path) => !path.endsWith("publishing-handoff.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const handoffSource = readFileSync(
      join(serviceRoot, "publishing-handoff.ts"),
      "utf8",
    );
    expect(source).not.toContain("experiments/");
    expect(source).not.toMatch(/PublishingService|wordpress-publisher/i);
    expect(generatorSource).not.toContain("publishing/auto-publish");
    expect(handoffSource).toContain('name: "publishing/auto-publish"');
    expect(handoffSource).not.toMatch(/fetch\(|axios|wordpress|cms/i);
  });
});
