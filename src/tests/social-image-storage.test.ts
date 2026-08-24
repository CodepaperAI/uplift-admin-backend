import { describe, expect, test } from "bun:test";

import { getSocialImageStorageProvider } from "../lib/social-image-storage";

describe("social image storage provider", () => {
  test("uses Bunny by default and rejects Cloudinary writes", () => {
    expect(getSocialImageStorageProvider({})).toBe("bunny");
    expect(() =>
      getSocialImageStorageProvider({
        SOCIAL_IMAGE_STORAGE_PROVIDER: "cloudinary",
      }),
    ).toThrow("Bunny is required");
  });

  test("accepts Bunny explicitly and rejects configuration typos", () => {
    expect(
      getSocialImageStorageProvider({ SOCIAL_IMAGE_STORAGE_PROVIDER: "BUNNY" }),
    ).toBe("bunny");
    expect(() =>
      getSocialImageStorageProvider({ SOCIAL_IMAGE_STORAGE_PROVIDER: "s3" }),
    ).toThrow("Unsupported SOCIAL_IMAGE_STORAGE_PROVIDER");
  });
});
