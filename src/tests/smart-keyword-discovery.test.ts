import { describe, expect, it } from "bun:test";
import { isMineableCompetitorDomain } from "../services/smart-keyword-discovery.service";

describe("isMineableCompetitorDomain", () => {
  it("rejects search, social, and publishing platforms", () => {
    expect(isMineableCompetitorDomain("www.youtube.com")).toBe(false);
    expect(isMineableCompetitorDomain("https://ca.linkedin.com/company/test")).toBe(
      false,
    );
    expect(isMineableCompetitorDomain("medium.com")).toBe(false);
  });

  it("keeps actual competing product domains", () => {
    expect(isMineableCompetitorDomain("surferseo.com")).toBe(true);
    expect(isMineableCompetitorDomain("https://rankup.so/pricing")).toBe(true);
  });
});
