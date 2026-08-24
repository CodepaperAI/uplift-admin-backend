export const UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE =
  "This website category is not supported on Uplift AI.";

const BLOCKED_DOMAIN_SUFFIXES = new Set([
  "aipornvideo.fun",
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "spankbang.com",
  "brazzers.com",
  "bangbros.com",
  "onlyfans.com",
  "fansly.com",
  "chaturbate.com",
  "stripchat.com",
  "livejasmin.com",
  "camsoda.com",
  "myfreecams.com",
  "manyvids.com",
  "adultfriendfinder.com",
  "literotica.com",
  "nhentai.net",
  "rule34.xxx",
]);

const BLOCKED_HOST_FRAGMENTS = [
  "aiporn",
  "porn",
  "porno",
  "xxx",
  "xvideos",
  "xnxx",
  "xhamster",
  "redtube",
  "youporn",
  "spankbang",
  "brazzers",
  "bangbros",
  "onlyfans",
  "fansly",
  "chaturbate",
  "stripchat",
  "livejasmin",
  "camsoda",
  "myfreecams",
  "hentai",
  "rule34",
  "adultvideo",
  "adultvideos",
  "sexvideo",
  "sexvideos",
  "nsfw",
];

const BLOCKED_HOST_TOKENS = new Set([
  "sex",
  "xxx",
  "nude",
  "nudes",
  "erotic",
  "escort",
  "escorts",
  "camgirl",
  "camgirls",
]);

function parseHostname(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function matchesBlockedDomainSuffix(hostname: string): boolean {
  for (const blockedDomain of BLOCKED_DOMAIN_SUFFIXES) {
    if (hostname === blockedDomain || hostname.endsWith(`.${blockedDomain}`)) {
      return true;
    }
  }

  return false;
}

function getHostTokens(hostname: string): string[] {
  return hostname
    .split(".")
    .flatMap((label) => label.split(/[^a-z0-9]+/i))
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

export function isBlockedAdultWebsiteUrl(input: string | null | undefined): boolean {
  if (!input) {
    return false;
  }

  const hostname = parseHostname(input);
  if (!hostname) {
    return false;
  }

  if (matchesBlockedDomainSuffix(hostname)) {
    return true;
  }

  const compactHost = hostname.replace(/[^a-z0-9]/gi, "");
  if (
    BLOCKED_HOST_FRAGMENTS.some((fragment) => compactHost.includes(fragment))
  ) {
    return true;
  }

  return getHostTokens(hostname).some((token) => BLOCKED_HOST_TOKENS.has(token));
}
