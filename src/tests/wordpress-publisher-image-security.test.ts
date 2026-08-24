import { describe, expect, test } from "bun:test";
import {
  inspectWordPressFeaturedImage,
  wordpressMediaFilename,
} from "../utils/wordpress-publisher";

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = () =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const webp = () => Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ", "binary");

describe("WordPress featured image inspection", () => {
  test("accepts only matching JPEG, PNG, and WebP payloads", () => {
    expect(inspectWordPressFeaturedImage(jpeg(), "image/jpeg")).toMatchObject({
      contentType: "image/jpeg",
      extension: "jpg",
    });
    expect(inspectWordPressFeaturedImage(png(), " image/png; charset=binary ")).toMatchObject({
      contentType: "image/png",
      extension: "png",
    });
    expect(inspectWordPressFeaturedImage(webp(), "IMAGE/WEBP")).toMatchObject({
      contentType: "image/webp",
      extension: "webp",
    });
  });

  test("rejects missing, active-content, and unsupported declared types", () => {
    expect(() => inspectWordPressFeaturedImage(jpeg(), undefined)).toThrow();
    expect(() =>
      inspectWordPressFeaturedImage(Buffer.from("<svg><script/></svg>"), "image/svg+xml"),
    ).toThrow();
    expect(() => inspectWordPressFeaturedImage(Buffer.from("GIF89a"), "image/gif")).toThrow();
  });

  test("rejects content whose bytes do not match its declared MIME type", () => {
    expect(() => inspectWordPressFeaturedImage(png(), "image/jpeg")).toThrow(
      "does not match",
    );
    expect(() => inspectWordPressFeaturedImage(Buffer.from("not-an-image"), "image/png")).toThrow(
      "does not match",
    );
  });

  test("creates a bounded header-safe media filename", () => {
    const filename = wordpressMediaFilename('unsafe"\r\nX-Evil: yes/slug', "jpg");
    expect(filename).toBe("unsafe-X-Evil-yes-slug-featured-image.jpg");
    expect(filename).not.toMatch(/[\r\n"/]/);
    expect(wordpressMediaFilename("", "png")).toBe("featured-featured-image.png");
  });
});
