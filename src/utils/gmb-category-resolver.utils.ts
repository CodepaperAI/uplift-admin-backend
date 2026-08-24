/**
 * Resolves human-readable business category names to Google's `categories/gcid:*`
 * resource IDs. Google's `businessInformation.locations.patch` endpoint will only
 * accept categories in resource-ID form — plain display names get rejected.
 *
 * The full Google taxonomy has 4000+ entries; this map covers the most common
 * verticals so AI-generated suggestions can be auto-applied for the majority of
 * businesses. Unknown categories fall through unchanged so the diff still shows
 * up in the UI as "Approval record only" (manual handling).
 *
 * Source: https://developers.google.com/my-business/content/category-list
 */

const CATEGORY_GCID_MAP: Record<string, string> = {
  // Food & beverage
  "restaurant": "restaurant",
  "fast food restaurant": "fast_food_restaurant",
  "takeout restaurant": "takeout_restaurant",
  "delivery restaurant": "delivery_restaurant",
  "caterer": "caterer",
  "catering service": "caterer",
  "food truck": "food_truck",
  "cafe": "cafe",
  "coffee shop": "coffee_shop",
  "bakery": "bakery",
  "pizza restaurant": "pizza_restaurant",
  "pizzeria": "pizza_restaurant",
  "bar": "bar",
  "pub": "pub",
  "bar and grill": "bar_and_grill",
  "buffet restaurant": "buffet_restaurant",
  "ice cream shop": "ice_cream_shop",
  "juice shop": "juice_shop",
  "tea house": "tea_house",
  "winery": "winery",
  "brewery": "brewery",
  // Cuisine-specific restaurants
  "mediterranean restaurant": "mediterranean_restaurant",
  "middle eastern restaurant": "middle_eastern_restaurant",
  "halal restaurant": "halal_restaurant",
  "indian restaurant": "indian_restaurant",
  "chinese restaurant": "chinese_restaurant",
  "japanese restaurant": "japanese_restaurant",
  "thai restaurant": "thai_restaurant",
  "vietnamese restaurant": "vietnamese_restaurant",
  "korean restaurant": "korean_restaurant",
  "mexican restaurant": "mexican_restaurant",
  "italian restaurant": "italian_restaurant",
  "french restaurant": "french_restaurant",
  "greek restaurant": "greek_restaurant",
  "american restaurant": "american_restaurant",
  "barbecue restaurant": "barbecue_restaurant",
  "sushi restaurant": "sushi_restaurant",
  "vegetarian restaurant": "vegetarian_restaurant",
  "vegan restaurant": "vegan_restaurant",
  "seafood restaurant": "seafood_restaurant",
  "steak house": "steak_house",

  // Health & wellness
  "dentist": "dentist",
  "dental clinic": "dental_clinic",
  "doctor": "doctor",
  "medical clinic": "medical_clinic",
  "physical therapist": "physical_therapist",
  "chiropractor": "chiropractor",
  "optometrist": "optometrist",
  "pharmacy": "pharmacy",
  "veterinarian": "veterinarian",
  "veterinary care": "veterinary_care",
  "psychologist": "psychologist",
  "therapist": "therapist",
  "massage therapist": "massage_therapist",
  "acupuncture clinic": "acupuncture_clinic",
  "yoga studio": "yoga_studio",
  "pilates studio": "pilates_studio",
  "gym": "gym",
  "fitness center": "fitness_center",
  "personal trainer": "personal_trainer",
  "spa": "spa",
  "day spa": "day_spa",
  "nail salon": "nail_salon",
  "hair salon": "hair_salon",
  "beauty salon": "beauty_salon",
  "barber shop": "barber_shop",
  "tanning salon": "tanning_salon",
  "tattoo shop": "tattoo_shop",

  // Home services
  "plumber": "plumber",
  "electrician": "electrician",
  "hvac contractor": "hvac_contractor",
  "roofing contractor": "roofing_contractor",
  "general contractor": "general_contractor",
  "construction company": "construction_company",
  "painter": "painter",
  "carpenter": "carpenter",
  "landscaper": "landscaper",
  "lawn care service": "lawn_care_service",
  "pest control service": "pest_control_service",
  "cleaning service": "cleaning_service",
  "house cleaning service": "house_cleaning_service",
  "carpet cleaning service": "carpet_cleaning_service",
  "moving company": "moving_company",
  "locksmith": "locksmith",
  "interior designer": "interior_designer",
  "appliance repair service": "appliance_repair_service",
  "window cleaning service": "window_cleaning_service",
  "handyman": "handyman",
  "flooring contractor": "flooring_contractor",

  // Auto
  "auto repair shop": "auto_repair_shop",
  "car dealer": "car_dealer",
  "used car dealer": "used_car_dealer",
  "car wash": "car_wash",
  "auto body shop": "auto_body_shop",
  "tire shop": "tire_shop",
  "auto parts store": "auto_parts_store",
  "oil change service": "oil_change_service",
  "towing service": "towing_service",

  // Professional services
  "lawyer": "lawyer",
  "law firm": "law_firm",
  "accountant": "accountant",
  "tax preparation service": "tax_preparation_service",
  "financial planner": "financial_planner",
  "insurance agency": "insurance_agency",
  "real estate agency": "real_estate_agency",
  "real estate agent": "real_estate_agent",
  "mortgage lender": "mortgage_lender",
  "marketing agency": "marketing_agency",
  "advertising agency": "advertising_agency",
  "consultant": "consultant",
  "business consultant": "business_consultant",
  "graphic designer": "graphic_designer",
  "web designer": "web_designer",
  "software company": "software_company",
  "it support service": "it_support_service",
  "computer repair service": "computer_repair_service",
  "photographer": "photographer",
  "wedding photographer": "wedding_photographer",
  "videographer": "videographer",
  "translator": "translator",
  "notary public": "notary_public",
  "private investigator": "private_investigator",

  // Retail
  "clothing store": "clothing_store",
  "shoe store": "shoe_store",
  "jewelry store": "jewelry_store",
  "grocery store": "grocery_store",
  "supermarket": "supermarket",
  "convenience store": "convenience_store",
  "liquor store": "liquor_store",
  "bookstore": "bookstore",
  "florist": "florist",
  "gift shop": "gift_shop",
  "furniture store": "furniture_store",
  "electronics store": "electronics_store",
  "sporting goods store": "sporting_goods_store",
  "toy store": "toy_store",
  "pet store": "pet_store",
  "thrift store": "thrift_store",
  "antique store": "antique_store",
  "art gallery": "art_gallery",
  "art supply store": "art_supply_store",
  "hardware store": "hardware_store",
  "garden center": "garden_center",

  // Education & childcare
  "school": "school",
  "preschool": "preschool",
  "day care center": "day_care_center",
  "tutor": "tutor",
  "language school": "language_school",
  "music school": "music_school",
  "driving school": "driving_school",
  "dance school": "dance_school",

  // Events & entertainment
  "event planner": "event_planner",
  "wedding venue": "wedding_venue",
  "banquet hall": "banquet_hall",
  "movie theater": "movie_theater",
  "bowling alley": "bowling_alley",
  "amusement park": "amusement_park",
  "night club": "night_club",
  "live music venue": "live_music_venue",

  // Travel & hospitality
  "hotel": "hotel",
  "motel": "motel",
  "bed and breakfast": "bed_and_breakfast",
  "vacation rental": "vacation_rental",
  "travel agency": "travel_agency",
  "tour operator": "tour_operator",

  // Pet services
  "pet groomer": "pet_groomer",
  "pet boarding service": "pet_boarding_service",
  "dog trainer": "dog_trainer",
  "dog walker": "dog_walker",

  // Specialty
  "dry cleaner": "dry_cleaner",
  "tailor": "tailor",
  "shoe repair shop": "shoe_repair_shop",
  "watch repair service": "watch_repair_service",
  "print shop": "print_shop",
  "copy shop": "copy_shop",
  "shipping service": "shipping_service",
  "storage facility": "storage_facility",
};

function normalizeCategoryKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Maps a display name to a Google category resource ID, or `null` if the name
 * is unknown to the resolver (caller should keep the display name for review).
 */
export function resolveGoogleCategoryId(displayName: string): string | null {
  if (!displayName) return null;
  const key = normalizeCategoryKey(displayName);
  if (!key) return null;
  const gcid = CATEGORY_GCID_MAP[key];
  return gcid ? `categories/gcid:${gcid}` : null;
}

/**
 * Resolves a list of display names to Google category resource IDs. Returns
 * both the resolved IDs (auto-applyable) and any unresolved names so the caller
 * can preserve them in the proposal for manual approval.
 */
export function resolveGoogleCategoryIds(displayNames: string[]): {
  resolved: string[];
  unresolved: string[];
} {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const name of displayNames) {
    const id = resolveGoogleCategoryId(name);
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        resolved.push(id);
      }
    } else if (name?.trim()) {
      unresolved.push(name.trim());
    }
  }

  return { resolved, unresolved };
}

/**
 * True when a value is already in Google's category resource-ID form.
 */
export function isGoogleCategoryResourceId(value: string): boolean {
  return /^categories\/gcid:[a-z0-9_]+$/i.test(value);
}
