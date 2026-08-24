/**
 * directory-catalog.ts
 *
 * Static, hand-curated directory catalog (v1: Canada + US). A file, not a DB
 * table — promote to a table only if it needs runtime editing. Each entry knows
 * which countries / business categories / model types it applies to.
 *
 * `countries`/`categories`/`appliesToTypes` use "*" to mean "any".
 */

import type { BusinessModelType } from "../offpage-types";

export interface DirectoryEntry {
  name: string;
  url: string;
  /** Domain authority-ish 0-100 (hand-set), drives priority. */
  authority: number;
  /** ISO-2 country codes this directory serves, or "*" for global. */
  countries: string[];
  /** Category keywords this directory fits, or "*" for general. */
  categories: string[];
  /** Business model types this fits, or "*". */
  appliesToTypes: (BusinessModelType | "*")[];
}

export const DIRECTORY_CATALOG: DirectoryEntry[] = [
  // --- General, high-authority (every local/SMB business) ---
  { name: "Google Business Profile", url: "https://www.google.com/business/", authority: 100, countries: ["*"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Bing Places", url: "https://www.bingplaces.com/", authority: 88, countries: ["*"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Apple Business Connect", url: "https://businessconnect.apple.com/", authority: 90, countries: ["*"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Facebook Page", url: "https://www.facebook.com/business/pages", authority: 95, countries: ["*"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Yelp", url: "https://biz.yelp.com/", authority: 92, countries: ["US", "CA"], categories: ["*"], appliesToTypes: ["service", "mixed"] },
  { name: "Better Business Bureau", url: "https://www.bbb.org/", authority: 90, countries: ["US", "CA"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Yellow Pages", url: "https://www.yellowpages.com/", authority: 80, countries: ["US"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "YellowPages.ca", url: "https://www.yellowpages.ca/", authority: 80, countries: ["CA"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Canada411", url: "https://www.canada411.ca/", authority: 78, countries: ["CA"], categories: ["*"], appliesToTypes: ["*"] },
  { name: "Nextdoor Business", url: "https://business.nextdoor.com/", authority: 84, countries: ["US", "CA"], categories: ["*"], appliesToTypes: ["service", "mixed"] },

  // --- Food / restaurant / catering ---
  { name: "TripAdvisor", url: "https://www.tripadvisor.com/Owners", authority: 92, countries: ["*"], categories: ["restaurant", "food", "catering", "cafe", "hospitality", "hotel"], appliesToTypes: ["service", "mixed"] },
  { name: "OpenTable", url: "https://restaurant.opentable.com/", authority: 88, countries: ["US", "CA"], categories: ["restaurant", "food", "catering", "cafe"], appliesToTypes: ["service", "mixed"] },
  { name: "Zomato", url: "https://www.zomato.com/", authority: 84, countries: ["*"], categories: ["restaurant", "food", "catering"], appliesToTypes: ["service", "mixed"] },

  // --- Home / trades / local service ---
  { name: "Angi", url: "https://www.angi.com/", authority: 88, countries: ["US"], categories: ["home", "plumbing", "hvac", "electrician", "contractor", "cleaning", "landscaping", "roofing"], appliesToTypes: ["service"] },
  { name: "HomeStars", url: "https://homestars.com/", authority: 82, countries: ["CA"], categories: ["home", "plumbing", "hvac", "electrician", "contractor", "cleaning", "landscaping", "roofing", "renovation"], appliesToTypes: ["service"] },
  { name: "Houzz", url: "https://www.houzz.com/", authority: 86, countries: ["US", "CA"], categories: ["home", "renovation", "interior", "design", "contractor", "architect"], appliesToTypes: ["service", "mixed"] },
  { name: "Thumbtack", url: "https://www.thumbtack.com/", authority: 85, countries: ["US"], categories: ["home", "service", "cleaning", "events", "tutoring"], appliesToTypes: ["service"] },

  // --- Health / medical / wellness ---
  { name: "Healthgrades", url: "https://www.healthgrades.com/", authority: 88, countries: ["US"], categories: ["health", "medical", "doctor", "clinic", "dental", "dentist"], appliesToTypes: ["service"] },
  { name: "RateMDs", url: "https://www.ratemds.com/", authority: 80, countries: ["CA", "US"], categories: ["health", "medical", "doctor", "clinic", "dental", "dentist"], appliesToTypes: ["service"] },
  { name: "Vagaro", url: "https://www.vagaro.com/", authority: 78, countries: ["US", "CA"], categories: ["salon", "spa", "beauty", "wellness", "barber", "massage"], appliesToTypes: ["service"] },

  // --- Legal / professional ---
  { name: "Avvo", url: "https://www.avvo.com/", authority: 84, countries: ["US"], categories: ["legal", "lawyer", "attorney", "law"], appliesToTypes: ["service"] },
  { name: "Clutch", url: "https://clutch.co/", authority: 86, countries: ["*"], categories: ["agency", "marketing", "software", "consulting", "saas", "development"], appliesToTypes: ["service", "mixed"] },

  // --- E-commerce / product / marketplace presence ---
  { name: "Trustpilot", url: "https://business.trustpilot.com/", authority: 90, countries: ["*"], categories: ["*"], appliesToTypes: ["product", "mixed", "service"] },
  { name: "Google Merchant Center", url: "https://www.google.com/retail/solutions/merchant-center/", authority: 92, countries: ["*"], categories: ["*"], appliesToTypes: ["product", "mixed"] },
  { name: "Capterra", url: "https://www.capterra.com/vendors/", authority: 88, countries: ["*"], categories: ["saas", "software", "app", "tool", "platform"], appliesToTypes: ["product", "mixed"] },
  { name: "G2", url: "https://www.g2.com/products/new", authority: 90, countries: ["*"], categories: ["saas", "software", "app", "tool", "platform"], appliesToTypes: ["product", "mixed"] },
];
