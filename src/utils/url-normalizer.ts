export function normalizeWebsiteUrl(url: string): string {
  if (!url || typeof url !== "string") return "";
  let s = url.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return s;
  }
}

function isIpv4Address(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isWwwToggleEligibleHostname(hostname: string): boolean {
  if (!hostname || hostname === "localhost" || hostname.includes(":")) {
    return false;
  }

  if (isIpv4Address(hostname)) {
    return false;
  }

  const labels = hostname.split(".");
  if (labels.length === 2) {
    return true;
  }

  if (labels.length === 3) {
    const [, secondLevel, topLevel] = labels;
    if (!secondLevel || !topLevel) {
      return false;
    }
    return secondLevel.length <= 3 && topLevel.length === 2;
  }

  return false;
}

export function getEquivalentWebsiteUrls(url: string): string[] {
  const normalizedUrl = normalizeWebsiteUrl(url);
  if (!normalizedUrl) {
    return [];
  }

  try {
    const parsedUrl = new URL(normalizedUrl);
    const candidates = new Set<string>([normalizedUrl]);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (hostname.startsWith("www.")) {
      const withoutWwwHostname = hostname.slice(4);
      if (isWwwToggleEligibleHostname(withoutWwwHostname)) {
        const withoutWwwUrl = new URL(normalizedUrl);
        withoutWwwUrl.hostname = withoutWwwHostname;
        candidates.add(withoutWwwUrl.toString());
      }
    } else if (isWwwToggleEligibleHostname(hostname)) {
      const withWwwUrl = new URL(normalizedUrl);
      withWwwUrl.hostname = `www.${hostname}`;
      candidates.add(withWwwUrl.toString());
    }

    return Array.from(candidates);
  } catch {
    return [normalizedUrl];
  }
}
