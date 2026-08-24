import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { getProductionBlogImageRoles } from "../services/blog-pipeline-v2/image-pipeline";

describe("quick trial blog image policy", () => {
  test("selects only the featured image for quick trial blogs", () => {
    expect(getProductionBlogImageRoles(true)).toEqual(["featured"]);
  });

  test("keeps the three-image default for the production blog pipeline", () => {
    expect(getProductionBlogImageRoles()).toEqual([
      "featured",
      "internal-1",
      "internal-2",
    ]);
  });

  test("wires the quick-blog generator to skip body-image generation and insertion", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../utils/quick-blog-generator.ts"),
      "utf8",
    );

    expect(source).toContain("featuredImageOnly: true");
    expect(source).not.toContain("insertProductionInternalImages");
  });
});
