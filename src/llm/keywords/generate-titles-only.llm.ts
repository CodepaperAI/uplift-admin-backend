import { getLLMForKeywords } from "../../config/llm.config";
import {
  buildBlogTitlePlaybookFallback,
  buildBlogTitlePlaybookPrompt,
  getBlogTitlePlaybookFailures,
  selectBlogTitlePlaybookStrategy,
  titleSimilarityScore as playbookTitleSimilarityScore,
} from "../../services/blog-title-playbook.service";

const llm = getLLMForKeywords();

export interface GenerateTitlesOnlyOptions {
  keyword: string;
  businessInfo: string;
  businessLocation?: {
    businessCity?: string;
    businessState?: string;
    businessCountry?: string;
  };
  locale?: string;
  locationCode?: number;
  /** T1: content archetype from ContentArchetypeService. Constrains title format. */
  archetype?: string | null;
  /** Recent titles for the same business. Used to avoid repetitive angles. */
  recentTitles?: string[];
  /** Evidence-backed claims allowed to introduce title vocabulary and premises. */
  allowedClaims?: string[];
  /** Number of distinct evidence-backed offerings a numbered title may promise. */
  supportedListItemCount?: number;
}

export interface GeneratedTitleOption {
  title: string;
  seoTitle: string;
  structureType: string;
  contentIntent: "DIY" | "Service" | "Informational";
  characterCount: number;
  keywordPosition: number;
  keywordUsed: string;
}

export type LockedTitleArchetype =
  | "complete-guide"
  | "how-to"
  | "listicle"
  | "comparison"
  | "service-page";

const LOCKED_STRUCTURE_BY_ARCHETYPE: Record<LockedTitleArchetype, string> = {
  "complete-guide": "complete-guide",
  "how-to": "how-to",
  listicle: "list-based",
  comparison: "comparison",
  "service-page": "service-page",
};

function normalizeLockedTitleArchetype(
  archetype: string | null | undefined,
): LockedTitleArchetype | null {
  const normalized = archetype?.trim().toLowerCase();
  return normalized && normalized in LOCKED_STRUCTURE_BY_ARCHETYPE
    ? (normalized as LockedTitleArchetype)
    : null;
}

export function getLockedTitleStructure(
  archetype: string | null | undefined,
): string | null {
  const normalized = normalizeLockedTitleArchetype(archetype);
  return normalized ? LOCKED_STRUCTURE_BY_ARCHETYPE[normalized] : null;
}

export function isTitleStructureCompatibleWithArchetype(
  structureType: string | null | undefined,
  archetype: string | null | undefined,
): boolean {
  const lockedStructure = getLockedTitleStructure(archetype);
  if (!lockedStructure) return true;
  return structureType?.trim().toLowerCase() === lockedStructure;
}

export function buildLockedTitleFormatInstructions(
  archetype: string | null | undefined,
): string {
  const normalized = normalizeLockedTitleArchetype(archetype);
  if (!normalized) {
    return [
      "No content format was locked before title generation.",
      "Use one appropriate structureType from the output schema for each candidate.",
    ].join("\n");
  }

  const structureType = LOCKED_STRUCTURE_BY_ARCHETYPE[normalized];
  const guidance: Record<LockedTitleArchetype, string> = {
    "complete-guide":
      "All ten options must promise a comprehensive guide. Do not turn any option into a listicle, tutorial, comparison, mistakes post, or service landing page.",
    "how-to":
      "All ten options must promise an instructional how-to. Do not turn any option into a listicle, comparison, broad guide, or service landing page.",
    listicle:
      "All ten options must promise a useful list whose items can be supported by the evidence packet. Do not turn any option into a tutorial, broad guide, or service landing page.",
    comparison:
      "All ten options must promise an explicit, criteria-led comparison. Do not add an arbitrary list number or turn the topic into a roundup, tutorial, broad guide, or service landing page.",
    "service-page":
      "All ten options must frame the same commercial service page. Do not turn any option into a listicle, tutorial, comparison roundup, or broad informational guide.",
  };

  return [
    `Locked content type: ${normalized}`,
    `Required structureType for every candidate: ${structureType}`,
    guidance[normalized],
    "Vary the wording, hook, and decision angle only; the underlying content type must not change.",
  ].join("\n");
}

const UNSUPPORTED_TITLE_CLAIM =
  /\b(?:same[- ]day|next[- ]day|immediate|instant|fast(?:est)?\s+(?:help|response|service)|guaranteed?|24\s*\/\s*7|within\s+\d+\s*(?:minutes?|hours?|days?)|available\s+today|tonight|save\s+\d+%|cut\s+(?:costs?|bills?)\s+by\s+\d+%|rank\s*#?1|number\s+one)\b/i;

const UNSUPPORTED_TITLE_OPERATIONAL_TIMING =
  /\b\d+\s*(?:minutes?|hours?|days?|weeks?)\s+(?:in\s+advance|ahead|notice|lead\s+time)\b/i;

const SENSITIVE_DIETARY_TITLE_ANGLE =
  /\b(?:gluten[- ]free|dairy[- ]free|allergen[- ]free|celiac|halal|vegan|vegetarian)\b/gi;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function promisedListSize(title: string): number | null {
  const match = title.match(
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:formats?|options?|services?|ways?|steps?|types?|choices?|packages?|ideas?|questions?|factors?)\b/i,
  );
  if (!match?.[1]) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric)
    ? numeric
    : (NUMBER_WORDS[match[1].toLowerCase()] ?? null);
}

const UNSUPPORTED_TITLE_BENEFIT =
  /\b(?:hot|fresh|clean|hygienic|hygiene|safe|safer|safety|reliable|quality|impress(?:ive)?|love[ds]?|stay\s+focused|on\s+track|no\s+guesswork|with\s+ease|made\s+easy|effortless|stress[- ]free|affordable|expert|proven|efficient|fast(?:er|est)?|save\s+more|spend\s+less|lower\s+costs?|avoid\s+fees?|real\s+fees?|stronger\s+habits?|less\s+wait|shorter\s+wait|with\s+confidence|routine\s+that\s+sticks|keep\s+coming|get\s+more|make\s+(?:the\s+)?most|get\s+results?|reach\s+goals?|today|tonight|right\s+now|now)\b/gi;

const NEUTRAL_TITLE_WORDS = new Set([
  "guide",
  "practical",
  "complete",
  "compare",
  "comparison",
  "option",
  "options",
  "choose",
  "choosing",
  "pick",
  "right",
  "overview",
  "explained",
  "checklist",
  "question",
  "questions",
  "answer",
  "answers",
  "choice",
  "choices",
  "consider",
  "considering",
  "ask",
  "asking",
  "ordering",
  "planning",
  "decision",
  "decisions",
  "criteria",
  "cause",
  "causes",
  "check",
  "checks",
  "timing",
  "warning",
  "sign",
  "signs",
  "diy",
  "limit",
  "limits",
  "professional",
  "season",
  "seasonal",
  "prioritized",
  "happen",
  "happens",
  "difference",
  "differences",
  "compared",
  "clear",
  "definition",
  "use",
  "key",
  "data",
  "finding",
  "findings",
  "verified",
  "stop",
  "points",
  "decide",
  "understand",
  "understanding",
  "each",
  "feature",
  "features",
  "format",
  "formats",
  "type",
  "types",
  "way",
  "ways",
  "step",
  "steps",
  "package",
  "packages",
  "idea",
  "ideas",
  "factor",
  "factors",
  "process",
  "service",
  "services",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "does",
  "advance",
  "before",
  "after",
  "what",
  "why",
  "how",
]);

function titleWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

function capitalizeLeadingLetter(value: string): string {
  const trimmed = value.trim();
  const index = trimmed.search(/[A-Za-z]/);
  if (index < 0) return trimmed;
  return `${trimmed.slice(0, index)}${trimmed[index]!.toUpperCase()}${trimmed.slice(index + 1)}`;
}

function corpusHasWord(corpus: Set<string>, word: string): boolean {
  if (corpus.has(word)) return true;
  const singular = word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.endsWith("s")
      ? word.slice(0, -1)
      : word;
  return corpus.has(singular) || [...corpus].some((entry) => {
    const entrySingular = entry.endsWith("ies")
      ? `${entry.slice(0, -3)}y`
      : entry.endsWith("s")
        ? entry.slice(0, -1)
        : entry;
    return entrySingular === singular;
  });
}

function findUnsupportedTitleVocabulary(
  title: string,
  keyword: string,
  allowedClaims: string[],
): string[] {
  const keywordCorpus = new Set(titleWords(keyword));
  const allowedCorpus = new Set(titleWords([keyword, ...allowedClaims].join(" ")));
  return [...new Set(titleWords(title).filter((word) => {
    if (/^20\d{2}$/.test(word)) return Number(word) !== new Date().getFullYear();
    if (STOP_WORDS.has(word)) return false;
    if (NEUTRAL_TITLE_WORDS.has(word)) return false;
    if ((word === "plan" || word === "plans") && !corpusHasWord(keywordCorpus, word)) {
      return true;
    }
    return !corpusHasWord(allowedCorpus, word);
  }))];
}

export function hasUnsupportedTitleClaim(title: string): boolean {
  return UNSUPPORTED_TITLE_CLAIM.test(title);
}

export function getUnsupportedTitlePremiseReasons(
  title: string,
  keyword: string,
  allowedClaims: string[] = [],
  supportedListItemCount?: number,
): string[] {
  const reasons: string[] = [];
  if (hasUnsupportedTitleClaim(title)) reasons.push("unsupported promise or outcome");
  if (UNSUPPORTED_TITLE_OPERATIONAL_TIMING.test(title)) {
    reasons.push("operational timing premise");
  }
  const sensitiveAngles = title.match(SENSITIVE_DIETARY_TITLE_ANGLE) ?? [];
  const keywordCorpus = normalizeLocation(keyword);
  if (
    sensitiveAngles.some(
      (angle) => !keywordCorpus.includes(normalizeLocation(angle)),
    )
  ) {
    reasons.push("sensitive dietary angle absent from the target keyword");
  }
  const hasPricingPremise =
    /[$€£]\s?\d|\b(?:price|pricing|costs?|starting at)\b/i.test(title);
  const pricingIsRequested =
    /\b(?:price|pricing|costs?|fees?|quotes?|budget)\b/i.test(keyword);
  const pricingIsEvidenceBacked = allowedClaims.some((claim) =>
    /[$€£]\s?\d|\b(?:price|pricing|costs?|fees?|quotes?|budget)\b/i.test(
      claim,
    ),
  );
  if (hasPricingPremise && !pricingIsRequested && !pricingIsEvidenceBacked) {
    reasons.push("pricing premise");
  }
  const promisedItems = promisedListSize(title);
  if (
    promisedItems !== null &&
    !normalizeLocation(keyword).includes(String(promisedItems)) &&
    typeof supportedListItemCount === "number" &&
    promisedItems > supportedListItemCount
  ) {
    reasons.push(
      `numbered premise promises ${promisedItems} items but only ${supportedListItemCount} are evidence-backed`,
    );
  }
  const sensitive =
    /\b(?:law|legal|regulat\w*|compliance|mandatory|requir\w*|fine|penalt\w*|liabil\w*)\b/i.test(
      title,
    );
  if (
    sensitive &&
    !allowedClaims.some((claim) => {
      const titleWords = tokenize(title);
      const claimWords = tokenize(claim);
      const overlap = [...titleWords].filter((word) => claimWords.has(word)).length;
      return overlap >= Math.min(3, claimWords.size);
    })
  ) {
    reasons.push("sensitive or regulatory premise without evidence");
  }
  const allowedCorpus = normalizeLocation([keyword, ...allowedClaims].join(" "));
  const benefitMatches = title.match(UNSUPPORTED_TITLE_BENEFIT) ?? [];
  if (
    benefitMatches.some(
      (match) => !allowedCorpus.includes(normalizeLocation(match)),
    )
  ) {
    reasons.push("unsupported benefit language");
  }
  const unsupportedVocabulary = findUnsupportedTitleVocabulary(
    title,
    keyword,
    allowedClaims,
  );
  if (unsupportedVocabulary.length > 0) {
    reasons.push(`unsupported vocabulary: ${unsupportedVocabulary.join(", ")}`);
  }
  if (keywordMatchScore(title, keyword) < 2) {
    reasons.push("insufficient keyword alignment");
  }
  return [...new Set(reasons)];
}

export function hasUnsupportedTitlePremise(
  title: string,
  keyword: string,
  allowedClaims: string[] = [],
  supportedListItemCount?: number,
): boolean {
  return getUnsupportedTitlePremiseReasons(
    title,
    keyword,
    allowedClaims,
    supportedListItemCount,
  ).length > 0;
}

export function buildDeterministicFallbackTitle(
  keyword: string,
  city?: string | null,
  archetype?: string | null,
): GeneratedTitleOption {
  const topic = keyword.replace(/\s+/g, " ").trim() || "Business Services";
  const location = city?.replace(/\s+/g, " ").trim();
  const includesLocation = Boolean(
    location && normalizeLocation(topic).includes(normalizeLocation(location)),
  );
  const locatedTopic = location && !includesLocation
    ? `${topic} in ${location}`
    : topic;
  const normalizedArchetype = normalizeLockedTitleArchetype(archetype);
  const fallbackByArchetype: Record<
    LockedTitleArchetype,
    { title: string; structureType: string; contentIntent: GeneratedTitleOption["contentIntent"] }
  > = {
    "complete-guide": {
      title: `${locatedTopic} A Practical Guide`,
      structureType: "complete-guide",
      contentIntent: "Informational",
    },
    "how-to": {
      title: `How to Choose ${locatedTopic} With a Practical Checklist`,
      structureType: "how-to",
      contentIntent: "Informational",
    },
    listicle: {
      title: `${locatedTopic} Options Worth Comparing`,
      structureType: "list-based",
      contentIntent: "Informational",
    },
    comparison: {
      title: `${locatedTopic} Key Differences Compared`,
      structureType: "comparison",
      contentIntent: "Informational",
    },
    "service-page": {
      title: `${locatedTopic} Services and Process`,
      structureType: "service-page",
      contentIntent: "Service",
    },
  };
  const playbookStrategy = selectBlogTitlePlaybookStrategy({
    keyword: topic,
    contentArchetype: normalizedArchetype,
    location,
  });
  const fallback = normalizedArchetype
    ? fallbackByArchetype[normalizedArchetype]
    : {
        title: "",
        structureType: "process",
        contentIntent: "Informational" as const,
      };
  const titleCaseTopic = topic
    .split(" ")
    .map((word) =>
      word.length > 0
        ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
        : word,
    )
    .join(" ");
  const title = normalizedArchetype
    ? buildBlogTitlePlaybookFallback({
        keyword: topic,
        location,
        strategy: playbookStrategy,
      })
    : includesLocation
      ? `${titleCaseTopic}: Process and Questions to Ask`
      : location
        ? `What to Expect From ${titleCaseTopic} in ${location}`
        : `${titleCaseTopic}: Process and Questions to Ask`;
  return {
    title,
    seoTitle: title.slice(0, 70).trim(),
    structureType: fallback.structureType,
    contentIntent: fallback.contentIntent,
    characterCount: title.length,
    keywordPosition: title.toLowerCase().indexOf(topic.toLowerCase()) + 1,
    keywordUsed: topic,
  };
}

// ---------------------------------------------------------------------------
// T2: CTR scoring — proven signals correlated with higher click-through rates
// ---------------------------------------------------------------------------

const EMOTIONAL_MODIFIERS = new Set([
  "essential", "critical", "surprising", "proven", "ultimate", "secret",
  "powerful", "shocking", "incredible", "must-know", "crucial", "vital",
  "overlooked", "game-changing", "definitive",
]);

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "and", "or", "but", "not", "your",
  "you", "this", "that", "it", "its", "how", "what", "why", "when", "where",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/**
 * T4: Jaccard word-set similarity between two texts. Returns 0–1.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * T4: max similarity of a candidate title against any of the top SERP titles.
 */
function calculateSERPDifferentiation(title: string, serpTitles: string[]): number {
  if (serpTitles.length === 0) return 0; // no data → neutral
  const titleTokens = tokenize(title);
  let maxSim = 0;
  for (const serpTitle of serpTitles.slice(0, 5)) {
    const sim = jaccardSimilarity(titleTokens, tokenize(serpTitle));
    if (sim > maxSim) maxSim = sim;
  }
  // Return differentiation score: high similarity → penalty, low → bonus
  if (maxSim > 0.6) return -2; // too similar to competitor
  if (maxSim < 0.3) return 3;  // genuinely unique angle
  return 0; // related but not copy-paste
}

function normalizeLocation(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function hasUnsupportedTitleLocation(
  title: string,
  allowedLocations: string[],
): boolean {
  const allowed = allowedLocations.map(normalizeLocation).filter(Boolean);
  const matches = title.matchAll(
    /\b(?:in|near|around|across|throughout)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})(?=\s*[:?!|–—-]|\s*$)/g,
  );
  for (const match of matches) {
    const candidate = normalizeLocation(match[1] ?? "");
    if (["advance", "detail", "practice", "person", "general"].includes(candidate)) {
      continue;
    }
    if (
      candidate &&
      !allowed.some(
        (location) =>
          location === candidate ||
          location.includes(candidate) ||
          candidate.includes(location),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * How well the title actually contains the searched keyword (0–6). This is the
 * single biggest on-page ranking lever for the title tag, so it's weighted
 * heaviest — far above the click gimmicks below.
 */
export function keywordMatchScore(title: string, keyword: string): number {
  const kwWords = keyword
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (kwWords.length === 0) return 0;
  const titleLower = title.toLowerCase();
  if (titleLower.includes(keyword.toLowerCase())) return 6; // exact phrase
  const present = kwWords.filter((w) => titleLower.includes(w)).length;
  const ratio = present / kwWords.length;
  if (ratio >= 0.7) return 4; // close variant (most content words)
  if (ratio >= 0.5) return 2;
  return present > 0 ? 1 : 0;
}

/**
 * T2: Score a title by signals that actually correlate with ranking + clicks in
 * 2026 — keyword match, locality (for local businesses), and SERP differentiation
 * are weighted heaviest; click gimmicks (numbers, brackets, year, power words) are
 * modest and STACKING them is penalised, because that's the AI-clickbait pattern
 * users and Google distrust (same de-slop principle as the body). Range ~ -4..+18.
 */
export function scoreTitleCTR(
  title: string,
  keyword: string,
  serpTitles: string[] = [],
  location?: string,
): number {
  let score = 0;
  const titleLower = title.toLowerCase();
  const words = title.split(/\s+/);

  // ── Ranking signals (weighted heaviest) ──────────────────────────────
  score += keywordMatchScore(title, keyword); // 0..6
  if (location && titleLower.includes(location.toLowerCase())) score += 3; // local intent
  score += calculateSERPDifferentiation(title, serpTitles); // +3 unique / -2 copy

  // ── Click / clarity signals (modest) ─────────────────────────────────
  const hasEditorialListNumber =
    /(?:^|:\s*)\d+\s+(?:questions?|ways?|steps?|tips?|options?|factors?|mistakes?|things?)\b/i.test(
      title,
    );
  if (hasEditorialListNumber) score += 1;
  else if (/\b\d[\d,]*(?:\.\d+)?\b/.test(title)) score -= 3;
  if (title.length >= 50 && title.length <= 60) score += 2; // SERP sweet spot
  if (/^(what|how|why|when|where|which|can|do|does|is|are|should)\b/i.test(title)) score += 2;
  if (
    /\bservices?\b/i.test(keyword) &&
    /\b(?:compare|comparison|options?)\b/i.test(title)
  ) {
    score += 2;
  }
  if (/[\[\(].+[\]\)]/.test(title)) score += 1; // brackets (down-weighted)
  let hasModifier = false;
  for (const w of words) {
    if (EMOTIONAL_MODIFIERS.has(w.toLowerCase())) {
      hasModifier = true;
      break;
    }
  }
  if (hasModifier) score += 1;

  // ── De-slop: penalise stacked clickbait tells (year + brackets + power word) ──
  const hasYear = title.includes(String(new Date().getFullYear()));
  const gimmicks = [hasYear, /[\[\(].+[\]\)]/.test(title), hasModifier].filter(Boolean).length;
  if (gimmicks >= 2) score -= 3;

  return score;
}

export function titleSimilarityScore(left: string, right: string): number {
  return playbookTitleSimilarityScore(left, right);
}

export function titleFormatFamily(
  title: string,
): "question" | "colon" | "numbered" | "plain" {
  const value = title.trim();
  if (/\?$/.test(value) || /^(?:what|how|why|when|where|which|can|do|does|is|are|should)\b/i.test(value)) {
    return "question";
  }
  if (/:/.test(value)) return "colon";
  if (/^\d+\b/.test(value)) return "numbered";
  return "plain";
}

/**
 * Selects the best title from multiple options based on CTR scoring + quality filtering
 */
function selectBestTitle(
  titles: GeneratedTitleOption[],
  keyword: string,
  /** T2: SERP titles for differentiation scoring. Empty array if unavailable. */
  serpTitlesForScoring: string[] = [],
  /** City for the locality bonus (local businesses). */
  location?: string,
  /** Closed-world locations the title may state. */
  allowedLocations: string[] = [],
  allowedClaims: string[] = [],
  recentTitles: string[] = [],
  supportedListItemCount?: number,
  archetype?: string | null,
): GeneratedTitleOption {
  const titlePlaybookStrategy = selectBlogTitlePlaybookStrategy({
    keyword,
    contentArchetype: archetype,
    allowedClaims,
    location,
    variationSeed: `${keyword}|${location ?? ""}|${recentTitles.slice(0, 8).join("|")}`,
  });
  const filteredTitles = titles.filter((title) => {
    if (
      !isTitleStructureCompatibleWithArchetype(
        title.structureType,
        archetype,
      )
    ) {
      console.log(
        `🚫 Filtered out title with structure "${title.structureType}" because the locked content type is "${archetype}": "${title.title}"`,
      );
      return false;
    }

    const genericPatterns = [
      /^[^:]+: Complete Guide$/i,
      /^[^:]+: Complete Guide for \d{4}$/i,
      /^[^:]+: Complete Guide \d{4}$/i,
      /^[^:]+: [A-Z][a-z]+ Guide$/i,
      /^[^:]+: [A-Z][a-z]+ Guide for \d{4}$/i,
      /^[^:]+: [A-Z][a-z]+ Guide \d{4}$/i,
    ];

    const nonsensicalPatterns = [
      /what is ['"]?welcome to/i,
      /how does ['"]?welcome to/i,
      /why ['"]?welcome to/i,
      /understanding ['"]?welcome to/i,
      /guide to ['"]?welcome to/i,
      /introduction to ['"]?welcome to/i,
      /what is ['"]?get started/i,
      /what is ['"]?about us/i,
      /what is ['"]?about our/i,
      /\bwhy\s+.+\s+trusts\s+us\b/i,
    ];

    const isNonsensical = nonsensicalPatterns.some((pattern) =>
      pattern.test(title.title),
    );

    if (isNonsensical) {
      console.log(`🚫 Filtered out nonsensical title: "${title.title}"`);
      return false;
    }

    const isGeneric = genericPatterns.some((pattern) =>
      pattern.test(title.title),
    );

    if (isGeneric) {
      console.log(`🚫 Filtered out generic title: "${title.title}"`);
      return false;
    }

    const playbookFailures = getBlogTitlePlaybookFailures(
      title.title,
      titlePlaybookStrategy,
    );
    if (playbookFailures.length > 0) {
      console.log(
        `🚫 Filtered out title that violates the Blog Topic Playbook: "${title.title}" (${playbookFailures.join(",")})`,
      );
      return false;
    }

    const nearDuplicate = recentTitles.find(
      (recent) => titleSimilarityScore(title.title, recent) >= 0.92,
    );
    if (nearDuplicate) {
      console.log(
        `🚫 Filtered out title that closely repeats recent title "${nearDuplicate}": "${title.title}"`,
      );
      return false;
    }

    const geoAliases: Array<[RegExp, RegExp]> = [
      [/\bbritish columbia\b/i, /\bBC\b/],
      [/\balberta\b/i, /\bAB\b/],
      [/\bontario\b/i, /\bON\b/],
      [/\bquebec\b/i, /\bQC\b/],
    ];
    const hasRedundantGeo = geoAliases.some(
      ([full, short]) => full.test(title.title) && short.test(title.title),
    );
    if (hasRedundantGeo) {
      console.log(`🚫 Filtered out redundant location title: "${title.title}"`);
      return false;
    }

    if (hasUnsupportedTitleLocation(title.title, allowedLocations)) {
      console.log(`🚫 Filtered out unverified title location: "${title.title}"`);
      return false;
    }

    const titlePremiseReasons = getUnsupportedTitlePremiseReasons(
      title.title,
      keyword,
      allowedClaims,
      supportedListItemCount,
    );
    const seoTitlePremiseReasons = getUnsupportedTitlePremiseReasons(
      title.seoTitle,
      keyword,
      allowedClaims,
      supportedListItemCount,
    );
    if (titlePremiseReasons.length > 0 || seoTitlePremiseReasons.length > 0) {
      const reasons = [...new Set([
        ...titlePremiseReasons,
        ...seoTitlePremiseReasons.map((reason) => `SEO title: ${reason}`),
      ])];
      console.log(
        `🚫 Filtered out unsupported title: "${title.title}" (${reasons.join("; ")})`,
      );
      return false;
    }

    const titleWords = title.title.split(" ");
    const keywordLower = keyword.toLowerCase();
    const titleLower = title.title.toLowerCase();
    const keywordParts = keywordLower.split(" ").filter((p) => p.length > 0);

    if (titleWords.length >= 3 && titleLower.includes(keywordLower)) {
      const firstWord = titleWords[0];
      if (firstWord && firstWord.length > 0 && firstWord[0]) {
        const firstChar = firstWord[0];
        const isFirstWordCapitalized =
          firstChar === firstChar.toUpperCase() &&
          firstChar !== firstChar.toLowerCase();

        if (isFirstWordCapitalized && keywordParts.length >= 1) {
          let keywordMatchStart = -1;
          for (let i = 1; i < titleWords.length; i++) {
            const wordSequence = titleWords
              .slice(i, i + keywordParts.length)
              .map((w) => w.toLowerCase())
              .join(" ");
            if (wordSequence === keywordLower) {
              keywordMatchStart = i;
              break;
            }
          }

          if (keywordMatchStart === 1 && title.title.includes(":")) {
            console.log(
              `⚠️ Filtered out nonsensical location pattern: "${title.title}"`,
            );
            return false;
          }
        }
      }
    }

    return true;
  });

  const validTitles = filteredTitles;

  const preferredTitles = validTitles.filter((title) => {
    const wordCount = title.title.split(" ").length;
    return (
      title.characterCount >= 40 &&
      title.characterCount <= 70 &&
      wordCount >= 4 &&
      wordCount <= 12
    );
  });

  const titlesToChooseFrom =
    preferredTitles.length > 0 ? preferredTitles : validTitles;

  if (titlesToChooseFrom.length === 0) {
    const fallback = buildDeterministicFallbackTitle(
      keyword,
      location,
      archetype,
    );
    console.warn(
      `⚠️ Every generated title failed closed-world validation; using "${fallback.title}"`,
    );
    return fallback;
  }

  // T2+T4: Score each title by CTR signals + SERP differentiation.
  // Pick the highest-scoring title instead of the first valid one.
  const scored = titlesToChooseFrom.map((title) => ({
    title,
    ctrScore: scoreTitleCTR(title.title, keyword, serpTitlesForScoring, location),
    historyPenalty:
      Math.round(
        Math.max(
          0,
          ...recentTitles.map((recent) =>
            titleSimilarityScore(title.title, recent),
          ),
        ) * 10,
      )
      + Math.min(
        4,
        recentTitles
          .slice(0, 12)
          .filter((recent) => titleFormatFamily(recent) === titleFormatFamily(title.title))
          .length,
      ),
  }));
  // Tie-break so equal-scored titles do NOT default to generation order (the LLM
  // tends to emit its most generic title first, which then always won on ties).
  // Order of preference on a tie: a real number → ideal 50–60 char length →
  // a deterministic content hash (stable across runs, but not positional).
  const hasNumber = (t: string) =>
    /(?:^|:\s*)\d+\s+(?:questions?|ways?|steps?|tips?|options?|factors?|mistakes?|things?)\b/i.test(
      t,
    )
      ? 1
      : 0;
  const idealLength = (t: string) => (t.length >= 50 && t.length <= 60 ? 1 : 0);
  const titleHash = (t: string) => {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return h;
  };
  scored.sort((a, b) => {
    const aAdjusted = a.ctrScore - a.historyPenalty;
    const bAdjusted = b.ctrScore - b.historyPenalty;
    if (bAdjusted !== aAdjusted) return bAdjusted - aAdjusted;
    const an = hasNumber(a.title.title);
    const bn = hasNumber(b.title.title);
    if (an !== bn) return bn - an;
    const al = idealLength(a.title.title);
    const bl = idealLength(b.title.title);
    if (al !== bl) return bl - al;
    return titleHash(a.title.title) - titleHash(b.title.title);
  });

  const selectedTitle = scored[0]?.title;
  if (!selectedTitle) {
    throw new Error("No title selected");
  }

  console.log(
    `📊 Selected title: "${selectedTitle.title}" (${selectedTitle.structureType}, ${selectedTitle.contentIntent}, ${selectedTitle.characterCount} chars, rank-CTR score: ${scored[0]?.ctrScore ?? 0}/18, history penalty: ${scored[0]?.historyPenalty ?? 0})`,
  );
  if (scored.length > 1) {
    console.log(
      `   Runner-up: "${scored[1]?.title.title}" (CTR: ${scored[1]?.ctrScore ?? 0})`,
    );
  }

  return selectedTitle;
}

/**
 * Generates titles and returns an array (for frontend selection)
 */
async function generateTitlesArrayInternal(
  options: GenerateTitlesOnlyOptions,
): Promise<{ titles: GeneratedTitleOption[]; serpTitles: string[] }> {
  const {
    keyword,
    businessInfo,
    businessLocation,
    locale = "en-US",
    locationCode,
    archetype,
    recentTitles = [],
  } = options;

  const { getLocaleInfo, validateLocaleCode } =
    await import("../../utils/language.utils");
  const validLocale = validateLocaleCode(locale);
  const localeInfo = getLocaleInfo(validLocale);

  const locationStr = businessLocation?.businessCity
    ? businessLocation.businessCity
    : businessLocation?.businessState
      ? businessLocation.businessState
      : businessLocation?.businessCountry
        ? businessLocation.businessCountry
        : "";

  let serpAnalysis = null;
  let serpInsights = "";
  // T2: collect SERP titles for CTR differentiation scoring after generation.
  let collectedSerpTitles: string[] = [];

  try {
    const { getSERPTitleAnalysis } =
      await import("../../utils/dataforseo.utils");
    serpAnalysis = await getSERPTitleAnalysis(
      keyword,
      locationCode,
      validLocale.split("-")[0] || "en",
      10,
    );

    if (serpAnalysis) {
      collectedSerpTitles = (serpAnalysis.rankingTitles ?? [])
        .slice(0, 10)
        .map((t: { title: string }) => t.title);
      const patterns = serpAnalysis.titlePatterns;
      const topStructures = Object.entries(patterns.structureTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type]) => type);

      serpInsights = `
**SERP ANALYSIS INSIGHTS (Based on Real Ranking Titles):**

📊 **Current Ranking Titles Analysis:**
${serpAnalysis.rankingTitles
  .slice(0, 5)
  .map(
    (t, i) =>
      `${i + 1}. "${t.title}" (Position ${t.position}, ${t.title.length} chars)`,
  )
  .join("\n")}

📈 **Title Pattern Insights:**
- **Most Common Structure Types**: ${topStructures.join(", ")}
- **Average Title Length**: ${
        patterns.averageLength
      } characters (aim for similar length)
- **Keyword Position Trends**: 
  * Front-loaded (positions 1-3): ${patterns.keywordPosition.front} titles
  * Middle: ${patterns.keywordPosition.middle} titles
  * End: ${patterns.keywordPosition.end} titles
- **Content Intent Distribution**:
  * DIY/Educational: ${patterns.contentIntent.DIY} titles
  * Service/Sales: ${patterns.contentIntent.Service} titles
  * Informational: ${patterns.contentIntent.Informational} titles
- **Power Words Used**: ${patterns.powerWords.slice(0, 5).join(", ")}
- **Common Phrases**: ${patterns.commonPhrases.slice(0, 5).join(", ")}

💡 **Key Insights for Title Generation:**
1. **Structure Preference**: The top-ranking titles use "${
        topStructures[0]
      }" structure most frequently
2. **Length Target**: Aim for ${
        patterns.averageLength
      } characters (current average)
3. **Natural Keyword Placement**: ${
        patterns.keywordPosition.front > patterns.keywordPosition.middle
          ? "Many top titles place keywords naturally at the start, but placement varies based on title structure"
          : "Keyword placement varies naturally - integrate the keyword where it flows best"
      }
4. **Content Intent**: ${
        patterns.contentIntent.Service > patterns.contentIntent.DIY
          ? "Service-focused titles dominate"
          : patterns.contentIntent.DIY > patterns.contentIntent.Service
            ? "DIY/Educational titles are more common"
            : "Mixed intent - choose based on business goals"
      }

**IMPORTANT**: 
- Study the ranking titles above to understand how keywords are naturally integrated
- Keywords should blend seamlessly into the title, not be forced
- Prioritize human readability and natural flow over rigid keyword placement
- Use SERP patterns as inspiration, but create unique, natural-sounding titles
- Study the ranking titles above. Your titles should cover the same topic but use DIFFERENT angles, structures, or hooks. Titles that duplicate the wording of existing results will be penalized during selection.
`;

      // T3: Inject PAA questions as bonus title candidates
      if (serpAnalysis.paaQuestions && serpAnalysis.paaQuestions.length > 0) {
        serpInsights += `
**🔍 PEOPLE ALSO ASK (Real User Questions — T3):**
These are actual questions people search for about this topic. Consider adapting 2–3 of them as title candidates (shorten to 55–60 chars, add benefit/hook):
${serpAnalysis.paaQuestions.slice(0, 5).map((q, i) => `${i + 1}. "${q}"`).join("\n")}

Titles adapted from real user questions tend to get higher click-through rates because they mirror the exact language searchers use.
`;
      }
    }
  } catch (error) {
    console.warn("⚠️ SERP analysis failed, continuing without it:", error);
  }

  const currentYear = new Date().getFullYear();
  const lockedTitleFormatInstructions =
    buildLockedTitleFormatInstructions(archetype);
  const lockedStructureType = getLockedTitleStructure(archetype);
  const outputStructureTypes =
    lockedStructureType ??
    "list-based|how-to|best-practices|mistakes|alternatives|process|question";
  const titlePlaybookStrategy = selectBlogTitlePlaybookStrategy({
    keyword,
    contentArchetype: archetype,
    allowedClaims: options.allowedClaims ?? [],
    location: locationStr,
    variationSeed: `${keyword}|${locationStr}|${recentTitles.slice(0, 8).join("|")}`,
  });
  const titlePlaybookPrompt = buildBlogTitlePlaybookPrompt(
    titlePlaybookStrategy,
  );

  let prompt = `You are an expert SEO content strategist and copywriter. Generate exactly 10 diverse, natural, and engaging title options for content about "${keyword}".

**CLOSED-WORLD TITLE OVERRIDE:** Any later instruction asking for a benefit, pain-relief promise, outcome, urgency, or power word applies ONLY when that exact claim appears in BUSINESS CONTEXT. Otherwise use a neutral decision angle such as compare, options, questions, checklist, process, or how to choose. Never invent savings, speed, results, confidence, safety, quality, availability, or expertise.

**RECENT BUSINESS TITLES — DO NOT REPEAT OR CLOSELY PARAPHRASE:**
${recentTitles.length ? recentTitles.slice(0, 30).map((title) => `- ${title}`).join("\n") : "- None supplied"}

**⚠️ CRITICAL: KEYWORD SANITY CHECK (DO THIS FIRST)**

Before generating titles, analyze the keyword "${keyword}":

1. **Is this keyword grammatically correct and meaningful?**
   - ❌ BAD keywords (DO NOT USE AS-IS): "Welcome to [Business Name]", "Get Started with [Business]", "Introduction to Our Services"
   - ❌ BAD keywords: Anything that reads like a greeting, slogan, or brand introduction
   - ✅ GOOD keywords: Topic-focused keywords like "sewer repair", "website development", "shawarma recipes", "Mediterranean food Toronto"

2. **If the keyword is a BUSINESS NAME or GREETING:**
   - ❌ NEVER create: "What Is Welcome to [Business]?" or "How Does Welcome to [Business] Work?"
   - ✅ INSTEAD: Extract the core business/product type and create relevant content titles
   - Example: If keyword is "Welcome to Shawarma Moose", the actual topic is "shawarma" or "Mediterranean food"
   - Generate titles about the PRODUCT/SERVICE, NOT the welcome message

3. **If keyword contains "Welcome to", "Introduction to", "Get Started with", "About Us", etc.:**
   - These are NOT real SEO keywords - they are placeholders
   - Extract the meaningful business/product/service from the phrase
   - Generate titles about THAT topic instead

**KEYWORD TRANSFORMATION EXAMPLES:**
| Bad Keyword (DO NOT USE) | Extracted Topic | Good Title Example |
|-------------------------|-----------------|---------------------|
| "Welcome to Shawarma Moose" | shawarma, Mediterranean food | "10 Best Shawarma Recipes You Can Make at Home" |
| "Get Started with Joe's Plumbing" | plumbing services | "When to Call a Plumber: 8 Warning Signs" |
| "About Our Software Company" | software development | "How Custom Software Can Transform Your Business" |


${
  serpInsights ||
  "**Note**: SERP analysis unavailable. Generate titles based on best practices."
}

**BUSINESS CONTEXT:**
${businessInfo}

**LOCATION:** ${locationStr || "Not specified"}
Use ONLY that exact supplied location. Never substitute or add a nearby city,
neighbourhood, province, or region from SERP results or general knowledge.
**LOCALE:** ${validLocale} (${localeInfo?.variant || "Standard"})
**CURRENT YEAR:** ${currentYear}

**🚫 NON-NEGOTIABLE RANKING RULES — these OVERRIDE the formula below wherever they conflict:**
1. **KEYWORD ANCHOR:** every title MUST contain the primary keyword "${options.keyword}" or a very close natural variant that keeps its core nouns. Do NOT drift to a loosely-related synonym (e.g. do NOT turn "individually packaged lunch catering" into "meal boxes" or "office lunch"). The exact searched words are how the page ranks.
2. **LOCAL:** if a city is provided above and the topic is location-relevant, include that city in MOST of the titles — local search ranks heavily on it. Never force a city where it reads unnaturally.
3. **SPECIFIC ANGLE, NOT FILLER:** lead with a concrete, specific hook tied to the real offering. BANNED vague padding: "save time", "fast", "easy", "stress-free", "hassle-free", "what you need to know", "everything you need". BANNED forced "in ${currentYear}" unless the topic is genuinely time-sensitive.
4. **NO AI-CLICKBAIT STACKING:** use at most ONE of {a number, a year, a bracketed phrase, a power word like "ultimate/proven/secret"} per title. Titles that stack several read as machine-generated and are distrusted.

**TITLE GENERATION PRINCIPLES:**

**🎯 SEO TITLE FORMULA (MANDATORY STRUCTURE):**

Every title MUST follow this exact structure:
**[Main Topic] + [User Benefit] + [Curiosity/Clarity Element]**

**FORMULA BREAKDOWN:**

1. **Main Topic (10-15 characters):** What the article is about
   - Examples: "Leak Detection", "Plumbing Tips", "SEO Guide", "Web Design"
   
2. **User Benefit (20-30 characters):** What the user gains
   - Examples: "Save Money Fast", "Avoid Costly Repairs", "Boost Rankings", "Get More Clients"
   
3. **Curiosity/Clarity (10-15 characters):** Hook or clarity element
   - Examples: "In ${currentYear}", "Proven Methods", "Expert Tips", "Step by Step"

**FORMULA EXAMPLES:**
✅ "Leak Detection: Save Money & Avoid Water Damage Fast" (52 chars)
   └─ Topic: Leak Detection (15 chars)
   └─ Benefit: Save Money & Avoid Water Damage (30 chars)
   └─ Clarity: Fast (4 chars)

✅ "Plumbing Tips: Cut Repair Costs by 50% This Year" (51 chars)
   └─ Topic: Plumbing Tips (13 chars)
   └─ Benefit: Cut Repair Costs by 50% (24 chars)
   └─ Curiosity: This Year (9 chars)

✅ "SEO Strategy: Rank #1 on Google Without Paid Ads" (52 chars)
   └─ Topic: SEO Strategy (12 chars)
   └─ Benefit: Rank #1 on Google Without Paid Ads (35 chars)
   └─ Clarity: (implicit - without paid ads is the hook)

**🎯 CRITICAL: HUMAN CLICK BEHAVIOR FIRST, SEO SECOND**

When selecting or generating titles, optimize for human click behavior first, SEO second.
Prefer titles that describe the problem being solved or the outcome desired, rather than the technical component.
Assume the reader is a homeowner with no prior plumbing knowledge.
If one option explains why it matters and another explains how it works, prefer why it matters.

**One-line heuristic (AI-friendly):**
If a user doesn't know the tool exists, sell the pain relief—not the tool.

**EXAMPLE OF IMPROVEMENT:**
❌ BAD (sounds generated, technical focus): "Expert Foundation Waterproofing - Stop Basement Flooding"
✅ GOOD (natural, problem-focused): "Stop Basement Floods: Protect Your Home in ${currentYear}"

The improved version:
- Follows formula: Topic (Basement Floods) + Benefit (Protect Your Home) + Clarity (in ${currentYear})
- Sounds conversational and natural (not AI-generated)
- Focuses on the problem first, then the outcome
- Uses simple language anyone can understand
- 55-60 characters (SEO optimal)

1. **Natural and Human-Readable Above All**:
   - Titles must sound like they were written by a human expert, not a robot
   - Use simple language (8th grade reading level) - NO jargon or technical terms
   - Read each title aloud - if it sounds awkward or forced, rewrite it
   - The title should clearly communicate what the article is about
   - Focus on value, curiosity, and clarity - not keyword placement
   - The keyword "${keyword}" is the TOPIC of the article, but it doesn't need to be directly inserted if it makes the title sound unnatural
   - If the keyword naturally fits, use it. If forcing it makes the title awkward, write a natural title that clearly relates to the topic instead
   - **Prioritize problem-solving and outcome-focused titles over technical descriptions**
   - **Focus on the pain point or desired outcome, not the technical solution**

2. **Diverse Structure Types** (use at least 5 different types):
   - **List-based**: "Top 10 Ways to [Topic]", "[Number] Essential [Topic] Tips"
   - **How-to**: "How to [Action]: [Benefit]", "How to [Solve Problem]"
   - **Best Practices**: "[Topic] Best Practices: [Insight]", "Essential [Topic] Guidelines"
   - **Mistakes**: "[Number] Common [Topic] Mistakes to Avoid", "What Not to Do with [Topic]"
   - **Alternatives/Comparison**: "Best [Topic] Options Compared", "[Option A] vs [Option B]: Which Is Better?"
   - **Process**: "[Topic] Process: Step-by-Step Guide", "Understanding the [Topic] Process"
   - **Question/What/Why**: "What Is [Topic]? Complete Guide", "Why [Topic] Matters: [Insight]"
   - ❌ **AVOID generic patterns** like "[Keyword]: Complete Guide" or "[Keyword] [Location]: Complete Guide"
   - ❌ **AVOID nonsensical location patterns** - Never create titles like "[Location] [Keyword]" when it doesn't make grammatical sense:
     * ❌ BAD: "Toronto Leak Detection: 6 Best Practices" (doesn't make sense)
     * ✅ GOOD: "Water Leak Detection: 6 Best Practices" (clear and natural)
     * ✅ GOOD: "Leak Detection in Toronto: What You Need to Know" (location used naturally)
     * Rule: Only include location when it makes grammatical and logical sense

${
  archetype
    ? `
**🏗️ ARCHETYPE-SPECIFIC TITLE FORMAT (T1 — MANDATORY):**
Content archetype: **${archetype.toUpperCase()}**
${
  archetype === "listicle"
    ? `At least 5 of your 10 titles MUST use list/number format:
   - "Top N...", "Best N...", "N Ways to...", "N Essential...", "N Things..."
   - The number should be concrete (5, 7, 10, 12 — not vague)`
    : archetype === "how-to"
      ? `At least 5 of your 10 titles MUST use how-to/process format:
   - "How to [Action]: [Benefit]", "Step-by-Step Guide to [Topic]"
   - Focus on the action and outcome, not just the topic label`
      : archetype === "service-page"
        ? `At least 5 of your 10 titles MUST reference the service location naturally:
   - "[Service] in ${locationStr || "[City]"}: [Hook]"
   - "Why ${locationStr || "[City]"} Businesses Choose [Service]"
   - Include the city/region in a grammatically natural way`
        : `At least 5 of your 10 titles SHOULD use comprehensive/guide format:
   - "Complete Guide to [Topic]", "[Topic] Explained: Everything You Need to Know"
   - "The Ultimate [Topic] Resource for [Year/Audience]"
   - Convey thoroughness and authority`
}
The remaining 5 titles should use diverse formats from the list above for variety.
`
    : ""
}
3. **Title Quality Requirements (STRICT):**
   - **Character count: 55-60 characters ONLY** (count carefully including spaces)
   - Must follow formula: [Main Topic] + [User Benefit] + [Curiosity/Clarity]
   - Use simple language (8th grade level) - talk like a human, not a textbook
   - Match search intent (informational/commercial/transactional/navigational)
   - Engaging and creates curiosity or provides clear value
   - Clear and specific - avoid vague or generic phrasing
   - **Year usage: If mentioning a year, use ${currentYear} ONLY (NOT 2024 or 2025)**
   - **Character counting: "Hello World" = 11 characters. Count every character including spaces.**
   - ${
     locationStr
       ? `Location usage: If using location "${locationStr}", ensure it makes grammatical sense:
     * ❌ NEVER: "[Location] [Keyword]: ..." (e.g., "Toronto Leak Detection: ..." - nonsensical)
     * ✅ ALWAYS: "[Topic] in [Location]: ..." or "[Topic]: ... in [Location]" or just "[Topic]: ..." without location
     * Only include location when it adds value and sounds natural`
       : ""
   }

4. **Content Intent Analysis**:
   For each title, determine the content intent:
   - **DIY/Educational**: Content teaches users how to do something themselves
   - **Service/Sales**: Content promotes business services or helps users choose a provider
   - **Informational**: Content provides information without selling

**OUTPUT FORMAT:**

Return a JSON array with exactly 10 title objects. Each object must have:
- title: The full title (55-60 characters EXACTLY, natural and human-readable)
- seoTitle: SEO-optimized version (50-60 characters). MUST obey the NON-NEGOTIABLE RANKING RULES above — keyword-anchored, include the city for local businesses, and lead with a specific real detail. NO filler ("fast/save/easy/what you need to know"), NO forced year.
- structureType: One of: "list-based", "how-to", "best-practices", "mistakes", "alternatives", "process", "question"
- contentIntent: One of: "DIY", "Service", "Informational"
- characterCount: Number of characters in the title (must be 55-60)
- keywordPosition: Position where keyword appears (if it appears), or 0 if keyword is not directly in title but topic is clearly related
- keywordUsed: The exact keyword phrase used in this title (if keyword appears), or a related topic phrase if keyword is not directly included

**EXAMPLE OUTPUT (Following Formula: [Topic] + [Benefit] + [Curiosity/Clarity]):**
[
  {
    "title": "Emergency Plumbing in Austin: Same-Day Leak Repair Help",
    "seoTitle": "Emergency Plumbing Austin: Same-Day Leak Repair",
    "structureType": "process",
    "contentIntent": "Service",
    "characterCount": 54,
    "keywordPosition": 1,
    "keywordUsed": "emergency plumbing austin"
  },
  {
    "title": "Office Lunch Catering Toronto: Halal & Vegan Box Options",
    "seoTitle": "Office Lunch Catering Toronto: Halal, Vegan Boxes",
    "structureType": "best-practices",
    "contentIntent": "Service",
    "characterCount": 55,
    "keywordPosition": 1,
    "keywordUsed": "office lunch catering toronto"
  },
  {
    "title": "Custom Software Development: Build vs Buy, Real Costs",
    "seoTitle": "Custom Software Development: Build vs Buy Costs",
    "structureType": "alternatives",
    "contentIntent": "Informational",
    "characterCount": 52,
    "keywordPosition": 1,
    "keywordUsed": "custom software development"
  }
  ... (7 more titles, each keyword-anchored + city for local, no filler/forced-year)
]

**CRITICAL RULES:**
- Generate exactly 10 titles
- **EVERY title must be 55-60 characters (count carefully!)**
- **EVERY title must follow formula: [Main Topic] + [User Benefit] + [Curiosity/Clarity]**
- **Use simple language (8th grade level) - NO jargon, NO corporate speak**
- **Do NOT add a year unless the topic is genuinely time-sensitive; if you must, use ${currentYear} only (NOT 2024/2025) — and never alongside other gimmicks**
- Use at least 5 different structure types
- **MOST IMPORTANT: All titles must be natural, human-readable, and make sense** - read them aloud to ensure they sound like a human wrote them, NOT like AI generated them
- The keyword "${keyword}" (or a very close variant keeping its core nouns) MUST appear in every title — this is the strongest title-tag ranking signal. Only relax it if the keyword is a placeholder like "Welcome to…".
- For LOCAL businesses, include the city in MOST titles. Balance keyword placement WITH natural, human readability — both matter; do not drop the keyword for the sake of a smoother-sounding generic title.
- Avoid robotic patterns, generic phrases, and nonsensical location combinations
- **Avoid titles that sound AI-generated** - prefer conversational, question-based, or problem-focused titles
- **Character count verification**: Before finalizing each title, count the characters (including spaces). If not 55-60, adjust immediately.
- Return ONLY valid JSON array, no other text

**BEFORE GENERATING EACH TITLE, ASK YOURSELF:**
1. Does this follow the formula? [Topic] + [Benefit] + [Curiosity/Clarity]?
2. Is it 55-60 characters? (Count: "Hello World" = 11 characters)
3. Is the language simple enough for an 8th grader?
4. Would a human naturally say this, or does it sound like AI?
5. If mentioning year, is it ${currentYear}?

🚨 OUTPUT FORMAT - CRITICAL:
- Return ONLY a valid JSON array - no other text
- Start your response with [ and end with ]
- DO NOT use Markdown (no #, ##, *, **, backticks, etc.)
- DO NOT include explanations, introductions, or conclusions
- DO NOT wrap JSON in code blocks
- ONLY the raw JSON array, nothing else

Generate the 10 titles now as a JSON array:`;

  // Keep the model's actual request intentionally small. The legacy title
  // guidance above is retained temporarily for rollout comparison, but its
  // benefit-first examples conflict with the closed-world production contract.
  prompt = `Generate exactly 10 grounded SEO title candidates.

PRIMARY KEYWORD:
${keyword}

CANONICAL BUSINESS FACT PACKET:
${businessInfo}

EVIDENCE-BACKED WORDING THAT MAY APPEAR AS A FACTUAL PREMISE:
${(options.allowedClaims ?? []).length > 0
  ? (options.allowedClaims ?? []).slice(0, 80).map((claim) => `- ${claim}`).join("\n")
  : "- No additional factual premises are authorized."}

ALLOWED LOCATION:
${locationStr || "No location is authorized beyond words already in the keyword."}

RECENT TITLES TO AVOID REPEATING:
${recentTitles.length > 0
  ? recentTitles.slice(0, 30).map((title) => `- ${title}`).join("\n")
  : "- None supplied."}

LOCKED CONTENT FORMAT — NON-NEGOTIABLE:
${lockedTitleFormatInstructions}

BLOG TOPIC PLAYBOOK — TITLE DECISION:
${titlePlaybookPrompt}

RULES:
1. Every title and seoTitle must contain the exact primary keyword, preserving its words and location.
2. Use only factual nouns, attributes, services, locations, and comparisons present in the keyword or evidence-backed wording above.
3. Neutral editorial framing is allowed: guide, compare, options, questions, checklist, process, planning, selection criteria, and how to choose.
4. Do not invent benefits, outcomes, urgency, availability, timing, quality, safety, expertise, credentials, prices, statistics, regulations, or audience/use-case claims.
5. Do not narrow a broad keyword into a dietary, medical, allergen, safety, or regulatory angle unless that concept is present in the primary keyword.
6. Search-result wording is format inspiration only and is never factual evidence.
7. Produce genuinely different decision angles inside the locked content type. Do not closely paraphrase recent titles or repeat their opening and punctuation pattern. Do not reuse one generic suffix across all candidates.
8. Target 50 to 60 characters for title and seoTitle. Accuracy and natural phrasing take priority, but neither value may be shorter than 45 or longer than 65 characters. seoTitle must not introduce words or premises absent from title.
9. Write people-first, concise titles that accurately describe the page. Avoid keyword stuffing, boilerplate endings, clickbait, forced years, vague filler, and title text that the page does not fulfil.
10. Follow the selected playbook archetype and preferred variation family. Do not default to a "Topic: Hook" template. Across the 10 candidates, no more than two may contain a colon. Include a mix of natural questions and plain descriptive titles where the locked type permits; do not merely replace every colon with a dash or pipe.
11. The title and seoTitle should normally match. When they differ, keep the same meaning and primary wording so the on-page H1, Open Graph title, and Article or Service schema can remain aligned.
12. Return exactly one JSON array with 10 objects and no Markdown or commentary.

Each object must contain:
{"title":"...","seoTitle":"...","structureType":"${outputStructureTypes}","contentIntent":"DIY|Service|Informational","characterCount":0,"keywordPosition":0,"keywordUsed":"${keyword}"}`;

  try {
    const response = await llm.invoke([
      {
        role: "system",
        content: `You generate concise, people-first, closed-world SEO title candidates from a canonical fact packet. Every title must accurately describe the planned page, avoid keyword stuffing and boilerplate, and vary its structure instead of defaulting to a colon template. A title may use neutral editorial framing, but every factual premise must be present in the keyword or evidence-backed wording. Omit unsupported ideas instead of inferring them. Return valid JSON only.`,
      },
      {
        role: "user",
        content: prompt,
      },
    ]);

    const content = response.content as string;

    let titles: GeneratedTitleOption[] = [];

    let cleanedContent = content
      .replace(/```json\n?/gi, "")
      .replace(/```\n?/gi, "")
      .replace(/^#.*$/gm, "")
      .replace(/^\*\*.*\*\*$/gm, "")
      .replace(/^Here.*:?\s*$/gim, "")
      .replace(/^Generate.*:?\s*$/gim, "")
      .replace(/^The.*titles.*:?\s*$/gim, "")
      .trim();

    const jsonMatch = cleanedContent.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        titles = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error("Error parsing JSON from LLM response:", parseError);
        console.error("Raw content:", content.substring(0, 500));
        throw new Error(`Failed to parse titles JSON: ${parseError instanceof Error ? parseError.message : "Unknown parse error"}`);
      }
    } else {
      console.error("No JSON array found in response:", content.substring(0, 500));
      throw new Error("No JSON array found in LLM response. The model may have returned Markdown or text instead of JSON.");
    }

    if (!Array.isArray(titles) || titles.length === 0) {
      throw new Error("Invalid titles array from LLM");
    }

    if (titles.length > 10) {
      titles = titles.slice(0, 10);
    }

    if (titles.length < 10) {
      console.warn(
        `⚠️ LLM generated only ${titles.length} titles, expected 10`,
      );
    }

    titles = titles.map((candidate) => {
      const title = capitalizeLeadingLetter(String(candidate.title ?? ""));
      const seoTitle = capitalizeLeadingLetter(
        String(candidate.seoTitle ?? candidate.title ?? ""),
      );
      return {
        ...candidate,
        title,
        seoTitle,
        characterCount: title.length,
        keywordPosition:
          title.toLowerCase().indexOf(keyword.toLowerCase()) >= 0
            ? title.toLowerCase().indexOf(keyword.toLowerCase()) + 1
            : 0,
        keywordUsed: candidate.keywordUsed || keyword,
      };
    });

    console.log(
      `\n📝 Generated ${titles.length} titles for keyword "${keyword}":`,
    );
    titles.forEach((title, index) => {
      console.log(
        `  ${index + 1}. "${title.title}" (${title.structureType}, ${
          title.contentIntent
        }, ${title.characterCount} chars)`,
      );
    });
    console.log("");

    // Enforce the application-owned content type after generation. The prompt is
    // advisory; this filter is the actual contract boundary.
    const filteredTitles = titles.filter((title) => {
      if (
        !isTitleStructureCompatibleWithArchetype(
          title.structureType,
          archetype,
        )
      ) {
        console.log(
          `🚫 Filtered out incompatible title structure "${title.structureType}" for locked type "${archetype}": "${title.title}"`,
        );
        return false;
      }

      // Exclude direct-service structure type
      if (title.structureType === "direct-service") {
        return false;
      }

      // Exclude generic "Complete Guide" patterns
      const genericPatterns = [
        /^[^:]+: Complete Guide$/i, // "[Keyword]: Complete Guide"
        /^[^:]+: Complete Guide for \d{4}$/i, // "[Keyword]: Complete Guide for 2025"
        /^[^:]+: Complete Guide \d{4}$/i, // "[Keyword]: Complete Guide 2025"
        /^[^:]+: [A-Z][a-z]+ Guide$/i, // "[Keyword]: [Word] Guide"
        /^[^:]+: [A-Z][a-z]+ Guide for \d{4}$/i, // "[Keyword]: [Word] Guide for 2025"
        /^[^:]+: [A-Z][a-z]+ Guide \d{4}$/i, // "[Keyword]: [Word] Guide 2025"
      ];

      const isGeneric = genericPatterns.some((pattern) =>
        pattern.test(title.title),
      );

      if (isGeneric) {
        console.log(`🚫 Filtered out generic title: "${title.title}"`);
        return false;
      }

      return true;
    });

    if (filteredTitles.length === 0) {
      if (getLockedTitleStructure(archetype)) {
        throw new Error(
          `No generated titles respected the locked content type "${archetype}"`,
        );
      }
      console.warn("⚠️ All titles were filtered out. Using original titles.");
      return { titles, serpTitles: collectedSerpTitles };
    }

    // Return filtered array + SERP titles for CTR scoring
    return { titles: filteredTitles, serpTitles: collectedSerpTitles };
  } catch (error) {
    console.error("Error generating titles:", error);
    throw new Error(
      `Failed to generate titles: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

/**
 * Public function: Generates titles and auto-selects the best one (for tool usage)
 */
export async function generateTitlesOnlyLLM(
  options: GenerateTitlesOnlyOptions,
): Promise<GeneratedTitleOption> {
  // Generate array of titles + collect SERP titles for scoring
  const { titles, serpTitles } = await generateTitlesArrayInternal(options);

  let businessServiceAreas: string[] = [];
  let businessAllowedClaims: string[] = [];
  try {
    const parsed = JSON.parse(options.businessInfo) as {
      serviceAreaLocations?: unknown;
      serviceAreas?: unknown;
      allowedClaims?: Array<{ text?: unknown }>;
    };
    const serviceAreas = Array.isArray(parsed.serviceAreas)
      ? parsed.serviceAreas
      : parsed.serviceAreaLocations;
    businessServiceAreas = Array.isArray(serviceAreas)
      ? serviceAreas.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    businessAllowedClaims = Array.isArray(options.allowedClaims)
      ? options.allowedClaims.filter(Boolean)
      : Array.isArray(parsed.allowedClaims)
      ? parsed.allowedClaims
          .map((claim) => (typeof claim?.text === "string" ? claim.text : ""))
          .filter(Boolean)
      : [];
  } catch {
    businessServiceAreas = [];
    businessAllowedClaims = [];
  }
  const allowedLocations = [
    options.businessLocation?.businessCity,
    options.businessLocation?.businessState,
    options.businessLocation?.businessCountry,
    ...businessServiceAreas,
  ].filter((value): value is string => Boolean(value?.trim()));

  // T2: Auto-select the best title using CTR scoring + SERP differentiation.
  // Pass the city so locally-anchored titles win the locality bonus.
  const selectedTitle = selectBestTitle(
    titles,
    options.keyword,
    serpTitles,
    options.businessLocation?.businessCity,
    allowedLocations,
    businessAllowedClaims,
    options.recentTitles ?? [],
    options.supportedListItemCount,
    options.archetype,
  );

  console.log(`\n🎯 Selected best title: "${selectedTitle.title}"`);
  console.log(`   Structure: ${selectedTitle.structureType}`);
  console.log(`   Intent: ${selectedTitle.contentIntent}`);
  console.log(`   Characters: ${selectedTitle.characterCount}`);
  console.log(`   Keyword Position: ${selectedTitle.keywordPosition}\n`);

  return selectedTitle;
}

/**
 * Public function: Generates titles and returns array (for frontend)
 */
export async function generateTitlesArrayForFrontend(
  options: GenerateTitlesOnlyOptions,
): Promise<GeneratedTitleOption[]> {
  const { titles } = await generateTitlesArrayInternal(options);
  return titles;
}
