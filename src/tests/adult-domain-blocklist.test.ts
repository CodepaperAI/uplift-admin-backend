import { describe, expect, it } from "bun:test";
import { isBlockedAdultWebsiteUrl } from "../utils/adult-domain-blocklist.utils";

describe("isBlockedAdultWebsiteUrl", () => {
  it("blocks the reported adult AI video domain and subdomains", () => {
    expect(isBlockedAdultWebsiteUrl("https://h5.aipornvideo.fun/")).toBe(true);
    expect(isBlockedAdultWebsiteUrl("aipornvideo.fun")).toBe(true);
  });

  it("blocks common adult-site hostname patterns", () => {
    expect(isBlockedAdultWebsiteUrl("https://example-porn-site.com")).toBe(true);
    expect(isBlockedAdultWebsiteUrl("https://brand-xxx.example")).toBe(true);
    expect(isBlockedAdultWebsiteUrl("https://onlyfans.example")).toBe(true);
  });

  it("allows legitimate business domains that include similar letter sequences", () => {
    expect(isBlockedAdultWebsiteUrl("https://alsafakw.org.kw/")).toBe(false);
    expect(isBlockedAdultWebsiteUrl("https://essexlegal.co.uk/")).toBe(false);
    expect(isBlockedAdultWebsiteUrl("https://adult-learning.example/")).toBe(false);
  });
});
