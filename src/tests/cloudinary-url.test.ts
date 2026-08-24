import { describe, expect, it } from "bun:test";
import {
  normalizeCloudinaryImageUrl,
  toResponsiveCloudinaryUrl,
} from "../lib/cloudinary";

describe("Cloudinary URL normalization", () => {
  it("strips malformed transformation segments with trailing commas", () => {
    const malformed =
      "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,/v123/ai-images/sample.jpg";

    expect(normalizeCloudinaryImageUrl(malformed)).toBe(
      "https://res.cloudinary.com/demo/image/upload/v123/ai-images/sample.jpg",
    );
  });

  it("collapses transformed URLs back to the raw upload URL", () => {
    const existing =
      "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_1280/v123/ai-images/sample.jpg";

    expect(toResponsiveCloudinaryUrl(existing, 640)).toBe(
      "https://res.cloudinary.com/demo/image/upload/v123/ai-images/sample.jpg",
    );
  });
});
