import { retrieveContextDevBrand } from "../services/context-dev-brand.service";

const websiteUrl = process.argv[2]?.trim() || "https://upliftai.co";

if (!process.env.CONTEXT_DEV_API_KEY?.trim()) {
  throw new Error(
    "CONTEXT_DEV_API_KEY is required. Load it from a local environment file; never pass it as a command argument.",
  );
}

const profile = await retrieveContextDevBrand(websiteUrl);
if (!profile) {
  throw new Error(`Context.dev did not return a usable brand for ${websiteUrl}`);
}

function hostname(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

// Intentionally exclude contact details, raw provider data, and credentials.
console.log(
  JSON.stringify(
    {
      ok: true,
      provider: profile.provider,
      schemaVersion: profile.schemaVersion,
      domain: profile.domain,
      retrievedAt: profile.retrievedAt,
      titleFound: Boolean(profile.title),
      sloganFound: Boolean(profile.slogan),
      primaryColorCount: profile.primaryColors.length,
      secondaryColorCount: profile.secondaryColors.length,
      logoHost: hostname(profile.logoUrl),
      faviconHost: hostname(profile.faviconUrl),
      referenceImageHost: hostname(profile.referenceImageUrl),
      socialProfileCount: profile.socials.length,
      creditsConsumed: profile.usage?.creditsConsumed ?? null,
      creditsRemaining: profile.usage?.creditsRemaining ?? null,
    },
    null,
    2,
  ),
);
