import { describe, expect, it } from "bun:test";
import { resolveBlogAuthor } from "../utils/blog-author.utils";

describe("resolveBlogAuthor", () => {
  it("uses a branded team byline when no author is set (never the owner User.name)", () => {
    const a = resolveBlogAuthor(
      { businessName: "Ez Clean Mobile Car Detailing", businessType: "Full Detail Packages" },
      ["Interior Detailing", "Ceramic Coating"],
    );
    expect(a.name).toBe("The Ez Clean Mobile Car Detailing Team");
    expect(a.isTeam).toBe(true);
    expect(a.jobTitle).toBe("Editorial team at Ez Clean Mobile Car Detailing");
    expect(a.expertise).toEqual(["Interior Detailing", "Ceramic Coating"]);
  });

  it("does not infer an individual credential when a configured author has no title", () => {
    const a = resolveBlogAuthor({ businessName: "Acme", authorName: "Jane Smith" }, []);
    expect(a.jobTitle).toBe("Contributor at Acme");
    expect(a.jobTitle.toLowerCase()).not.toContain("specialist");
  });

  it("does NOT fall back to a junk User.name — that field is never read", () => {
    const a = resolveBlogAuthor(
      { businessName: "Shawarma Moose", businessType: "Catering", User: { name: "Jenish Clean" } },
      ["Office catering"],
    );
    expect(a.name).toBe("The Shawarma Moose Team");
    expect(a.name).not.toContain("Jenish");
  });

  it("uses a real configured author when present", () => {
    const a = resolveBlogAuthor(
      {
        businessName: "Acme",
        businessType: "Dental",
        authorName: "Dr. Jane Smith",
        authorJobTitle: "Lead Dentist, DDS",
        authorExpertise: ["Endodontics", "Emergency care"],
      },
      [],
    );
    expect(a.name).toBe("Dr. Jane Smith");
    expect(a.isTeam).toBe(false);
    expect(a.jobTitle).toBe("Lead Dentist, DDS");
    expect(a.expertise).toContain("Endodontics");
  });

  it("rejects a placeholder author name and falls back to the team byline", () => {
    for (const junk of ["Tester Testing", "admin", "demo user", "n/a"]) {
      const a = resolveBlogAuthor(
        { businessName: "Acme Co", businessType: "Plumbing", authorName: junk },
        ["Leak repair"],
      );
      expect(a.isTeam).toBe(true);
      expect(a.name).toBe("The Acme Co Team");
    }
  });

  it("derives expertise from real services when none is configured", () => {
    const a = resolveBlogAuthor(
      { businessName: "X", businessType: "Cleaning" },
      ["House cleaning", "Move-out cleaning", "Deep cleaning", "Sanitization", "Fifth"],
    );
    expect(a.expertise).toEqual([
      "House cleaning",
      "Move-out cleaning",
      "Deep cleaning",
      "Sanitization",
    ]); // capped at 4
  });
});
