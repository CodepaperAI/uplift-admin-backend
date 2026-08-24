export type BlogTitlePlaybookArchetype =
  | "first-party-data"
  | "cost-pricing"
  | "symptom-diagnosis"
  | "comparison"
  | "lifespan-timing"
  | "diy-vs-pro"
  | "local-seasonal"
  | "process-expectation"
  | "mistakes-red-flags"
  | "case-study"
  | "how-to"
  | "best-of-listicle"
  | "competitor-comparison"
  | "glossary-definition";

export type BlogTitleVariationFamily =
  | "question"
  | "plain"
  | "colon"
  | "comparison"
  | "numbered";

export type BlogTopicSourceIntent =
  | "informational"
  | "commercial-investigation"
  | "transactional-or-service"
  | "ambiguous";

export interface BlogTitlePlaybookStrategy {
  archetype: BlogTitlePlaybookArchetype;
  label: string;
  rationale: string;
  preferredTitleShapes: string[];
  allowedSpecificityHooks: string[];
  variationFamily: BlogTitleVariationFamily;
  /**
   * The playbook chooses the article topic before it chooses title grammar.
   * These fields are optional for backwards compatibility with frozen recovery
   * artifacts created before the topic-planning contract existed.
   */
  sourceIntent?: BlogTopicSourceIntent;
  requiresSerpValidation?: boolean;
  topicDirective?: string;
  substantiveItemCount?: number | null;
}

export interface SelectBlogTitlePlaybookInput {
  keyword: string;
  contentArchetype?: string | null;
  allowedClaims?: string[];
  location?: string | null;
  variationSeed?: string;
  preferredVariationFamily?: BlogTitleVariationFamily | null;
}

export interface BlogTitlePlaybookAllocationItem
  extends SelectBlogTitlePlaybookInput {
  id: string;
  businessId: string;
  publishDate: string;
}

export interface BlogTitlePlaybookAllocation {
  id: string;
  businessId: string;
  publishDate: string;
  candidateFamilies: BlogTitleVariationFamily[];
  strategy: BlogTitlePlaybookStrategy;
}

export type BlogTopicSerpDecision =
  | "blog-owned"
  | "money-page-owned"
  | "insufficient-evidence";

export interface BlogTopicSerpValidation {
  decision: BlogTopicSerpDecision;
  resultCount: number;
  blogPageCount: number;
  moneyPageCount: number;
  dominantFormat: string | null;
  rationale: string;
}

const GENERIC_TITLE_FORMULA =
  /\b(?:a practical guide to|practical guide|complete guide|ultimate guide|everything you need to know|definitive guide)\b/i;
const GENERIC_PLAYBOOK_TITLE_SHAPE =
  /\b(?:from first step to next decision|process and questions to ask|options compared by clear criteria|steps and stop points|options compared:\s*who each is for|definition, use, and key questions|explained in practical terms)\b/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const TITLE_VARIATION_FAMILIES_BY_ARCHETYPE: Record<
  BlogTitlePlaybookArchetype,
  BlogTitleVariationFamily[]
> = {
    "first-party-data": ["plain", "colon", "numbered"],
    "cost-pricing": ["question", "plain", "colon"],
    "symptom-diagnosis": ["question", "numbered", "plain"],
    comparison: ["comparison", "question", "plain"],
    "lifespan-timing": ["question", "numbered", "plain"],
    "diy-vs-pro": ["question", "comparison", "plain"],
    "local-seasonal": ["plain", "numbered", "colon"],
    "process-expectation": ["question", "plain", "colon"],
    "mistakes-red-flags": ["numbered", "question", "plain"],
    "case-study": ["colon", "plain"],
    "how-to": ["question", "plain", "numbered"],
    "best-of-listicle": ["numbered", "question", "plain", "comparison"],
    "competitor-comparison": ["comparison", "question", "plain"],
    "glossary-definition": ["question", "plain", "colon"],
  };

function variationFamilyCandidates(
  archetype: BlogTitlePlaybookArchetype,
  canUseNumberedTitle: boolean,
  requiresNumberedTitle = false,
): BlogTitleVariationFamily[] {
  if (requiresNumberedTitle) return ["numbered"];
  const configuredCandidates = TITLE_VARIATION_FAMILIES_BY_ARCHETYPE[archetype];
  return canUseNumberedTitle
    ? [...configuredCandidates]
    : configuredCandidates.filter((candidate) => candidate !== "numbered");
}

function variationFamily(
  seed: string,
  archetype: BlogTitlePlaybookArchetype,
  canUseNumberedTitle: boolean,
): BlogTitleVariationFamily {
  const configuredCandidates = TITLE_VARIATION_FAMILIES_BY_ARCHETYPE[archetype];
  const candidates = canUseNumberedTitle
    ? configuredCandidates
    : configuredCandidates.filter((candidate) => candidate !== "numbered");
  return candidates[stableHash(seed) % candidates.length]!;
}

function hasVerifiedNumericEvidence(claims: string[]): boolean {
  return claims.some(
    (claim) =>
      /\b\d[\d,.]*\b/.test(claim) &&
      /\b(?:analysed|analyzed|calls?|customers?|jobs?|orders?|projects?|responses?|survey|sample|study|records?|reviews?)\b/i.test(
        claim,
      ),
  );
}

function keywordRequiresNumberedTitle(keyword: string): boolean {
  return /\b(?:top\s+)?\d{1,3}\s+(?:ways?|tips?|ideas?|options?|things?|companies|businesses|steps?|mistakes?|questions?|checks?|signs?|examples?|reasons?|strategies?)\b/.test(
    keyword,
  );
}

function hasVerifiedCaseEvidence(claims: string[]): boolean {
  return claims.some((claim) =>
    /\b(?:case study|completed job|completed project|before and after|project date|project cost)\b/i.test(
      claim,
    ),
  );
}

function sourceIntentForKeyword(keyword: string): {
  sourceIntent: BlogTopicSourceIntent;
  requiresSerpValidation: boolean;
} {
  const informationalCue =
    /\b(?:how|what|why|when|tips?|ideas?|checklist|mistakes?|red flags?|signs?|basics?|explained|meaning|definition|cost|price|vs|versus|compare|comparison|best|top|ways?|questions?|guide|learn)\b/;
  if (informationalCue.test(keyword)) {
    return {
      sourceIntent: /\b(?:best|top|compare|comparison|vs|versus)\b/.test(
        keyword,
      )
        ? "commercial-investigation"
        : "informational",
      // The playbook requires a live SERP ownership check for every topic,
      // including apparently informational queries.
      requiresSerpValidation: true,
    };
  }
  if (
    /\b(?:buy|order|book|booking|for sale|near me|menu|services?|company|contractor|lawyer|clinic|hotel|motel)\b/.test(
      keyword,
    )
  ) {
    return {
      sourceIntent: "transactional-or-service",
      requiresSerpValidation: true,
    };
  }
  return { sourceIntent: "ambiguous", requiresSerpValidation: true };
}

function inferredTopicDirective(
  archetype: BlogTitlePlaybookArchetype,
  substantiveItemCount: number | null,
): string {
  const directives: Record<BlogTitlePlaybookArchetype, string> = {
    "first-party-data":
      "Build the entire article around the verified dataset, its method, its findings, and its limits. Do not turn it into a generic service explainer.",
    "cost-pricing":
      "Build the entire article around price drivers, quote comparison, inclusions, exclusions, and budgeting questions supported by supplied evidence.",
    "symptom-diagnosis":
      "Build the entire article around symptoms, safe checks, possible causes, and the point at which qualified help is appropriate.",
    comparison:
      "Build the entire article as a criteria-led comparison. Use a consistent set of decision criteria and explain who each option fits.",
    "lifespan-timing":
      "Build the entire article around timing, frequency, warning signs, and factors that change the answer; do not invent a universal duration.",
    "diy-vs-pro":
      "Build the entire article around safe DIY limits, professional scope, risk, and a clear decision boundary.",
    "local-seasonal":
      "Build the entire article as a locally relevant seasonal preparation or timing checklist using only verified local facts.",
    "process-expectation":
      "Build the entire article around the stages of a process and what a reader should verify at each stage. Use this only when process intent is genuinely present.",
    "mistakes-red-flags":
      `Build the entire article around ${substantiveItemCount ?? "substantive"} mistakes, decision risks, or pre-decision questions. Name each concern precisely and give it enough depth to stand alone. Treat labels such as "red flag" as occasional emphasis, not a repeated heading or list-item template.`,
    "case-study":
      "Build the entire article around one verified job: problem, constraints, decision, work performed, result, and limitations.",
    "how-to":
      `Build the entire article as ${substantiveItemCount ?? "a"} ordered steps with explicit stop points and safety limits.`,
    "best-of-listicle":
      `Build the entire article as ${substantiveItemCount ?? "a"} substantive items, each with real depth. If it ranks businesses or products, require verifiable selection criteria, a disclosure, and fair facts; otherwise make it a non-ranking tips or decision list.`,
    "competitor-comparison":
      "Build the entire article as a fair, criteria-led competitor comparison using only verifiable public facts and honest fit guidance.",
    "glossary-definition":
      "Build the entire article around a concise definition, why the term matters, practical implications, and links to the relevant service or resource.",
  };
  return directives[archetype];
}

function titleStrategyDetails(
  archetype: BlogTitlePlaybookArchetype,
): Omit<BlogTitlePlaybookStrategy, "variationFamily"> {
  const details: Record<
    BlogTitlePlaybookArchetype,
    Omit<BlogTitlePlaybookStrategy, "variationFamily">
  > = {
    "first-party-data": {
      archetype,
      label: "First-party data study",
      rationale: "The query asks for statistics or analysis and verified numeric evidence is available.",
      preferredTitleShapes: [
        "We analyzed [verified sample]: [specific finding]",
        "[Topic] data: findings from [verified sample]",
      ],
      allowedSpecificityHooks: ["verified sample size", "verified date range", "verified location"],
    },
    "cost-pricing": {
      archetype,
      label: "Cost and pricing transparency",
      rationale: "The query explicitly asks about cost, price, fees, quotes, or budget.",
      preferredTitleShapes: [
        "How much does [topic] cost?",
        "[Topic] cost: factors that change the quote",
      ],
      allowedSpecificityHooks: ["location", "current year when time-sensitive", "verified price or range only"],
    },
    "symptom-diagnosis": {
      archetype,
      label: "Symptom and diagnosis",
      rationale: "The query describes an active symptom, fault, warning sign, or failure.",
      preferredTitleShapes: [
        "[Symptom]? Checks to make before the next step",
        "[Number] [symptoms] decoded: what each can mean",
      ],
      allowedSpecificityHooks: ["verified symptom count", "safe check", "professional escalation threshold"],
    },
    comparison: {
      archetype,
      label: "Option comparison",
      rationale: "The query explicitly compares two or more options.",
      preferredTitleShapes: [
        "[Option A] vs [Option B]: which fits which situation?",
        "[Topic] compared by the criteria buyers use",
      ],
      allowedSpecificityHooks: ["verified options", "location", "decision criterion"],
    },
    "lifespan-timing": {
      archetype,
      label: "Lifespan and timing",
      rationale: "The query asks how long something lasts, when to replace it, or how often to act.",
      preferredTitleShapes: [
        "How long does [topic] last?",
        "[Number] signs it may be time to [action]",
      ],
      allowedSpecificityHooks: ["verified duration", "location", "verified warning-sign count"],
    },
    "diy-vs-pro": {
      archetype,
      label: "DIY versus professional",
      rationale: "The query asks what a reader can do personally and where professional help begins.",
      preferredTitleShapes: [
        "Can you [task] yourself?",
        "DIY or professional? Where the line sits for [topic]",
      ],
      allowedSpecificityHooks: ["safe task", "verified jurisdiction", "professional escalation point"],
    },
    "local-seasonal": {
      archetype,
      label: "Local and seasonal guide",
      rationale: "The query contains a season, weather period, deadline, or clearly local preparation intent.",
      preferredTitleShapes: [
        "[Location] [season] [topic] checklist",
        "Prepare [topic] for [season]: a prioritized checklist",
      ],
      allowedSpecificityHooks: ["verified location", "season", "verified deadline"],
    },
    "process-expectation": {
      archetype,
      label: "Process and what to expect",
      rationale: "The query explicitly asks what happens, what to expect, or how a process unfolds.",
      preferredTitleShapes: [
        "What happens during [topic]?",
        "[Topic]: what the process looks like",
      ],
      allowedSpecificityHooks: ["verified timeline", "location", "named process stage"],
    },
    "mistakes-red-flags": {
      archetype,
      label: "Mistakes and decision checks",
      rationale: "The query asks what to avoid or represents a high-consideration decision that benefits from pre-decision checks.",
      preferredTitleShapes: [
        "[Number] [topic] mistakes worth checking before you decide",
        "Questions to ask before [topic]",
      ],
      allowedSpecificityHooks: ["evidence-backed count", "verified risk", "decision question"],
    },
    "case-study": {
      archetype,
      label: "Case-study breakdown",
      rationale: "The query requests a case study and verified project evidence is available.",
      preferredTitleShapes: [
        "Case study: [verified problem], decision, and result",
        "How [verified project] unfolded in [verified location]",
      ],
      allowedSpecificityHooks: ["verified location", "verified cost", "verified timeline", "verified outcome"],
    },
    "how-to": {
      archetype,
      label: "How-to guide",
      rationale: "The query asks how to complete a task or names an installation/setup task that can support ordered steps.",
      preferredTitleShapes: [
        "How to [task]",
        "[Task]: a clear step-by-step approach",
      ],
      allowedSpecificityHooks: ["verified step count", "verified time", "difficulty"],
    },
    "best-of-listicle": {
      archetype,
      label: "Best-of or substantive listicle",
      rationale: "The query asks for best/top choices or naturally supports a substantive tips, ideas, checklist, buying, menu, or option list.",
      preferredTitleShapes: [
        "[Number] [topic] ideas worth considering",
        "How to compare [topic] options",
      ],
      allowedSpecificityHooks: ["evidence-backed item count", "verified location", "selection criteria"],
    },
    "competitor-comparison": {
      archetype,
      label: "Competitor comparison",
      rationale: "The query names a competitor, alternative, or brand-versus-brand decision.",
      preferredTitleShapes: [
        "[Brand A] vs [Brand B]: a criteria-led comparison",
        "Alternatives to [brand]: what to compare",
      ],
      allowedSpecificityHooks: ["verified competitor", "published fact", "decision criterion"],
    },
    "glossary-definition": {
      archetype,
      label: "Knowledge-base definition",
      rationale: "The query asks what a term means or requests a foundational explanation.",
      preferredTitleShapes: [
        "What is [topic], and why does it matter?",
        "[Topic] explained in practical terms",
      ],
      allowedSpecificityHooks: ["verified location", "practical implication", "verified threshold"],
    },
  };
  return details[archetype];
}

export function selectBlogTitlePlaybookStrategy(
  input: SelectBlogTitlePlaybookInput,
): BlogTitlePlaybookStrategy {
  const keyword = normalize(input.keyword);
  const claims = input.allowedClaims ?? [];
  const contentArchetype = normalize(input.contentArchetype ?? "");
  const sourceIntent = sourceIntentForKeyword(keyword);

  let archetype: BlogTitlePlaybookArchetype;
  if (
    /\b(?:data|statistics?|survey|study|we analyzed|we analysed|average|most common)\b/.test(keyword) &&
    hasVerifiedNumericEvidence(claims)
  ) {
    archetype = "first-party-data";
  } else if (/\b(?:mistakes?|red flags?|scams?|warning signs?|questions to ask|avoid)\b/.test(keyword)) {
    // An explicit risk/avoidance query is more specific than incidental words
    // such as "quote" or "price" (for example, "roofing quote red flags").
    archetype = "mistakes-red-flags";
  } else if (/\b(?:cost|costs|price|prices|pricing|fee|fees|quote|quotes|budget)\b/.test(keyword)) {
    archetype = "cost-pricing";
  } else if (/\b(?:vs|versus|compare|comparison|difference between|which is better)\b/.test(keyword)) {
    archetype = /\b(?:alternative|alternatives|competitor|reviews?)\b/.test(keyword)
      ? "competitor-comparison"
      : "comparison";
  } else if (/\b(?:pros?\s+and\s+cons?|advantages?\s+and\s+disadvantages?)\b/.test(keyword)) {
    archetype = "comparison";
  } else if (/\b(?:benefits?|advantages?)\b/.test(keyword)) {
    // Benefit-led queries already express a clear list/decision intent. Do
    // not send them through broad-seed rotation, where a stable hash could
    // turn the requested benefits into unrelated mistakes or red flags.
    archetype = "best-of-listicle";
  } else if (/\b(?:alternative|alternatives to|competitor|reviews of)\b/.test(keyword)) {
    archetype = "competitor-comparison";
  } else if (/\b(?:how long|lifespan|lasts?|when to replace|how often|final year)\b/.test(keyword)) {
    archetype = "lifespan-timing";
  } else if (/\b(?:diy|do it yourself|can i|can you|myself|yourself)\b/.test(keyword)) {
    archetype = "diy-vs-pro";
  } else if (/\b(?:winter|spring|summer|fall|autumn|seasonal|pre winter|pre-winter)\b/.test(keyword)) {
    archetype = "local-seasonal";
  } else if (
    /\b(?:what happens|what to expect|process|during the appointment|during a|during an)\b/.test(
      keyword,
    ) || contentArchetype === "process expectation"
  ) {
    archetype = "process-expectation";
  } else if (/\b(?:case study|job breakdown|project breakdown)\b/.test(keyword) && hasVerifiedCaseEvidence(claims)) {
    archetype = "case-study";
  } else if (/^(?:how to|how do|how can)\b|\b(?:step by step|tutorial|installation|installing|setup)\b/.test(keyword) || contentArchetype === "how to") {
    archetype = "how-to";
  } else if (/\b(?:best|top \d+|list of|\d+ (?:ways|tips|ideas|options)|roundup|tips?|ideas?|checklist|things to|buy\b.*\bonline|menu|family suites?|chicken wings)\b/.test(keyword) || contentArchetype === "listicle") {
    archetype = "best-of-listicle";
  } else if (/^(?:what is|what are|define)\b|\b(?:meaning|definition|explained|basics?|fundamentals?)\b/.test(keyword)) {
    archetype = "glossary-definition";
  } else if (/\b(?:not working|leaking|noise|noises|warm air|cold|broken|failure|fault|problem|symptom|pain)\b/.test(keyword)) {
    archetype = "symptom-diagnosis";
  } else if (/\b(?:equipment|materials?|systems?|types?)\b/.test(keyword)) {
    archetype = "comparison";
  } else if (/\b(?:commercial cleaning|home renovations?|contractor|provider)\b/.test(keyword)) {
    archetype = "mistakes-red-flags";
  } else if (contentArchetype === "comparison") {
    archetype = "comparison";
  } else {
    // A broad seed is not evidence of process intent. Rotate broad topics across
    // conservative upstream article formats instead of turning an entire batch
    // into "what happens" posts. Explicit cues above still take precedence.
    const broadSeedArchetypes: BlogTitlePlaybookArchetype[] = [
      "mistakes-red-flags",
      "glossary-definition",
      "how-to",
      "best-of-listicle",
    ];
    const seed = input.variationSeed ?? `${input.keyword}|${input.location ?? ""}`;
    archetype = broadSeedArchetypes[stableHash(seed) % broadSeedArchetypes.length]!;
  }

  const details = titleStrategyDetails(archetype);
  const keywordContainsSupportedNumber =
    /\b(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(
      keyword,
    );
  const requiresNumberedTitle = keywordRequiresNumberedTitle(keyword);
  const editorialListCount =
    archetype === "best-of-listicle" &&
    /\b(?:tips?|ideas?|checklist|things to|menu|family suites?|chicken wings|buy\b.*\bonline)\b/.test(
      keyword,
    ) &&
    !/\b(?:top \d+|\d+ (?:ways|tips|ideas|options|things))\b/.test(keyword)
      ? 7
      : archetype === "mistakes-red-flags" &&
          /\b(?:mistakes?|red flags?|warning signs?|questions to ask|avoid|renovations?|contractor|provider)\b/.test(
            keyword,
          )
        ? 7
        : null;
  const canUseNumberedTitle =
    keywordContainsSupportedNumber ||
    editorialListCount !== null ||
    (archetype === "first-party-data" && hasVerifiedNumericEvidence(claims));
  const seed =
    input.variationSeed ?? `${input.keyword}|${input.location ?? ""}`;
  const candidateFamilies = variationFamilyCandidates(
    archetype,
    canUseNumberedTitle,
    requiresNumberedTitle,
  );
  const assignedVariationFamily =
    input.preferredVariationFamily &&
    candidateFamilies.includes(input.preferredVariationFamily)
      ? input.preferredVariationFamily
      : variationFamily(seed, archetype, canUseNumberedTitle);
  return {
    ...details,
    variationFamily: assignedVariationFamily,
    ...sourceIntent,
    topicDirective: inferredTopicDirective(archetype, editorialListCount),
    substantiveItemCount: editorialListCount,
  };
}

export function getBlogTitleVariationFamilyCandidates(input: {
  keyword: string;
  strategy: BlogTitlePlaybookStrategy;
  allowedClaims?: string[];
}): BlogTitleVariationFamily[] {
  const keyword = normalize(input.keyword);
  const claims = input.allowedClaims ?? [];
  const keywordContainsSupportedNumber =
    /\b(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(
      keyword,
    );
  const requiresNumberedTitle = keywordRequiresNumberedTitle(keyword);
  const canUseNumberedTitle =
    keywordContainsSupportedNumber ||
    input.strategy.substantiveItemCount !== null ||
    (input.strategy.archetype === "first-party-data" &&
      hasVerifiedNumericEvidence(claims));
  return variationFamilyCandidates(
    input.strategy.archetype,
    canUseNumberedTitle,
    requiresNumberedTitle,
  );
}

export function allocateBlogTitlePlaybookStrategies(input: {
  items: BlogTitlePlaybookAllocationItem[];
  recentFamiliesByBusiness?: Record<string, BlogTitleVariationFamily[]>;
}): BlogTitlePlaybookAllocation[] {
  const ordered = [...input.items].sort((left, right) =>
    [left.publishDate, left.businessId, left.id]
      .join(":")
      .localeCompare([right.publishDate, right.businessId, right.id].join(":")),
  );
  const businessFamilies = new Map<string, BlogTitleVariationFamily[]>();
  for (const [businessId, families] of Object.entries(
    input.recentFamiliesByBusiness ?? {},
  )) {
    businessFamilies.set(businessId, [...families]);
  }
  const globalCounts = new Map<BlogTitleVariationFamily, number>();
  const maximumGlobalFamilyCount = Math.max(1, Math.ceil(ordered.length * 0.3));

  return ordered.map((item) => {
    const base = selectBlogTitlePlaybookStrategy({
      ...item,
      preferredVariationFamily: null,
    });
    const candidateFamilies = getBlogTitleVariationFamilyCandidates({
      keyword: item.keyword,
      strategy: base,
      allowedClaims: item.allowedClaims,
    });
    const history = businessFamilies.get(item.businessId) ?? [];
    const businessCounts = new Map<BlogTitleVariationFamily, number>();
    for (const family of history) {
      businessCounts.set(family, (businessCounts.get(family) ?? 0) + 1);
    }
    const lastFamily = history.at(-1) ?? null;
    const selectedFamily = [...candidateFamilies].sort((left, right) => {
      const score = (family: BlogTitleVariationFamily) =>
        (family === lastFamily ? 10_000 : 0) +
        (businessCounts.get(family) ?? 0) * 1_000 +
        ((globalCounts.get(family) ?? 0) >= maximumGlobalFamilyCount
          ? 1_000_000
          : 0) +
        (globalCounts.get(family) ?? 0) * 10 +
        (stableHash(`${item.id}|${family}`) % 10);
      return score(left) - score(right);
    })[0]!;
    history.push(selectedFamily);
    businessFamilies.set(item.businessId, history);
    globalCounts.set(selectedFamily, (globalCounts.get(selectedFamily) ?? 0) + 1);
    return {
      id: item.id,
      businessId: item.businessId,
      publishDate: item.publishDate,
      candidateFamilies,
      strategy: selectBlogTitlePlaybookStrategy({
        ...item,
        preferredVariationFamily: selectedFamily,
      }),
    };
  });
}

export function buildBlogTitlePlaybookPrompt(
  strategy: BlogTitlePlaybookStrategy,
): string {
  const familyRule: Record<BlogTitleVariationFamily, string> = {
    question: "End as a direct, useful question with a question mark.",
    plain: "Use a plain headline: no leading list number, colon, or question mark.",
    colon: "Use one concise colon construction.",
    comparison: "Make the comparison explicit with 'vs', 'compared', 'comparison', or an equivalent decision cue.",
    numbered:
      "Use the application-selected item count in the title and build exactly that many substantive core items in the article.",
  };
  return [
    `Selected article topic archetype: ${strategy.label} (${strategy.archetype}).`,
    `Selection reason: ${strategy.rationale}`,
    `Source-query intent: ${strategy.sourceIntent ?? "legacy-unknown"}. Live SERP validation required before publication: ${strategy.requiresSerpValidation === true ? "yes" : "no"}.`,
    `Article-level topic directive: ${strategy.topicDirective ?? inferredTopicDirective(strategy.archetype, strategy.substantiveItemCount ?? null)}`,
    strategy.substantiveItemCount
      ? `Required substantive core-item count: ${strategy.substantiveItemCount}. The title must use this count and the body must contain exactly ${strategy.substantiveItemCount} numbered core sections or list items.`
      : "No application-selected list count is required for this article.",
    `Preferred variation for this article: ${strategy.variationFamily}.`,
    `Variation-family rule: ${familyRule[strategy.variationFamily]}`,
    `Useful title shapes: ${strategy.preferredTitleShapes.join(" | ")}.`,
    `Permitted specificity hooks, only when verified in the supplied facts: ${strategy.allowedSpecificityHooks.join(", ")}.`,
    "The archetype and topic directive govern the whole article, not only its headline. Do not fall back to a process/what-to-expect article unless process-expectation is the selected archetype.",
    "Use the real query with one truthful specificity hook. An editorial item count is allowed only when the body contains exactly that many substantive items. Never invent a year, price, statistic, sample size, location, deadline, result, credential, ranking, or case-study fact.",
    "Write like a calm, credible professional, not an alarmist or a template. Archetype labels and title shapes are private planning cues, not wording to repeat. Name each concern specifically; use catchphrases such as 'red flag' only when they are genuinely the clearest wording, and never as the repeated prefix for headings or list items.",
    "Keep the title at 70 characters or fewer unless the supplied keyword alone makes that impossible.",
    "Do not use a generic guide formula. The title must not begin with or contain 'A Practical Guide', 'Complete Guide', 'Ultimate Guide', 'Definitive Guide', or 'Everything You Need to Know'.",
  ].join("\n");
}

export function getBlogTopicStructureFailures(
  title: string,
  articleHtml: string,
  strategy: BlogTitlePlaybookStrategy,
): string[] {
  const requiredCount = strategy.substantiveItemCount ?? null;
  if (!requiredCount) return [];

  const failures: string[] = [];
  const titleCount = title.trim().match(/^(\d{1,2})\b/);
  if (
    strategy.variationFamily === "numbered" &&
    (!titleCount || Number(titleCount[1]) !== requiredCount)
  ) {
    failures.push(`title_missing_required_item_count:${requiredCount}`);
  }

  const numberedHeadings = [...articleHtml.matchAll(/<h2\b[^>]*>\s*(\d{1,2})(?:[.):\-]|\s)/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value));
  const orderedListCounts = [...articleHtml.matchAll(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi)]
    .map((match) => [...match[1]!.matchAll(/<li\b/gi)].length);
  const hasExactNumberedHeadings =
    numberedHeadings.length === requiredCount &&
    numberedHeadings.every((value, index) => value === index + 1);
  const hasExactOrderedList = orderedListCounts.some(
    (count) => count === requiredCount,
  );
  if (!hasExactNumberedHeadings && !hasExactOrderedList) {
    failures.push(`article_missing_required_item_count:${requiredCount}`);
  }
  return failures;
}

export function evaluateBlogTopicSerpOwnership(input: {
  dominantFormat?: string | null;
  top10Results?: Array<{
    title?: string | null;
    url?: string | null;
    structure?: string | null;
  }> | null;
}): BlogTopicSerpValidation {
  const results = Array.isArray(input.top10Results)
    ? input.top10Results.filter((result) => result?.url || result?.title)
    : [];
  let blogPageCount = 0;
  let moneyPageCount = 0;
  let topThreeBlogCount = 0;
  let topThreeMoneyCount = 0;
  for (const [index, result] of results.entries()) {
    const title = normalize(result.title ?? "");
    const url = String(result.url ?? "").toLowerCase();
    const structure = normalize(result.structure ?? "");
    let shallowPath = false;
    let pathSegmentCount = 0;
    let blogSubdomain = false;
    let officialGuidanceHost = false;
    try {
      const parsed = new URL(url);
      const pathSegments = parsed.pathname.split("/").filter(Boolean);
      pathSegmentCount = pathSegments.length;
      shallowPath = pathSegmentCount <= 2;
      blogSubdomain = parsed.hostname.startsWith("blog.");
      const officialHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
      // Government service trees publish guidance, forms, checklists, and
      // eligibility explanations; `/services/` on those domains is not a
      // commercial money page. Treat public guidance as informational even
      // when a generic SERP classifier labels its structure as "service".
      officialGuidanceHost =
        officialHost === "canada.ca" ||
        officialHost.endsWith(".canada.ca") ||
        officialHost === "gc.ca" ||
        officialHost.endsWith(".gc.ca") ||
        officialHost.endsWith(".gov") ||
        officialHost === "gov.uk" ||
        officialHost.endsWith(".gov.uk") ||
        officialHost.endsWith(".gov.au") ||
        officialHost === "gov.in" ||
        officialHost.endsWith(".gov.in") ||
        /(?:^|\.)(?:ontario|alberta|quebec|novascotia|saskatchewan)\.ca$/.test(
          officialHost,
        );
    } catch {
      shallowPath = false;
    }
    const hasExplicitBlogPath =
      /\/(?:blogs?|articles?|learn|resources?|guides?|news)(?:\/|$|[?#])/.test(
        url,
      ) || blogSubdomain;
    const hasExplicitMoneyPath =
      /\/(?:collections?|products?|services?|menu|orders?|booking|book|shop|store|category|practice-areas?|coaching|personal-training|rentals?|rooms?|catering|locations?)(?:\/|$|[?#])/.test(
        url,
      );
    const hasInformationalTitle =
      /\b(?:how to|how do|how can|what to|why\b|when\b|which\b|tips?|checklist|guide|tutorial|step by step|questions? to ask|according to|ways? to|easiest way)\b/.test(
        title,
      );
    const informationalStructure = [
      "article",
      "guide",
      "list",
      "how to",
      "how-to",
    ].includes(structure);
    const deterministicInformationalOverride =
      shallowPath &&
      pathSegmentCount > 0 &&
      hasInformationalTitle &&
      !hasExplicitMoneyPath;
    const looksLikeMoneyPage =
      (!officialGuidanceHost && hasExplicitMoneyPath) ||
      (!officialGuidanceHost &&
        structure === "service" &&
        !deterministicInformationalOverride) ||
      /\b(?:book now|order online|shop now|our services|service area|view menu)\b/.test(
        title,
      ) ||
      (!officialGuidanceHost &&
        shallowPath &&
        !hasExplicitBlogPath &&
        !deterministicInformationalOverride);
    const looksLikeBlogPage =
      officialGuidanceHost ||
      hasExplicitBlogPath ||
      informationalStructure ||
      deterministicInformationalOverride;
    if (looksLikeMoneyPage) {
      moneyPageCount += 1;
      if (index < 3) topThreeMoneyCount += 1;
    } else if (looksLikeBlogPage) {
      blogPageCount += 1;
      if (index < 3) topThreeBlogCount += 1;
    }
  }

  const dominantFormat = input.dominantFormat?.trim().toLowerCase() || null;
  if (results.length < 3 || blogPageCount + moneyPageCount < 3) {
    return {
      decision: "insufficient-evidence",
      resultCount: results.length,
      blogPageCount,
      moneyPageCount,
      dominantFormat,
      rationale:
        "Fewer than three classifiable live results were available, so page ownership cannot be proven.",
    };
  }
  const informationalTieBreak =
    blogPageCount === moneyPageCount &&
    topThreeBlogCount >= 2 &&
    topThreeBlogCount > topThreeMoneyCount;
  if (
    !informationalTieBreak &&
    moneyPageCount >= blogPageCount &&
    (dominantFormat === "service" || moneyPageCount >= 3)
  ) {
    return {
      decision: "money-page-owned",
      resultCount: results.length,
      blogPageCount,
      moneyPageCount,
      dominantFormat,
      rationale:
        "Service, category, product, booking, or menu pages own at least as much of the live SERP as article pages.",
    };
  }
  return {
    decision: "blog-owned",
    resultCount: results.length,
    blogPageCount,
    moneyPageCount,
    dominantFormat,
    rationale: informationalTieBreak
      ? "Article or guide pages own at least two of the top three results and break an otherwise even page-type split."
      : "Article, guide, list, or learning pages clearly outnumber money pages in the classifiable live results.",
  };
}

export function buildBlogTopicSerpRefinement(input: {
  keyword: string;
  strategy: BlogTitlePlaybookStrategy;
  location?: string | null;
}): string {
  const keyword = input.keyword.trim().replace(/\s+/g, " ");
  const location = input.location?.trim().replace(/\s+/g, " ") || null;
  if (/\bcommercial cleaning\b/i.test(keyword) && location) {
    return `questions to ask before hiring a commercial cleaning company in ${location}`;
  }
  if (input.strategy.archetype === "mistakes-red-flags") {
    return `questions to ask before choosing ${keyword}`;
  }
  if (
    input.strategy.archetype === "comparison" ||
    input.strategy.archetype === "best-of-listicle"
  ) {
    return `how to choose ${keyword}`;
  }
  return `${keyword} decision checklist`;
}

export function buildBlogTopicSerpSecondRefinement(input: {
  keyword: string;
  location?: string | null;
}): string {
  const keyword = input.keyword.trim().replace(/\s+/g, " ");
  const location = input.location?.trim().replace(/\s+/g, " ") || null;
  if (/\bindian catering\b/i.test(keyword)) {
    return `how to plan an Indian catering menu${location ? ` for an event in ${location}` : ""} guest count dietary needs and service style`;
  }
  if (/\bhot drink pairings?\b/i.test(keyword)) {
    return "hot drink and Indian food pairing guide flavours desserts tea and coffee";
  }
  if (/\bcalendrier des cours de conduite\b/i.test(keyword)) {
    return `comment planifier un calendrier de cours de conduite étapes délais et conseils${location ? ` à ${location}` : ""}`;
  }
  if (/\bposture correction chiropractic\b/i.test(keyword)) {
    return "posture correction and chiropractic care what an assessment can and cannot show";
  }
  return `what to know before choosing ${keyword} planning considerations questions and tradeoffs`;
}

export function getBlogTitlePlaybookFailures(
  title: string,
  strategy: BlogTitlePlaybookStrategy,
): string[] {
  const failures: string[] = [];
  const normalizedTitle = normalize(title);
  if (GENERIC_TITLE_FORMULA.test(title)) {
    failures.push("generic_guide_formula");
  }
  if (GENERIC_PLAYBOOK_TITLE_SHAPE.test(title)) {
    failures.push("generic_playbook_title_shape");
  }
  const trimmedTitle = title.trim();
  const family = strategy.variationFamily;
  if (family === "question") {
    if (!trimmedTitle.endsWith("?")) {
      failures.push("title_violates_question_variation");
    }
    const interrogative =
      /(?:^|:\s*)(?:how|what|why|when|where|which|who|can|could|should|would|will|is|are|do|does|did)\b/i;
    if (!interrogative.test(trimmedTitle)) {
      failures.push("title_question_is_not_natural_interrogative");
    }
    if (
      /^what\s+(?:are|is)\s+(?:safe|effective|useful|practical|helpful|reliable)\b.*\b(?:tips?|steps?|ways?|options?|ideas?)\?$/i.test(
        trimmedTitle,
      )
    ) {
      failures.push("title_question_has_awkward_word_order");
    }
  }
  if (family === "colon" && !trimmedTitle.includes(":")) {
    failures.push("title_violates_colon_variation");
  }
  if (
    family === "comparison" &&
    !/\b(?:vs\.?|versus|compare|compared|comparison|differences?)\b/i.test(
      trimmedTitle,
    )
  ) {
    failures.push("title_violates_comparison_variation");
  }
  if (
    family === "numbered" &&
    !/\b(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(
      trimmedTitle,
    )
  ) {
    failures.push("title_violates_numbered_variation");
  }
  if (
    family === "plain" &&
    (/^\s*\d+\b/.test(trimmedTitle) || /[:?]/.test(trimmedTitle))
  ) {
    failures.push("title_violates_plain_variation");
  }
  const cues: Partial<Record<BlogTitlePlaybookArchetype, RegExp>> = {
    "cost-pricing": /\b(?:cost|costs|price|prices|pricing|fee|fees|quote|quotes|budget|how much)\b/,
    comparison: /\b(?:vs|versus|compare|compared|comparison|difference|which)\b/,
    "lifespan-timing": /\b(?:how long|lifespan|last|timing|when|signs|replace|often)\b/,
    "diy-vs-pro": /\b(?:diy|yourself|professional|pro|can you|can i)\b/,
    "local-seasonal": /\b(?:winter|spring|summer|fall|autumn|season|seasonal|checklist)\b/,
    "mistakes-red-flags": /\b(?:mistake|mistakes|red flag|red flags|avoid|ask|hiring|questions|warning|check)\b/,
    "case-study": /\b(?:case study|breakdown|project|job)\b/,
    "how-to": /\b(?:how to|how do|how does|how can|steps|step by step|checklist|where to start|installation|setup)\b/,
    "best-of-listicle": /\b(?:\d+|best|top|options|compared|criteria|ways|tips|ideas|things|checklist|consider|considering|worth)\b/,
    "competitor-comparison": /\b(?:vs|versus|alternatives|comparison|compare|reviews)\b/,
    "glossary-definition": /\b(?:what is|what are|definition|meaning|means|matters|explained|understanding|how does)\b/,
  };
  const cue = cues[strategy.archetype];
  if (cue && !cue.test(normalizedTitle)) {
    failures.push(`title_does_not_match_${strategy.archetype}`);
  }
  return failures;
}

function titleCaseKeyword(keyword: string): string {
  return keyword
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) =>
      /^(?:vs\.?|and|or|to|in|of|for|with)$/i.test(word)
        ? word.toLowerCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

function splitTrailingLocation(keyword: string): {
  topic: string;
  location: string | null;
} {
  const trimmed = keyword.replace(/\s+/g, " ").trim();
  const match = trimmed.match(/^(.+?)\s+([A-Z][A-Za-z.'-]+)$/);
  if (!match) return { topic: titleCaseKeyword(trimmed), location: null };
  return {
    topic: titleCaseKeyword(match[1]!),
    location: match[2]!,
  };
}

function singularizeLastWord(input: string): string {
  return input.replace(/\b([A-Za-z]+)ies\b$/i, (_, stem: string) => `${stem}y`)
    .replace(/\b([A-Za-z]{4,})s\b$/i, "$1");
}

export function buildBlogTitlePlaybookFallback(input: {
  keyword: string;
  location?: string | null;
  strategy?: BlogTitlePlaybookStrategy;
}): string {
  const strategy =
    input.strategy ??
    selectBlogTitlePlaybookStrategy({
      keyword: input.keyword,
      location: input.location,
    });
  const splitTopic = splitTrailingLocation(
    input.keyword || "Business Services",
  );
  const topic = splitTopic.topic;
  const location = input.location ?? splitTopic.location;
  const normalizedTopic = normalize(topic);
  const variation = strategy.variationFamily;

  switch (strategy.archetype) {
    case "first-party-data":
      return variation === "colon"
        ? `${topic}: Findings From Verified Data`
        : `${topic} Findings From Verified Data`;
    case "cost-pricing":
      if (variation === "question") return `What Affects ${topic}?`;
      return variation === "colon"
        ? `${topic}: Key Cost Factors`
        : `${topic} Cost Factors`;
    case "symptom-diagnosis":
      return variation === "question"
        ? `${topic}: What Could Be Causing It?`
        : `Possible Causes and Checks for ${topic}`;
    case "comparison":
      if (variation === "question") {
        return `${topic}: Which Fits?`;
      }
      return variation === "comparison"
        ? `${topic}: A Criteria-by-Criteria Comparison`
        : `${topic} Key Differences and Decision Criteria`;
    case "lifespan-timing":
      return variation === "question"
        ? `${topic}: What Affects It?`
        : `${topic} Timing Factors and Warning Signs`;
    case "diy-vs-pro":
      if (variation === "question") return `${topic}: Can You Do It Yourself?`;
      return variation === "comparison"
        ? `${topic}: DIY vs Professional Help`
        : `${topic} DIY Limits and Professional Help`;
    case "local-seasonal":
      return variation === "colon"
        ? `${topic}: A Prioritized Seasonal Checklist`
        : `${topic} Seasonal Preparation Checklist`;
    case "process-expectation":
      if (variation === "question") return `${topic}: What to Expect?`;
      return variation === "colon"
        ? `${topic}: What to Expect`
        : /\bideas?$/i.test(topic)
          ? `Putting ${topic} Into Practice`
          : `Understanding ${topic}`;
    case "mistakes-red-flags":
      if (variation === "question") {
        if (/\b(?:contractor|inspector|lawyer|provider)\b/i.test(topic)) {
          return `What Should You Ask Before Hiring a ${topic}?`;
        }
        return location
          ? `What Should You Check Before ${topic} in ${location}?`
          : `${topic}: What Should You Check First?`;
      }
      if (variation === "numbered" && strategy.substantiveItemCount) {
        if (location) {
          return `${strategy.substantiveItemCount} ${singularizeLastWord(topic)} Mistakes to Avoid in ${location}`;
        }
        return `${strategy.substantiveItemCount} ${topic} Mistakes to Avoid`;
      }
      if (/\b(?:mistake|mistakes|red flag|red flags|questions to ask)\b/.test(normalizedTopic)) {
        return `${topic} to Check Before You Decide`;
      }
      return variation === "colon"
        ? `${topic}: Red Flags and Questions to Ask`
        : `${topic} Mistakes and Checks Before You Decide`;
    case "case-study":
      return variation === "colon"
        ? `Case Study: ${topic}`
        : `${topic} Project Breakdown`;
    case "how-to":
      if (variation === "question") {
        return /^how\s+to\b/i.test(topic)
          ? `${topic.replace(/[?]+$/, "")}${location ? ` in ${location}` : ""}?`
          : `How to Plan ${topic}${location ? ` in ${location}` : ""}?`;
      }
      {
        const task = /^how\s+to\b/i.test(topic)
          ? topic.replace(/^how\s+to\s+/i, "")
          : topic;
        const locatedTask = `${task}${location ? ` in ${location}` : ""}`;
        return variation === "colon"
          ? `${locatedTask}: A Step-by-Step Approach`
          : `A Step-by-Step Approach to ${locatedTask}`;
      }
    case "best-of-listicle":
      if (variation === "question") {
        if (/\b(?:virus|malware)\b/i.test(topic) && /\btips?\b/i.test(topic)) {
          return `Which ${topic} Are Safe to Try?`;
        }
        if (/\btips?\b/i.test(topic)) {
          return `Which ${topic} Should You Use First?`;
        }
        if (/\bideas?\b/i.test(topic)) {
          return `Which ${topic} Fit Your Needs?`;
        }
        const pluralTopic = /\b(?:benefits|choices|ideas|options|things|tips|ways)\b/i.test(
          topic,
        )
          ? topic
          : `${topic} Options`;
        return `Which ${pluralTopic} Are Worth Considering?`;
      }
      if (variation === "comparison") {
        return `How to Compare ${topic} Options`;
      }
      if (variation === "numbered") {
        if (/^buy\b.*\bonline$/i.test(topic)) {
          return `${strategy.substantiveItemCount ?? "7"} Things to Check Before You ${topic}`;
        }
        if (/\bmenu$/i.test(topic)) {
          return `${strategy.substantiveItemCount ?? "7"} Dishes to Explore on an ${topic}`;
        }
        if (/^hotels? with family suites?$/i.test(topic)) {
          return `${strategy.substantiveItemCount ?? "7"} Things to Check Before Booking ${topic}`;
        }
        if (location) {
          return `${strategy.substantiveItemCount ?? "7"} Ways to Choose ${topic} in ${location}`;
        }
        return `${strategy.substantiveItemCount ?? "7"} ${topic}`;
      }
      return /^best\b/i.test(topic)
        ? `Choosing the ${topic}`
        : location
          ? `${topic} Options Worth Comparing in ${location}`
          : `${topic} Options Worth Comparing`;
    case "competitor-comparison":
      if (variation === "question") return `${topic}: What to Compare?`;
      return variation === "comparison"
        ? `${topic}: A Criteria-by-Criteria Comparison`
        : `${topic} Comparison Criteria to Consider`;
    case "glossary-definition":
      {
        const definitionTopicBase = topic.replace(
          /^(?:what\s+(?:is|are)|define)\s+/i,
          "",
        );
        const definitionTopic = location
          ? `${definitionTopicBase} in ${location}`
          : definitionTopicBase;
        if (variation === "question") return `What Is ${definitionTopic}?`;
        return variation === "colon"
          ? `${definitionTopic}: Meaning and Practical Context`
          : `Understanding ${definitionTopic}`;
      }
  }
}

export function titleSimilarityScore(left: string, right: string): number {
  const tokens = (value: string) =>
    new Set(
      normalize(value)
        .split(" ")
        .filter(
          (token) =>
            token.length > 1 &&
            ![
              "a",
              "an",
              "and",
              "for",
              "in",
              "of",
              "on",
              "the",
              "to",
              "with",
              "you",
              "your",
              "should",
            ].includes(token),
        ),
    );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}
