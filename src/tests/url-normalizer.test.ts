import { describe, it, expect } from "bun:test";
import {
  getEquivalentWebsiteUrls,
  normalizeWebsiteUrl,
} from "../utils/url-normalizer";

describe("normalizeWebsiteUrl", () => {
  it("adds https when no protocol", () => {
    expect(normalizeWebsiteUrl("example.com")).toBe("https://example.com/");
  });

  it("lowercases hostname", () => {
    expect(normalizeWebsiteUrl("https://Example.COM/")).toBe(
      "https://example.com/",
    );
  });

  it("strips trailing slash from path except root", () => {
    expect(normalizeWebsiteUrl("https://example.com/")).toBe(
      "https://example.com/",
    );
    expect(normalizeWebsiteUrl("https://example.com/foo/")).toBe(
      "https://example.com/foo",
    );
  });

  it("strips query and hash", () => {
    expect(normalizeWebsiteUrl("https://example.com/?a=1#x")).toBe(
      "https://example.com/",
    );
  });

  it("url variants map to same normalized form", () => {
    const normalized = "https://example.com/";
    expect(normalizeWebsiteUrl("example.com")).toBe(normalized);
    expect(normalizeWebsiteUrl("https://example.com")).toBe(normalized);
    expect(normalizeWebsiteUrl("https://Example.COM/")).toBe(normalized);
    expect(normalizeWebsiteUrl("  https://example.com/  ")).toBe(normalized);
  });

  it("example.com and https://example.com/ map to same canonical URL for business lookup", () => {
    const a = normalizeWebsiteUrl("example.com");
    const b = normalizeWebsiteUrl("https://example.com/");
    expect(a).toBe(b);
    expect(a).toBe("https://example.com/");
  });

  it("returns empty string for empty or invalid input", () => {
    expect(normalizeWebsiteUrl("")).toBe("");
    expect(normalizeWebsiteUrl("   ")).toBe("");
  });

  it("handles path-only URLs", () => {
    expect(normalizeWebsiteUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("treats apex and www variants as equivalent business URLs", () => {
    expect(getEquivalentWebsiteUrls("https://example.com/")).toEqual([
      "https://example.com/",
      "https://www.example.com/",
    ]);

    expect(getEquivalentWebsiteUrls("https://www.example.com/")).toEqual([
      "https://www.example.com/",
      "https://example.com/",
    ]);
  });

  it("supports common ccTLD apex and www variants", () => {
    expect(getEquivalentWebsiteUrls("https://example.co.uk/")).toEqual([
      "https://example.co.uk/",
      "https://www.example.co.uk/",
    ]);
  });

  it("does not invent www variants for deeper subdomains", () => {
    expect(getEquivalentWebsiteUrls("https://blog.example.com/")).toEqual([
      "https://blog.example.com/",
    ]);
  });
});
