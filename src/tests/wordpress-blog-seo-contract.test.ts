import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginRoot = resolve(process.cwd(), "../seo-tool-wordpress-plugin");
const plugin = readFileSync(resolve(pluginRoot, "seo-tool-plugin.php"), "utf8");
const publisher = readFileSync(
  resolve(pluginRoot, "includes/class-publisher.php"),
  "utf8",
);

describe("WordPress blog SEO publishing contract", () => {
  test("emits the saved description, real self-canonical, social cards, and stored JSON-LD", () => {
    expect(plugin).toContain('<meta name="description"');
    expect(plugin).toContain('<link rel="canonical"');
    expect(plugin).toContain('property="og:title"');
    expect(plugin).toContain('name="twitter:card"');
    expect(plugin).toContain("_seo_tool_json_ld");
    expect(plugin).toContain("seo_tool_prepare_post_schema");
  });

  test("normalizes BlogPosting and BreadcrumbList schema to the live WordPress permalink", () => {
    expect(plugin).toContain("['Article', 'BlogPosting']");
    expect(plugin).toContain("$schema['mainEntityOfPage']");
    expect(plugin).toContain("$schema['dateModified']");
    expect(plugin).toContain("$schema_type === 'BreadcrumbList'");
  });

  test("extracts application JSON-LD even when the script has ownership attributes", () => {
    expect(publisher).toContain(
      'application\\/ld\\+json["\\\'][^>]*>',
    );
  });
});
