import { describe, expect, it } from "bun:test";
import {
  buildDomainMatchSet,
  isOwnDomain,
  matchBrand,
} from "../utils/citation-domain-matcher";

describe("isOwnDomain", () => {
  it("matches apex domain against www variant of own URL", () => {
    const m = buildDomainMatchSet("https://example.com");
    expect(isOwnDomain("https://www.example.com/about", m)).toBe(true);
    expect(isOwnDomain("https://example.com/contact", m)).toBe(true);
  });

  it("matches www domain against apex variant of own URL", () => {
    const m = buildDomainMatchSet("https://www.example.com");
    expect(isOwnDomain("https://example.com/about", m)).toBe(true);
    expect(isOwnDomain("https://www.example.com/home", m)).toBe(true);
  });

  it("does NOT match substring domains (false-positive guard)", () => {
    const m = buildDomainMatchSet("https://example.com");
    expect(isOwnDomain("https://notexample.com/page", m)).toBe(false);
    expect(isOwnDomain("https://example.com.evil.com", m)).toBe(false);
  });

  it("rejects malformed URLs", () => {
    const m = buildDomainMatchSet("https://example.com");
    expect(isOwnDomain("not a url", m)).toBe(false);
    expect(isOwnDomain("", m)).toBe(false);
  });

  it("handles trailing slashes and query strings gracefully", () => {
    const m = buildDomainMatchSet("https://example.com/");
    expect(isOwnDomain("https://example.com/?ref=abc#x", m)).toBe(true);
  });
});

describe("matchBrand — word boundary + denylist (fixes Tier-B false positives)", () => {
  it("matches the domain label with a word boundary", () => {
    const m = buildDomainMatchSet("https://acme-plumbing.com");
    expect(matchBrand("this blog is written by acme-plumbing experts", m)).not.toBeNull();
  });

  it("does NOT match when the brand is embedded in another word", () => {
    const m = buildDomainMatchSet("https://uplift.ai");
    // Prior behavior would match "upliftai" on any substring; the denylist
    // (`ai`) and min-length rule (4 chars) + word boundary should block it.
    // The domain label "uplift" (6 chars) is the brand pattern and must
    // not match inside "Downliftable" or similar.
    expect(matchBrand("Downliftable rugs are the rage.", m)).toBeNull();
    // But real mention should still hit:
    expect(matchBrand("Uplift is a service we recommend.", m)).not.toBeNull();
  });

  it("never uses denylisted tokens as a brand pattern", () => {
    // Domain `help.com` → label "help" is denylisted (too generic).
    const m = buildDomainMatchSet("https://help.com");
    expect(matchBrand("I need help with my plumbing issues.", m)).toBeNull();
    expect(matchBrand("help is on the way", m)).toBeNull();
  });

  it("uses business name as an additional brand pattern when present", () => {
    const m = buildDomainMatchSet(
      "https://serviceco.com", // generic domain
      "Acme Plumbing",
    );
    expect(matchBrand("We highly recommend Acme Plumbing.", m)).not.toBeNull();
    expect(matchBrand("we highly recommend acme plumbing.", m)).not.toBeNull();
    // Still a word boundary — shouldn't match "acme" alone (too short + partial).
    expect(matchBrand("A different acme is in town.", m)).toBeNull();
  });

  it("rejects too-short / denylisted business names", () => {
    const m = buildDomainMatchSet("https://serviceco.com", "AI");
    expect(matchBrand("AI is cool.", m)).toBeNull();
  });

  it("returns null when no brand pattern was derivable", () => {
    // Pure denylist domain + no business name → no brand patterns at all.
    const m = buildDomainMatchSet("https://shop.com");
    expect(m.brandPatterns.length).toBe(0);
    expect(matchBrand("shop anywhere", m)).toBeNull();
  });
});
