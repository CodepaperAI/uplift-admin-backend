import { describe, expect, it } from "bun:test";
import {
  isGoogleCategoryResourceId,
  resolveGoogleCategoryId,
  resolveGoogleCategoryIds,
} from "../utils/gmb-category-resolver.utils";

describe("gmb-category-resolver", () => {
  describe("resolveGoogleCategoryId", () => {
    it("resolves common verticals across industries", () => {
      expect(resolveGoogleCategoryId("Caterer")).toBe("categories/gcid:caterer");
      expect(resolveGoogleCategoryId("Plumber")).toBe("categories/gcid:plumber");
      expect(resolveGoogleCategoryId("Dentist")).toBe("categories/gcid:dentist");
      expect(resolveGoogleCategoryId("Hair salon")).toBe("categories/gcid:hair_salon");
      expect(resolveGoogleCategoryId("Italian restaurant")).toBe(
        "categories/gcid:italian_restaurant",
      );
      expect(resolveGoogleCategoryId("Lawyer")).toBe("categories/gcid:lawyer");
      expect(resolveGoogleCategoryId("Auto repair shop")).toBe(
        "categories/gcid:auto_repair_shop",
      );
    });

    it("normalizes case, ampersands, and punctuation", () => {
      expect(resolveGoogleCategoryId("HAIR SALON")).toBe("categories/gcid:hair_salon");
      expect(resolveGoogleCategoryId("bar & grill")).toBe(
        "categories/gcid:bar_and_grill",
      );
      expect(resolveGoogleCategoryId("Bar and Grill")).toBe(
        "categories/gcid:bar_and_grill",
      );
      expect(resolveGoogleCategoryId("  Plumber  ")).toBe("categories/gcid:plumber");
    });

    it("returns null for unknown categories so the diff can be tracked manually", () => {
      expect(resolveGoogleCategoryId("AI consultancy")).toBeNull();
      expect(resolveGoogleCategoryId("Quantum widgetsmithy")).toBeNull();
      expect(resolveGoogleCategoryId("")).toBeNull();
    });
  });

  describe("resolveGoogleCategoryIds", () => {
    it("splits resolved and unresolved names and dedupes by gcid", () => {
      const result = resolveGoogleCategoryIds([
        "Caterer",
        "Mediterranean restaurant",
        "AI consultancy",
        "Caterer", // duplicate
      ]);

      expect(result.resolved).toEqual([
        "categories/gcid:caterer",
        "categories/gcid:mediterranean_restaurant",
      ]);
      expect(result.unresolved).toEqual(["AI consultancy"]);
    });

    it("returns empty arrays for empty input without throwing", () => {
      expect(resolveGoogleCategoryIds([])).toEqual({ resolved: [], unresolved: [] });
    });
  });

  describe("isGoogleCategoryResourceId", () => {
    it("recognizes Google's resource-ID form", () => {
      expect(isGoogleCategoryResourceId("categories/gcid:caterer")).toBe(true);
      expect(isGoogleCategoryResourceId("categories/gcid:hair_salon")).toBe(true);
    });

    it("rejects display names and malformed values", () => {
      expect(isGoogleCategoryResourceId("Caterer")).toBe(false);
      expect(isGoogleCategoryResourceId("categories/caterer")).toBe(false);
      expect(isGoogleCategoryResourceId("gcid:caterer")).toBe(false);
      expect(isGoogleCategoryResourceId("")).toBe(false);
    });
  });
});
