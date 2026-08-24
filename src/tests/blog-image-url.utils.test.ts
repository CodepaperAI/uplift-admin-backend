import { describe, expect, it } from "bun:test";
import {
  extractImageUrl,
  sanitizeBlogContentImageSources,
  sanitizeBlogImagePayload,
} from "../utils/blog-image-url.utils";

const cloudinaryUrl =
  "https://res.cloudinary.com/demo/image/upload/v123/ai-images/sample.jpg";
const malformedCloudinaryUrl =
  "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,/v123/ai-images/sample.jpg";

describe("blog image URL sanitization", () => {
  it("extracts URLs from image tool objects and arrays", () => {
    expect(extractImageUrl({ imageUrl: cloudinaryUrl })).toBe(cloudinaryUrl);
    expect(extractImageUrl([{ imageUrl: cloudinaryUrl }])).toBe(cloudinaryUrl);
    expect(extractImageUrl({ images: [{ imageUrl: cloudinaryUrl }] })).toBe(
      cloudinaryUrl,
    );
  });

  it("extracts URLs from JSON strings and rejects placeholders", () => {
    expect(extractImageUrl(JSON.stringify({ imageUrl: cloudinaryUrl }))).toBe(
      cloudinaryUrl,
    );
    expect(
      extractImageUrl(`{&quot;imageUrl&quot;:&quot;${cloudinaryUrl}&quot;}`),
    ).toBe(cloudinaryUrl);
    expect(extractImageUrl("[object Object]")).toBeNull();
    expect(extractImageUrl("URL")).toBeNull();
    expect(extractImageUrl("https://example.com/image1.jpg")).toBeNull();
  });

  it("strips malformed Cloudinary transformation URLs while extracting", () => {
    expect(extractImageUrl(malformedCloudinaryUrl)).toBe(cloudinaryUrl);
  });

  it("normalizes JSON-ish content image sources and removes invalid image tags", () => {
    const result = sanitizeBlogContentImageSources(`
      <p>Intro</p>
      <img src="{&quot;imageUrl&quot;:&quot;${cloudinaryUrl}&quot;}" alt="Good image" />
      <img src="[object Object]" alt="Broken image" />
    `);

    expect(result.content).toContain(`src="${cloudinaryUrl}"`);
    expect(result.content).not.toContain("[object Object]");
    expect(result.content).not.toContain("Broken image");
    expect(result.normalizedImageSources).toBe(1);
    expect(result.removedInvalidImages).toBe(1);
  });

  it("sanitizes featured_media and content together before persistence", () => {
    const payload = {
      featured_media: JSON.stringify({ imageUrl: malformedCloudinaryUrl }),
      content: `<p>Body</p><img src="${malformedCloudinaryUrl}" alt="Cloudinary" /><img src="URL" alt="Placeholder" />`,
    };

    const result = sanitizeBlogImagePayload(payload);

    expect(payload.featured_media).toBe(cloudinaryUrl);
    expect(payload.content).toContain(cloudinaryUrl);
    expect(payload.content).toContain("<img");
    expect(payload.content).not.toContain('src="URL"');
    expect(result.featuredMediaChanged).toBe(true);
    expect(result.removedInvalidImages).toBe(1);
    expect(result.normalizedImageSources).toBe(1);
  });
});
