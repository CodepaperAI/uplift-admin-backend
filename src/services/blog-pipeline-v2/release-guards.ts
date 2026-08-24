export function normalizeRecoveryKeyword(input: string): string {
  return input.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function assertStoredFocusKeyword(
  planId: string,
  expectedKeyword: string,
  storedKeyword: unknown,
): void {
  if (
    typeof storedKeyword !== "string" ||
    normalizeRecoveryKeyword(storedKeyword) !==
      normalizeRecoveryKeyword(expectedKeyword)
  ) {
    throw new Error(
      `${planId}: stored focus keyword must match the frozen recovery keyword`,
    );
  }
}

export function hasRecoveryConversionLanguage(content: string): boolean {
  const words = content.replace(/<[^>]+>/g, " ");
  return /\b(?:contact|book|schedule|request|call|consult|visit|get started|next step|communiquez|contactez|réservez|demandez|appelez|visitez|prendre rendez-vous|prochaine étape)\b/iu.test(
    words,
  );
}

export function recoveryConversionPotential(
  content: string,
  websiteUrl: string,
): "HIGH" | "MEDIUM" | "LOW" {
  const hasLanguage = hasRecoveryConversionLanguage(content);
  let host: string;
  try {
    host = new URL(websiteUrl).hostname
      .replace(/^www\./, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  } catch {
    return hasLanguage ? "MEDIUM" : "LOW";
  }
  const hasLink = new RegExp(
    `<a\\b[^>]*href=["']https?://(?:www\\.)?${host}[^"']*["'][^>]*>`,
    "i",
  ).test(content);
  return hasLanguage && hasLink ? "HIGH" : hasLanguage ? "MEDIUM" : "LOW";
}

export function recoveryFinalCtaConversionPotential(
  content: string,
  websiteUrl: string,
): "HIGH" | "MEDIUM" | "LOW" {
  const h2Matches = [...content.matchAll(/<h2\b[^>]*>/gi)];
  const finalCtaContent = h2Matches.length > 0
    ? content.slice(h2Matches.at(-1)!.index)
    : content;
  return recoveryConversionPotential(finalCtaContent, websiteUrl);
}
