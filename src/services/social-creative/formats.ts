import {
  SOCIAL_PLATFORMS,
  type SocialCreativeFormat,
  type SocialPlatform,
} from "./types";

const FORMATS: Record<SocialPlatform, SocialCreativeFormat> = {
  instagram: {
    platform: "instagram",
    placement: "instagram-native",
    aspectRatio: "4:5",
    width: 1024,
    height: 1280,
    sourceSize: "1024x1280",
  },
  facebook: {
    platform: "facebook",
    placement: "facebook-native",
    aspectRatio: "4:5",
    width: 1024,
    height: 1280,
    sourceSize: "1024x1280",
  },
  linkedin: {
    platform: "linkedin",
    placement: "linkedin-native",
    aspectRatio: "1.9:1",
    width: 1216,
    height: 640,
    sourceSize: "1216x640",
  },
  x: {
    platform: "x",
    placement: "x-native",
    aspectRatio: "16:9",
    width: 1280,
    height: 720,
    sourceSize: "1280x720",
  },
};

export const SOCIAL_CREATIVE_FORMATS = Object.freeze(FORMATS);

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return SOCIAL_PLATFORMS.includes(value as SocialPlatform);
}

export function resolveSocialCreativeFormat(
  platform: SocialPlatform,
): SocialCreativeFormat {
  return SOCIAL_CREATIVE_FORMATS[platform];
}

export function normalizeSocialPlatforms(
  platforms: readonly string[] | undefined,
): SocialPlatform[] {
  const normalized = (platforms ?? SOCIAL_PLATFORMS).filter(isSocialPlatform);
  return [...new Set(normalized)];
}
