import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

describe("Prisma schema sync", () => {
  it("keeps Prisma ownership exclusively in the backend", () => {
    const backendRoot = join(import.meta.dir, "..", "..");
    expect(existsSync(join(backendRoot, "prisma", "schema.prisma"))).toBe(true);
    for (const frontend of ["seo-fe", "seo-admin"]) {
      const root = join(backendRoot, "..", frontend);
      expect(existsSync(join(root, "prisma", "schema.prisma"))).toBe(false);
      expect(existsSync(join(root, "prisma.config.ts"))).toBe(false);
      const packageJson = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      for (const dependency of [
        "@prisma/adapter-pg",
        "@prisma/client",
        "pg",
        "prisma",
      ]) {
        expect(packageJson.dependencies?.[dependency]).toBeUndefined();
      }
    }
  });
});
