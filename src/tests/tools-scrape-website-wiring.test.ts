import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("structured ScraperAPI extraction", () => {
  test("passes the requested URL into the Puppeteer page context", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../utils/tools.utils.ts"),
      "utf8",
    );
    const scraperApiBranch = source.slice(
      source.indexOf("export async function scrapeWebsite"),
      source.indexOf("} catch (error) {", source.indexOf("export async function scrapeWebsite")),
    );

    expect(scraperApiBranch).toContain(
      "const data = await page.evaluate((requestedUrl) => {",
    );
    expect(scraperApiBranch).toContain("finalUrl: requestedUrl");
    expect(scraperApiBranch).toContain("}, url);");
    expect(scraperApiBranch).not.toContain("finalUrl: url");
  });
});
