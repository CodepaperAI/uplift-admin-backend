/**
 * Vertical-agnostic blocklist for "service" labels that are NOT real Google
 * Business Profile services. Patterns are grouped by what kind of pollution
 * they catch so it's clear what each one is for and easy to extend.
 *
 * Why we filter aggressively at this layer:
 *   - Website scrapers pull labels from navigation, footers, CTAs, checkout,
 *     and policy pages — none of which are "services" the business performs.
 *   - LLMs given these polluted hints often echo them back verbatim.
 *   - These labels apply to almost any vertical (a plumber, a salon, and a
 *     retailer can all have "Contact Us" and "Free Quote") so they carry
 *     zero SEO value on a Google Business Profile.
 *
 * Rule of thumb: if a label could be the same for two unrelated businesses,
 * it's not a service. Real services answer "what specifically does the
 * customer get?" — e.g. "Bridal hair styling", "Brake pad replacement",
 * "Estate planning will drafting".
 *
 * NOTE: selectedServices (user-curated) is intentionally NOT filtered. If a
 * user explicitly types "Online Ordering" they get to keep it. Filtering
 * applies only to scraped/AI-generated lists.
 */

// 1) Fulfillment, delivery, and checkout mechanics. Not services — these are
//    HOW the customer receives an order, not WHAT they receive.
const FULFILLMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /^order\s*delivery$/i,
  /^(online\s+)?ordering$/i,
  /^(curbside\s+)?pickup$/i,
  /^in[-\s]?store\s+pickup$/i,
  /^takeout$/i,
  /^takeaway$/i,
  /^to[-\s]?go$/i,
  /^drive[-\s]?thru$/i,
  /^delivery(\s+(service|options?))?$/i,
  /^same[-\s]?day\s+delivery$/i,
  /^free\s+(delivery|shipping)$/i,
  /^shipping(\s+(&|and)?\s*handling)?$/i,
  /^(express|standard)\s+shipping$/i,
  /^checkout$/i,
  /^cart$/i,
  /^add\s+to\s+(cart|bag|basket)$/i,
  /^buy\s+now$/i,
];

// 2) Returns, refunds, warranty, financing — transactional/policy concerns
//    rather than offerings the business actively performs for customers.
const TRANSACTIONAL_POLICY_PATTERNS: ReadonlyArray<RegExp> = [
  /^returns?$/i,
  /^returns?\s+(&|and)?\s*exchanges?$/i,
  /^refunds?$/i,
  /^exchanges?$/i,
  /^warranty$/i,
  /^warranties$/i,
  /^guarantee$/i,
  /^financing(\s+options?|\s+available)?$/i,
  /^payment(\s+options?|\s+plans?)?$/i,
  /^insurance(\s+accepted)?$/i,
  /^we\s+accept\s+insurance$/i,
];

// 3) Gift cards, subscriptions, memberships — products wrapping services,
//    not the services themselves.
const COMMERCE_WRAPPER_PATTERNS: ReadonlyArray<RegExp> = [
  /^gift\s+cards?$/i,
  /^gift\s+certificates?$/i,
  /^gift\s+vouchers?$/i,
  /^e[-\s]?gift\s+cards?$/i,
  /^subscriptions?$/i,
  /^memberships?$/i,
  /^rewards?(\s+program)?$/i,
  /^loyalty(\s+program)?$/i,
];

// 4) Calls-to-action — buttons, banners, marketing copy that scrapers
//    frequently treat as headings.
const CTA_PATTERNS: ReadonlyArray<RegExp> = [
  /^get\s+(a\s+)?quote$/i,
  /^get\s+(a\s+)?(free\s+)?estimate$/i,
  /^free\s+(quote|estimate|consultation|consult|inspection|assessment|trial|demo)$/i,
  /^request\s+(a\s+)?(quote|estimate|consultation|appointment|callback|demo)$/i,
  /^schedule\s+(a\s+)?(consultation|appointment|call|demo|visit|service)$/i,
  /^book\s+(now|online|today|an?\s+appointment)$/i,
  /^(online\s+)?booking$/i,
  /^(make\s+an?\s+)?appointments?$/i,
  /^call(\s+us)?(\s+(now|today))?$/i,
  /^contact\s+(us\s+)?(today|now)?$/i,
  /^reach\s+out$/i,
  /^inquire(\s+now|\s+today)?$/i,
  /^inquir(y|ies)$/i,
  /^get\s+started$/i,
  /^learn\s+more$/i,
  /^read\s+more$/i,
  /^view\s+more$/i,
  /^see\s+more$/i,
  /^click\s+here$/i,
  /^sign\s+up(\s+(now|today))?$/i,
  /^subscribe(\s+(now|today))?$/i,
  /^newsletter$/i,
  /^join\s+(now|today|us)$/i,
];

// 5) Website navigation / footer / utility pages. These are page titles, not
//    business offerings.
const NAVIGATION_PATTERNS: ReadonlyArray<RegExp> = [
  /^home$/i,
  /^about(\s+us)?$/i,
  /^our\s+story$/i,
  /^contact(\s+us)?$/i,
  /^location(s)?$/i,
  /^our\s+location(s)?$/i,
  /^hours(\s+(&|and)?\s*location)?$/i,
  /^directions$/i,
  /^services?$/i,
  /^our\s+services$/i,
  /^products?$/i,
  /^our\s+products$/i,
  /^shop$/i,
  /^store$/i,
  /^gallery$/i,
  /^portfolio$/i,
  /^testimonials?$/i,
  /^reviews?$/i,
  /^blog$/i,
  /^news$/i,
  /^events$/i,
  /^careers?$/i,
  /^jobs$/i,
  /^team$/i,
  /^our\s+team$/i,
  /^staff$/i,
  /^press$/i,
  /^media$/i,
  /^faq'?s?$/i,
  /^help(\s+center)?$/i,
  /^support$/i,
  /^privacy(\s+policy)?$/i,
  /^terms(\s+(of\s+)?(service|use))?$/i,
  /^cookie(\s+policy)?$/i,
  /^accessibility(\s+statement)?$/i,
  /^sitemap$/i,
  /^search$/i,
];

// 6) Account / auth pages — clearly not services.
const ACCOUNT_PATTERNS: ReadonlyArray<RegExp> = [
  /^my\s+account$/i,
  /^account$/i,
  /^profile$/i,
  /^dashboard$/i,
  /^login$/i,
  /^log\s*in$/i,
  /^logout$/i,
  /^log\s*out$/i,
  /^sign\s*(in|up|out)$/i,
  /^register$/i,
  /^create\s+(an?\s+)?account$/i,
  /^forgot\s+password$/i,
];

// 7) Single-word generic verbs/nouns that COULD be services but lack any
//    specificity — "Repair" doesn't say what is repaired. A real GBP service
//    should be at minimum a noun + qualifier ("Brake repair", "Drain
//    cleaning"). The qualifier-aware patterns let "Brake repair" pass while
//    blocking "Repair" alone.
const UNQUALIFIED_GENERIC_PATTERNS: ReadonlyArray<RegExp> = [
  /^service$/i,
  /^services?$/i,
  /^repair(s)?$/i,
  /^installation(s)?$/i,
  /^install$/i,
  /^maintenance$/i,
  /^inspection(s)?$/i,
  /^cleaning$/i,
  /^consultation(s)?$/i,
  /^consulting$/i,
  /^advice$/i,
  /^help$/i,
  /^assistance$/i,
  /^solution(s)?$/i,
  /^sales$/i,
  /^quote(s)?$/i,
  /^estimate(s)?$/i,
  /^pricing$/i,
  /^prices$/i,
  /^plans$/i,
  /^packages$/i,
  /^options$/i,
  /^treatments?$/i,
  /^procedures?$/i,
  /^lessons?$/i,
  /^classes$/i,
  /^training$/i,
  /^courses?$/i,
];

// 8) Vague marketing modifiers used alone — "premium service" is not a
//    distinct offering; whatever the premium service IS should be named.
const VAGUE_MARKETING_PATTERNS: ReadonlyArray<RegExp> = [
  /^premium\s+(service|services|quality)$/i,
  /^quality\s+(service|services|work)$/i,
  /^custom\s+(solution(s)?|service(s)?)$/i,
  /^professional\s+service(s)?$/i,
  /^expert\s+service(s)?$/i,
  /^reliable\s+service(s)?$/i,
  /^affordable\s+service(s)?$/i,
  /^trusted\s+service(s)?$/i,
  /^full\s+service$/i,
  /^one[-\s]?stop\s+shop$/i,
];

// 9) Access/availability lines — describes WHEN/HOW the business operates,
//    not what it offers. "Emergency plumbing repair" passes (qualified);
//    "Emergency service" alone is filler.
const AVAILABILITY_PATTERNS: ReadonlyArray<RegExp> = [
  /^24[-\s\/]?7(\s+(service|support|availability))?$/i,
  /^24\s+hour(\s+service)?$/i,
  /^emergency\s+service(s)?$/i,
  /^same[-\s]?day\s+service$/i,
  /^next[-\s]?day\s+service$/i,
  /^walk[-\s]?ins?(\s+welcome)?$/i,
  /^by\s+appointment(\s+only)?$/i,
  /^now\s+open$/i,
  /^open\s+(now|today)$/i,
];

const ALL_GENERIC_PATTERNS: ReadonlyArray<RegExp> = [
  ...FULFILLMENT_PATTERNS,
  ...TRANSACTIONAL_POLICY_PATTERNS,
  ...COMMERCE_WRAPPER_PATTERNS,
  ...CTA_PATTERNS,
  ...NAVIGATION_PATTERNS,
  ...ACCOUNT_PATTERNS,
  ...UNQUALIFIED_GENERIC_PATTERNS,
  ...VAGUE_MARKETING_PATTERNS,
  ...AVAILABILITY_PATTERNS,
];

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isGenericService(name: string): boolean {
  const normalized = normalizeForMatch(name);
  if (!normalized) return true;
  // Anything shorter than 3 characters is too short to be a real service
  // (catches single-letter labels, "Hi", etc. that scrapers occasionally
  // surface from button text). 3+ keeps initialisms like "SEO", "CPR".
  if (normalized.length < 3) return true;
  return ALL_GENERIC_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterOutGenericServices(names: ReadonlyArray<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (typeof name !== "string") continue;
    const normalized = normalizeForMatch(name);
    if (!normalized) continue;
    if (isGenericService(normalized)) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}
