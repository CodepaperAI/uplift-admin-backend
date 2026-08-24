/**
 * offpage-types.ts
 *
 * Shared types for the off-page strategy engine: a business-type-aware routing
 * layer that surfaces a prioritized "opportunities queue" per business. Each
 * lever (directory, reddit, ...) implements the Lever interface; the engine
 * runs the applicable ones and merges their opportunities into one ranked queue.
 */

/**
 * How an opportunity is carried out:
 *  - "reddit"/"directory": we execute it live (find threads / check listings)
 *  - "manual": a high-leverage strategic play we can't auto-do yet (review
 *    velocity, a BlogTO feature pitch, catering partnerships, ...) surfaced as a
 *    guided play with a how-to.
 */
export type OffPageLeverKey = "directory" | "reddit" | "manual";

export type BusinessModelType = "service" | "product" | "mixed" | "unknown";
export type GeographicScope =
  | "local"
  | "regional"
  | "national"
  | "international"
  | "unknown";

/** Minimal, explicit profile the levers read — assembled once from the business. */
export interface BusinessOffPageProfile {
  businessId: string;
  businessName: string;
  businessModelType: BusinessModelType;
  isLocationDependent: boolean;
  scope: GeographicScope;
  serviceArea?: string | null;
  /** Business country (free text or ISO-2 — normalized by levers as needed). */
  country?: string | null;
  city?: string | null;
  /** Business type / category label (free text). */
  category?: string | null;
  keywords: string[];
}

export type OpportunityStatus = "todo" | "in_progress" | "done" | "dismissed";
export type OpportunityConfidenceLevel = "high" | "medium" | "needs_review" | "low";
export type OffPageSourceType =
  | "reddit_thread"
  | "business_profile"
  | "review_platform"
  | "marketplace"
  | "directory"
  | "manual_play";
export type OffPageEvidenceSource =
  | "ai_research"
  | "baseline_seed"
  | "live_search"
  | "thread_page"
  | "directory_reachability"
  | "directory_page_scan"
  | "known_submission_map"
  | "already_listed_search"
  | "strict_reviewer";
export type DirectorySubmissionType =
  | "direct_claim"
  | "add_business"
  | "homepage"
  | "unknown";
export type DirectoryPricingModel = "free" | "freemium" | "paid" | "unknown";

export interface OffPageQualitySummary {
  totalCandidates: number;
  shown: number;
  hiddenLowConfidence: number;
  rejected: number;
  averageConfidence: number | null;
  highConfidence: number;
  mediumConfidence: number;
  needsReview: number;
  lowConfidence: number;
  byLever: Record<string, number>;
  byConfidenceLevel: Record<string, number>;
  bySourceType: Record<string, number>;
  evidenceSourceCounts: Record<string, number>;
  rejectionReasons: Record<string, number>;
}

export interface Opportunity {
  leverKey: OffPageLeverKey;
  /** Stable id for status persistence (survives queue re-computation). */
  key: string;
  title: string;
  url?: string;
  action: string;
  /** 0-100, comparable across levers (see computePriority). */
  priority: number;
  rationale: string;
  /** 0-100 trust score after live checks and quality scoring. */
  confidence?: number;
  /** Human-friendly quality bucket. Low-confidence results are hidden by default. */
  confidenceLevel?: OpportunityConfidenceLevel;
  /** Concrete evidence that made this result trustworthy. */
  qualitySignals?: string[];
  /** Concrete caveats shown to users/admins; these should be actionable. */
  qualityWarnings?: string[];
  /** When the live quality checks last ran for this opportunity. */
  lastCheckedAt?: string;
  /** Specific surface this opportunity belongs to. */
  sourceType?: OffPageSourceType;
  /** Concrete source/evidence path used to trust this opportunity. */
  evidenceSources?: OffPageEvidenceSource[];
  /** Short user-facing explanation tied to confidence/evidence. */
  whyRecommended?: string;
  /** Validator result kept on the surviving opportunity for debugging/trust. */
  validatorScore?: number;
  validatorReason?: string;
  /**
   * How this opportunity was produced:
   *  - "researched" = LLM-grounded to THIS business (specific, leverageable)
   *  - "baseline"   = deterministic fallback (generic, always available)
   * Undefined is treated as "baseline".
   */
  source?: "researched" | "baseline";
  /**
   * Optional ready-to-adapt draft the user can leverage directly (e.g. a
   * value-first Reddit comment/post). Null when the lever produces none.
   */
  draft?: string | null;
  /**
   * Reddit: the title of the top real thread we found (live) for the user to
   * engage with. When set, `url` points at that thread permalink, not the
   * subreddit page.
   */
  threadTitle?: string | null;
  /**
   * Reddit: the full ranked list of real, on-topic threads to reply to (most
   * relevant first). `url`/`threadTitle` mirror threads[0]. Lets the UI show
   * several posts per community, not just one.
   */
  threads?: Array<{
    url: string;
    title: string;
    draft?: string | null;
    source?: "old_reddit" | "google";
    createdAt?: string | null;
    ageDays?: number | null;
    commentCount?: number | null;
    locked?: boolean;
    archived?: boolean;
    deleted?: boolean;
    unavailable?: boolean;
    detailCheckedAt?: string | null;
    buyerIntent?: boolean;
    qualityScore?: number;
    qualitySignals?: string[];
    qualityWarnings?: string[];
  }>;
  /**
   * Directory: the business already has a listing here (found during the live
   * already-listed check). When true, the UI shows "Already listed" + the
   * existing `url` instead of telling the user to create one.
   */
  alreadyListed?: boolean;
  /** Directory: URL users should open to add/claim the listing. */
  submissionUrl?: string;
  /** Directory: whether submissionUrl is a direct claim/add page or a homepage fallback. */
  submissionUrlType?: DirectorySubmissionType;
  /** Directory: whether the listing path appears free, paid, freemium, or unknown. */
  pricingModel?: DirectoryPricingModel;
  /** Original researched directory URL when url is replaced with a direct submission URL. */
  originalUrl?: string;
  /**
   * Outcome-verification status surfaced from the persisted status row:
   * unverified | verifying | verified | not_found | failed.
   */
  verificationStatus?: string | null;
  /** User feedback captured when the opportunity is dismissed. */
  dismissReason?: string | null;
  /**
   * Whether this suggestion is GROUNDED in live data (real Reddit threads found,
   * directory reachable) vs an AI-only idea (manual strategic plays). Drives the
   * "verified / AI suggestion" trust flag the user sees before acting on it.
   */
  grounded?: boolean;
  status: OpportunityStatus;
  /** Which business type(s) this lever serves — for display + debugging. */
  businessTypeFit: string;
  /**
   * Strategist channel label (e.g. "Google Business Profile", "Review velocity",
   * "Reddit — local recommendations"). Set when the opportunity came from the
   * Growth Strategist brain rather than a raw lever.
   */
  channel?: string;
  /** Strategist impact (1-5) and effort (1-5) — drive the impact×effort ranking. */
  impact?: number;
  effort?: number;
}

export type BusinessDiscoveryArchetype =
  | "local_recommendation"
  | "local_service"
  | "b2b_service"
  | "professional_service"
  | "saas"
  | "ecommerce"
  | "healthcare"
  | "real_estate"
  | "hospitality"
  | "education"
  | "other";

export interface OffPageResearchStrategy {
  /** How the planner understands the business before searching. */
  businessSummary: string;
  archetype: BusinessDiscoveryArchetype;
  /** Customer/problem language that should drive discovery, not just category names. */
  demandSignals: string[];
  reddit: {
    enabled: boolean;
    reason: string;
    /** Subreddits/audiences to ask the Reddit researcher to consider. */
    subredditSeeds: string[];
    /** Thread-search queries to use during live Reddit enrichment. */
    threadSearchQueries: string[];
    /** Distinctive business/topic terms used to reject irrelevant Reddit threads. */
    coreTerms: string[];
    /** Angles for helpful, non-promotional replies. */
    audienceAngles: string[];
    /** Words/topics that would make Reddit results noisy or off-brand. */
    avoidTerms: string[];
  };
  directory: {
    enabled: boolean;
    reason: string;
    /** Google/SERP queries used to discover ranking directory domains. */
    searchQueries: string[];
    /** Directory classes that must be considered for this business type. */
    requiredDirectoryTypes: string[];
    /** Extra industry/regional directory classes that may matter. */
    nicheDirectoryTypes: string[];
    /** Country/city/regional hints for choosing the right listing variant. */
    regionalHints: string[];
    /** Directories/classes to avoid because they do not fit this business. */
    avoidDirectories: string[];
  };
}

export interface Lever {
  key: OffPageLeverKey;
  /** Whether this lever is relevant to the business at all. */
  appliesTo(profile: BusinessOffPageProfile): boolean;
  /** Pure: deterministic baseline opportunities (no I/O) — the always-available fallback. */
  findOpportunities(profile: BusinessOffPageProfile): Opportunity[];
  /**
   * Optional async path: research business-SPECIFIC opportunities via the LLM,
   * grounded in the BusinessResearchBrief (services, audience, competitors,
   * location, keywords) so suggestions are leverageable, not generic. When
   * present and it returns ≥1 result, the engine prefers these over the
   * deterministic baseline; on error/empty it falls back to findOpportunities
   * so the queue is never blank. Never performs any posting — read/compute only.
   */
  researchOpportunities?(
    profile: BusinessOffPageProfile,
    brief: BusinessResearchBrief,
    strategy?: OffPageResearchStrategy,
  ): Promise<Opportunity[]>;
}

/**
 * A rich, business-specific brief assembled once from the DB and handed to
 * lever research methods. This is the "research according to the business" input
 * that keeps LLM suggestions concrete (this business's services, audience,
 * competitors, and locale) instead of generic.
 */
export interface BusinessResearchBrief {
  businessId: string;
  businessName: string;
  /** businessType / category label. */
  category?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  targetAudience?: string | null;
  /** Services the business offers (selected ∪ AI-detected ∪ core offerings), deduped. */
  services: string[];
  competitors: Array<{ name: string; url?: string | null }>;
  /** Target keywords (with their intent type when available). */
  keywords: string[];
  location: {
    city?: string | null;
    serviceArea?: string | null;
    serviceAreaLocations: string[];
    country?: string | null;
    /** Precise location from the geo profile (formatted address), when known. */
    formattedAddress?: string | null;
    /** Neighbourhood/locality labels useful for hyper-local communities. */
    neighborhoods: string[];
  };
  scope: GeographicScope;
  businessModelType: BusinessModelType;

  // ----- Deep context (the "understand the business" layer) -----
  /** Brand tagline / positioning line. */
  tagline?: string | null;
  /** One-paragraph business summary (from the scraped profile). */
  summary?: string | null;
  /** What makes this business different — USPs + value propositions. */
  differentiators: string[];
  /** The customer problems this business solves (drives where to engage). */
  painPoints: string[];
  /** Business goals (what success looks like for them). */
  businessGoals: string[];
  /** How the business positions itself in its industry. */
  industryPositioning?: string | null;
  /** Awards / partnerships / recognition (credibility signals). */
  recognition: string[];
  /** Content topics competitors cover (gap/angle signal). */
  competitorTopics: string[];
  /**
   * Topics the business is deliberately building content around — its content
   * plan (planned keywords) + published blog titles. High-signal, declared-intent
   * targets for Reddit thread search (people ask exactly these questions) and for
   * the planner's demand signals. Optional so existing brief literals stay valid.
   */
  contentTopics?: string[];
}
