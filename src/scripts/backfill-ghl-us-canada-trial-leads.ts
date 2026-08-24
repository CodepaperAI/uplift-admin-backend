import { prisma } from "../config/db.config";
import {
  buildGhlSignupPayloadPreview,
  syncSignupToGhl,
} from "../services/ghl-signup-sync.service";

type UsCanadaClassification =
  | { include: false; reason: string }
  | {
      areaCode: string | null;
      country: "Canada" | "United States";
      include: true;
      matchType:
        | "explicit_plus1"
        | "local_with_us_ca_context"
        | "one_prefix_with_us_ca_context";
    };

type LeadResult = {
  action: "dry-run" | "pending-sync" | "synced";
  areaCode: string | null;
  business: {
    country: string | null;
    name: string | null;
    onboardingStatus: string | null;
    website: string | null;
    websiteStatus: string | null;
  };
  contact: {
    email: string;
    name: string;
    phone: string | null;
  };
  country: "Canada" | "United States";
  createdAt: string | null;
  matchType:
    | "explicit_plus1"
    | "local_with_us_ca_context"
    | "one_prefix_with_us_ca_context";
  preview: unknown;
  subscriptionStatus: string | null;
  syncResult?: Awaited<ReturnType<typeof syncSignupToGhl>>;
  trialStatus: string | null;
};

const CANADA_AREA_CODES = new Set([
  "204",
  "226",
  "236",
  "249",
  "250",
  "263",
  "289",
  "306",
  "343",
  "354",
  "365",
  "367",
  "368",
  "382",
  "403",
  "416",
  "418",
  "431",
  "437",
  "438",
  "450",
  "468",
  "474",
  "506",
  "514",
  "519",
  "548",
  "579",
  "581",
  "584",
  "587",
  "604",
  "613",
  "639",
  "647",
  "672",
  "683",
  "705",
  "709",
  "742",
  "753",
  "778",
  "780",
  "782",
  "807",
  "819",
  "825",
  "867",
  "873",
  "902",
  "905",
]);

const US_AREA_CODES = new Set([
  "201",
  "202",
  "203",
  "205",
  "206",
  "207",
  "208",
  "209",
  "210",
  "212",
  "213",
  "214",
  "215",
  "216",
  "217",
  "218",
  "219",
  "220",
  "224",
  "225",
  "227",
  "228",
  "229",
  "231",
  "234",
  "239",
  "240",
  "248",
  "251",
  "252",
  "253",
  "254",
  "256",
  "260",
  "262",
  "267",
  "269",
  "270",
  "272",
  "274",
  "276",
  "279",
  "281",
  "301",
  "302",
  "303",
  "304",
  "305",
  "307",
  "308",
  "309",
  "310",
  "312",
  "313",
  "314",
  "315",
  "316",
  "317",
  "318",
  "319",
  "320",
  "321",
  "323",
  "325",
  "326",
  "327",
  "330",
  "331",
  "332",
  "334",
  "336",
  "337",
  "339",
  "341",
  "346",
  "347",
  "351",
  "352",
  "360",
  "361",
  "364",
  "380",
  "385",
  "386",
  "401",
  "402",
  "404",
  "405",
  "406",
  "407",
  "408",
  "409",
  "410",
  "412",
  "413",
  "414",
  "415",
  "417",
  "419",
  "423",
  "424",
  "425",
  "430",
  "432",
  "434",
  "435",
  "440",
  "442",
  "443",
  "445",
  "447",
  "448",
  "458",
  "463",
  "464",
  "469",
  "470",
  "475",
  "478",
  "479",
  "480",
  "484",
  "501",
  "502",
  "503",
  "504",
  "505",
  "507",
  "508",
  "509",
  "510",
  "512",
  "513",
  "515",
  "516",
  "517",
  "518",
  "520",
  "530",
  "531",
  "534",
  "539",
  "540",
  "541",
  "551",
  "557",
  "559",
  "561",
  "562",
  "563",
  "564",
  "567",
  "570",
  "571",
  "572",
  "573",
  "574",
  "575",
  "580",
  "582",
  "585",
  "586",
  "601",
  "602",
  "603",
  "605",
  "606",
  "607",
  "608",
  "609",
  "610",
  "612",
  "614",
  "615",
  "616",
  "617",
  "618",
  "619",
  "620",
  "623",
  "626",
  "628",
  "629",
  "630",
  "631",
  "636",
  "640",
  "641",
  "646",
  "650",
  "651",
  "657",
  "659",
  "660",
  "661",
  "662",
  "667",
  "669",
  "678",
  "680",
  "681",
  "682",
  "701",
  "702",
  "703",
  "704",
  "706",
  "707",
  "708",
  "712",
  "713",
  "714",
  "715",
  "716",
  "717",
  "718",
  "719",
  "720",
  "724",
  "725",
  "727",
  "728",
  "730",
  "731",
  "732",
  "734",
  "737",
  "740",
  "743",
  "747",
  "754",
  "757",
  "760",
  "762",
  "763",
  "765",
  "769",
  "770",
  "771",
  "772",
  "773",
  "774",
  "775",
  "779",
  "781",
  "785",
  "786",
  "801",
  "802",
  "803",
  "804",
  "805",
  "806",
  "808",
  "810",
  "812",
  "813",
  "814",
  "815",
  "816",
  "817",
  "818",
  "820",
  "826",
  "828",
  "830",
  "831",
  "832",
  "835",
  "838",
  "839",
  "840",
  "843",
  "845",
  "847",
  "848",
  "850",
  "854",
  "856",
  "857",
  "858",
  "859",
  "860",
  "862",
  "864",
  "865",
  "870",
  "872",
  "878",
  "901",
  "903",
  "904",
  "906",
  "907",
  "908",
  "909",
  "910",
  "912",
  "913",
  "914",
  "915",
  "916",
  "917",
  "918",
  "919",
  "920",
  "925",
  "928",
  "929",
  "930",
  "931",
  "934",
  "936",
  "937",
  "938",
  "940",
  "941",
  "943",
  "945",
  "947",
  "948",
  "949",
  "951",
  "952",
  "954",
  "956",
  "959",
  "970",
  "971",
  "972",
  "973",
  "975",
  "978",
  "979",
  "980",
  "983",
  "984",
  "985",
  "986",
  "989",
]);

function readEnv(name: string) {
  return process.env[name]?.trim() || "";
}

function readPositiveInt(name: string, fallback: number) {
  const parsed = Number.parseInt(readEnv(name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maskEmail(email: string) {
  if (readEnv("GHL_US_CA_TRIAL_LEADS_SHOW_EMAILS") === "true") {
    return email;
  }

  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function maskPhone(phone: string | null | undefined) {
  if (!phone) return null;
  if (readEnv("GHL_US_CA_TRIAL_LEADS_SHOW_PHONES") === "true") {
    return phone;
  }

  const raw = phone.trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "***";

  const prefix = raw.startsWith("+")
    ? `+${digits.slice(0, Math.min(4, digits.length))}`
    : digits.slice(0, Math.min(3, digits.length));
  return `${prefix}***${digits.slice(-2)}`;
}

function phoneDigits(phone: string | null | undefined) {
  return String(phone || "").replace(/\D/g, "");
}

function startsWithPlus(phone: string | null | undefined) {
  return String(phone || "").trim().startsWith("+");
}

function getAreaCode(phone: string | null | undefined) {
  const digits = phoneDigits(phone);
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

function getContextFlags(country: string | null | undefined, website: string | null | undefined) {
  const countryText = String(country || "").trim().toLowerCase();
  const websiteText = String(website || "").trim().toLowerCase();

  return {
    canada:
      countryText.includes("canada") ||
      ["on", "ab", "bc", "qc", "ca"].includes(countryText) ||
      /\.(ca)(\/|$)/.test(websiteText) ||
      /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(String(country || "")),
    india:
      countryText.includes("india") ||
      countryText.includes("gujarat") ||
      countryText.includes("haryana") ||
      countryText.includes("kolkata") ||
      countryText.includes("maharashtra") ||
      countryText.includes("uttar pradesh") ||
      /\.(in)(\/|$)/.test(websiteText) ||
      /\b[1-9]\d{5}\b/.test(countryText),
    us:
      countryText.includes("united states") ||
      ["usa", "us"].includes(countryText) ||
      /\b[A-Z]{2}\s?\d{5}\b/i.test(String(country || "")),
  };
}

function classifyUsCanadaSignupPhone(input: {
  country?: string | null;
  phone?: string | null;
  website?: string | null;
}): UsCanadaClassification {
  const digits = phoneDigits(input.phone);
  const explicitPlus = startsWithPlus(input.phone);
  const flags = getContextFlags(input.country, input.website);
  const areaCode = getAreaCode(input.phone);
  const knownCanada = Boolean(areaCode && CANADA_AREA_CODES.has(areaCode));
  const knownUs = Boolean(areaCode && US_AREA_CODES.has(areaCode));

  if (!digits) {
    return { include: false, reason: "missing_phone" };
  }

  if (digits.startsWith("91") && digits.length === 12) {
    return { include: false, reason: "indian_signup_phone" };
  }

  if (explicitPlus && digits.length === 11 && digits.startsWith("1")) {
    return {
      areaCode,
      country: flags.canada || knownCanada ? "Canada" : "United States",
      include: true,
      matchType: "explicit_plus1",
    };
  }

  if (explicitPlus) {
    return { include: false, reason: "non_us_ca_country_code" };
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1") &&
    areaCode &&
    (knownCanada || knownUs) &&
    !flags.india &&
    (flags.canada || flags.us)
  ) {
    return {
      areaCode,
      country: flags.canada || knownCanada ? "Canada" : "United States",
      include: true,
      matchType: "one_prefix_with_us_ca_context",
    };
  }

  if (
    digits.length === 10 &&
    areaCode &&
    (knownCanada || knownUs) &&
    !flags.india &&
    (flags.canada || flags.us)
  ) {
    return {
      areaCode,
      country: flags.canada || knownCanada ? "Canada" : "United States",
      include: true,
      matchType: "local_with_us_ca_context",
    };
  }

  if (
    (digits.length === 10 || digits.length === 11) &&
    areaCode &&
    (knownCanada || knownUs) &&
    flags.india
  ) {
    return { include: false, reason: "local_phone_with_india_context" };
  }

  if ((digits.length === 10 || digits.length === 11) && areaCode && (knownCanada || knownUs)) {
    return { include: false, reason: "local_phone_without_us_ca_context" };
  }

  return { include: false, reason: "not_us_ca_phone" };
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}

const commit = readEnv("GHL_US_CA_TRIAL_LEADS_COMMIT") === "true";
const recentDays = readPositiveInt("GHL_US_CA_TRIAL_LEADS_RECENT_DAYS", 20);
const limit = Math.min(readPositiveInt("GHL_US_CA_TRIAL_LEADS_LIMIT", 500), 500);
const createdAfter = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);

if (!readEnv("GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE")) {
  process.env.GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE =
    "{{business_name}} - {{name}} - Uplift trial lead";
}

try {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    where: {
      createdAt: { gte: createdAfter },
      OR: [
        { trialStatus: "active" },
        {
          business: {
            some: {
              websiteSubscription: {
                is: {
                  OR: [{ status: "trialing" }, { trialStatus: "trialing" }],
                },
              },
            },
          },
        },
      ],
    },
    select: {
      createdAt: true,
      email: true,
      id: true,
      name: true,
      phone: true,
      trialStatus: true,
      business: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          businessCountry: true,
          businessName: true,
          businessWebsiteUrl: true,
          onboardingStatus: true,
          websiteStatus: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
            },
          },
        },
      },
    },
  });

  const excluded: Record<string, number> = {};
  const results: LeadResult[] = [];

  for (const user of users) {
    const business = user.business[0] || null;

    if (business?.websiteSubscription?.status === "active") {
      excluded.active_subscription = (excluded.active_subscription || 0) + 1;
      continue;
    }

    const classification = classifyUsCanadaSignupPhone({
      country: business?.businessCountry,
      phone: user.phone,
      website: business?.businessWebsiteUrl,
    });

    if (!classification.include) {
      excluded[classification.reason] = (excluded[classification.reason] || 0) + 1;
      continue;
    }

    const signupUser = {
      businessName: business?.businessName,
      businessWebsite: business?.businessWebsiteUrl,
      country: business?.businessCountry,
      createdAt: user.createdAt,
      email: user.email,
      id: user.id,
      name: user.name,
      phone: user.phone,
    };
    const preview = buildGhlSignupPayloadPreview(signupUser);
    const base: LeadResult = {
      action: commit ? "pending-sync" : "dry-run",
      areaCode: classification.areaCode,
      business: {
        country: business?.businessCountry || null,
        name: business?.businessName || null,
        onboardingStatus: business?.onboardingStatus || null,
        website: business?.businessWebsiteUrl || null,
        websiteStatus: business?.websiteStatus || null,
      },
      contact: {
        email: maskEmail(user.email),
        name: user.name,
        phone: maskPhone(user.phone),
      },
      country: classification.country,
      createdAt: toIso(user.createdAt),
      matchType: classification.matchType,
      preview:
        preview.status === "ready"
          ? {
              contactEndpoint: preview.endpoint,
              contactHasEmail: Boolean(preview.payload.email),
              contactHasPhone: Boolean(preview.payload.phone),
              contactHasCompanyName: Boolean(preview.payload.companyName),
              contactHasWebsite: Boolean(preview.payload.website),
              contactTags: preview.payload.tags,
              customFieldCount: Array.isArray(preview.payload.customFields)
                ? preview.payload.customFields.length
                : 0,
              opportunity:
                preview.opportunity?.status === "ready"
                  ? {
                      endpoint: preview.opportunity.endpoint,
                      name: preview.opportunity.payload.name,
                      pipelineId: preview.opportunity.payload.pipelineId,
                      pipelineStageId: preview.opportunity.payload.pipelineStageId,
                      status: preview.opportunity.payload.status,
                    }
                  : preview.opportunity,
            }
          : preview,
      subscriptionStatus: business?.websiteSubscription?.status || null,
      trialStatus: user.trialStatus,
    };

    if (!commit) {
      results.push(base);
      continue;
    }

    const syncResult = await syncSignupToGhl(signupUser);
    results.push({
      ...base,
      action: "synced",
      syncResult,
    });
  }

  const countsByCountry: Record<string, number> = {};
  const countsByMatchType: Record<string, number> = {};
  const syncSummary: Record<string, number> = {};

  for (const result of results) {
    countsByCountry[result.country] = (countsByCountry[result.country] || 0) + 1;
    countsByMatchType[result.matchType] =
      (countsByMatchType[result.matchType] || 0) + 1;

    if (result.syncResult) {
      const status = result.syncResult.status;
      syncSummary[status] = (syncSummary[status] || 0) + 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        commit,
        countsByCountry,
        countsByMatchType,
        createOpportunities:
          process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED === "true",
        excluded,
        leadCount: results.length,
        limit,
        note: commit
          ? "Committed to GHL. Contact emails and phones are masked in this output."
          : "Dry run only. No GHL writes were made.",
        recentDays,
        results,
        syncSummary,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
