import crypto from "node:crypto";
import { prisma } from "../config/db.config";
import { signBackendAuthToken } from "../utils/backend-auth-token";
import { SECURITY_TENANT_A as A, SECURITY_TENANT_B as B } from "./seed-local-security-tenants";

const baseUrl = (process.env.SECURITY_AUDIT_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const backendSecret = process.env.BACKEND_AUTH_SECRET?.trim() ?? "";
const internalAuthEmailSecret = process.env.INTERNAL_AUTH_EMAIL_SECRET?.trim() ?? "";
const internalBillingSecret = process.env.INTERNAL_BILLING_SECRET?.trim() ?? "";
const internalOnboardingSecret = process.env.INTERNAL_ONBOARDING_SECRET?.trim() ?? "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";

function assertLocalTargets() {
  const api = new URL(baseUrl);
  if (!["localhost", "127.0.0.1"].includes(api.hostname)) {
    throw new Error(`Refusing HTTP security audit against non-local API host: ${api.hostname}`);
  }
  const db = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(db.hostname)) {
    throw new Error(`Refusing HTTP security audit against non-local DB host: ${db.hostname}`);
  }
  if (Buffer.byteLength(backendSecret) < 32) throw new Error("Strong BACKEND_AUTH_SECRET required");
  for (const [name, value] of Object.entries({
    INTERNAL_AUTH_EMAIL_SECRET: internalAuthEmailSecret,
    INTERNAL_BILLING_SECRET: internalBillingSecret,
    INTERNAL_ONBOARDING_SECRET: internalOnboardingSecret,
  })) {
    if (Buffer.byteLength(value, "utf8") < 32) {
      throw new Error(`Strong ${name} required`);
    }
  }
  if (Buffer.byteLength(stripeWebhookSecret, "utf8") < 32) {
    throw new Error("Strong local STRIPE_WEBHOOK_SECRET required");
  }
}

type AuditResponse = { status: number; headers: Headers; body: any };

async function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<AuditResponse> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, headers: response.headers, body };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function customAssertion(userId: string, overrides: Record<string, unknown>) {
  const now = Date.now();
  const payload = {
    v: 1,
    iss: "uplift-next",
    aud: "uplift-api",
    userId,
    iat: now,
    exp: now + 60_000,
    jti: crypto.randomBytes(16).toString("base64url"),
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", backendSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function stripeWebhookRequest(
  payload: Record<string, unknown>,
  options?: { signature?: string; timestamp?: number },
): Promise<AuditResponse> {
  const body = JSON.stringify(payload);
  const timestamp = options?.timestamp ?? Math.floor(Date.now() / 1000);
  const digest = crypto
    .createHmac("sha256", stripeWebhookSecret)
    .update(String(timestamp) + "." + body)
    .digest("hex");
  const response = await fetch(baseUrl + "/api/v1/stripe/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature":
        options?.signature ?? "t=" + timestamp + ",v1=" + digest,
    },
    body,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json().catch(() => null),
  };
}

const passed: string[] = [];
function pass(name: string) {
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function main() {
  assertLocalTargets();
  const tokenA = signBackendAuthToken(A.userId);
  const tokenB = signBackendAuthToken(B.userId);
  expect(tokenA && tokenB, "Could not sign backend assertions");

  const health = await request("/api/v1");
  expect(health.status === 200, `API health expected 200, received ${health.status}`);
  expect(!health.headers.get("x-powered-by"), "Express technology header is exposed");
  expect(health.headers.get("x-content-type-options") === "nosniff", "Missing nosniff header");
  expect(health.headers.get("x-frame-options") === "DENY", "Missing anti-framing header");
  expect(health.headers.get("referrer-policy") === "no-referrer", "Missing referrer policy");
  expect(health.headers.get("content-security-policy")?.includes("default-src 'none'"), "Missing API content security policy");
  pass("technology header suppressed and API security headers enforced");

  const malformedResponse = await fetch(`${baseUrl}/api/v1/business/settings/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  const malformedText = await malformedResponse.text();
  expect(
    malformedResponse.status === 400 &&
      malformedResponse.headers.get("content-type")?.includes("application/json") &&
      !malformedText.includes("SyntaxError") &&
      !malformedText.includes("node_modules"),
    "Malformed JSON reflected parser diagnostics",
  );
  const oversizedResponse = await fetch(`${baseUrl}/api/v1/business/settings/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "a".repeat(1024 * 1024 + 1) }),
  });
  const oversizedText = await oversizedResponse.text();
  expect(
    oversizedResponse.status === 413 &&
      oversizedResponse.headers.get("content-type")?.includes("application/json") &&
      !oversizedText.includes("PayloadTooLargeError") &&
      !oversizedText.includes("node_modules"),
    "Oversized JSON was accepted or leaked parser diagnostics",
  );
  const missingRoute = await request("/api/v1/route-that-does-not-exist");
  expect(
    missingRoute.status === 404 && missingRoute.body?.message === "Not found",
    "Unknown API route did not return the generic JSON 404",
  );
  pass("bounded JSON parsing and generic malformed, oversized, and unknown-route responses");

  const framerPreflight = await fetch(`${baseUrl}/api/public/v1/framer-plugin/authorize`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://plugins.framer.com",
      "Access-Control-Request-Method": "POST",
    },
  });
  expect(
    framerPreflight.status === 200 &&
      framerPreflight.headers.get("access-control-allow-origin") === "https://plugins.framer.com",
    "Framer sandbox CORS preflight was not narrowly allowed",
  );
  const hostilePreflight = await fetch(`${baseUrl}/api/public/v1/framer-plugin/authorize`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  expect(
    !hostilePreflight.headers.has("access-control-allow-origin"),
    "Arbitrary origin received public API CORS access",
  );
  const [publicRobotsMetadata, publicAuditMetadata, framerAuditMetadata, publicNonStandardPort] =
    await Promise.all([
      request("/api/public/v1/tools/robots-txt", {
        body: { url: "http://169.254.169.254/latest/meta-data" },
      }),
      request("/api/public/v1/seo-audit", {
        body: { url: "http://127.0.0.1:3100/api/v1" },
      }),
      request("/api/public/v1/framer-plugin/audit", {
        body: { url: "http://10.0.0.1/private" },
      }),
      request("/api/public/v1/tools/sitemap", {
        body: { url: "https://example.com:8443/sitemap.xml" },
      }),
    ]);
  expect(publicRobotsMetadata.status === 400, "Public robots tool accepted a metadata URL");
  expect(publicAuditMetadata.status === 400, "Public SEO audit accepted a loopback URL");
  expect(framerAuditMetadata.status === 400, "Framer audit accepted a private-network URL");
  expect(publicNonStandardPort.status === 400, "Public sitemap tool accepted a nonstandard port");
  expect(
    !JSON.stringify(publicRobotsMetadata.body).includes("169.254") &&
      !JSON.stringify(publicAuditMetadata.body).includes("127.0.0.1") &&
      !JSON.stringify(framerAuditMetadata.body).includes("10.0.0.1"),
    "Public SSRF rejection reflected a sensitive target",
  );
  pass("public crawler SSRF, private-network, and nonstandard-port rejection");
  let publicToolRateLimited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await request("/api/public/v1/tools/robots-txt", { body: {} });
    if (result.status === 429) {
      expect(Boolean(result.headers.get("retry-after")), "Public-tool 429 omitted Retry-After");
      publicToolRateLimited = true;
      break;
    }
  }
  expect(publicToolRateLimited, "Redis-backed public-tool abuse protection did not activate");
  pass("narrow Framer CORS and Redis-backed public endpoint abuse limit");

  const pluginNonce = crypto.randomBytes(32).toString("hex");
  const framerAuthorize = await request("/api/public/v1/framer-plugin/authorize", {
    body: { pluginNonce },
  });
  const framerReadKey = framerAuthorize.body?.readKey as string | undefined;
  expect(
    framerAuthorize.status === 200 &&
      framerReadKey &&
      /^frh_v2\.read\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(framerReadKey),
    "Framer authorization did not issue a v2 read credential",
  );
  const storedFramerRead = await prisma.framerPluginHandshake.findFirst({
    where: { readKeyDigest: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      readKey: true,
      readKeyDigest: true,
      exchangeCode: true,
      exchangeCodeDigest: true,
    },
  });
  expect(
    storedFramerRead &&
      storedFramerRead.readKey !== framerReadKey &&
      /^[0-9a-f]{32}$/.test(storedFramerRead.readKey) &&
      /^[0-9a-f]{64}$/.test(storedFramerRead.readKeyDigest ?? ""),
    "Framer read credential was stored in plaintext or without an HMAC digest",
  );
  const wrongNoncePoll = await request(
    `/api/public/v1/framer-plugin/poll?readKey=${encodeURIComponent(framerReadKey)}`,
    {
      method: "POST",
      headers: { "X-Plugin-Nonce": crypto.randomBytes(32).toString("hex") },
    },
  );
  expect(
    wrongNoncePoll.status === 401,
    `Framer poll accepted the wrong plugin nonce (${wrongNoncePoll.status}: ${JSON.stringify(wrongNoncePoll.body)})`,
  );
  const storeFramerHandshake = await request("/api/v1/framer-plugin/handshake", {
    token: tokenA,
    body: { readKey: framerReadKey },
  });
  expect(storeFramerHandshake.status === 200, "Authenticated Framer handshake completion failed");
  const crossUserFramerClaim = await request("/api/v1/framer-plugin/handshake", {
    token: tokenB,
    body: { readKey: framerReadKey },
  });
  expect(
    crossUserFramerClaim.status === 410,
    "A second authenticated user replaced the Framer handshake owner",
  );
  const boundFramerRow = await prisma.framerPluginHandshake.findUnique({
    where: { readKey: storedFramerRead!.readKey },
    select: { exchangeCode: true, exchangeCodeDigest: true, userId: true },
  });
  expect(
    boundFramerRow?.userId === A.userId &&
      boundFramerRow.exchangeCode &&
      !boundFramerRow.exchangeCode.startsWith("frh_v2.") &&
      /^[0-9a-f]{64}$/.test(boundFramerRow.exchangeCodeDigest ?? ""),
    "Framer exchange credential was not encrypted and HMAC-digested at rest",
  );
  const framerPoll = await request(
    `/api/public/v1/framer-plugin/poll?readKey=${encodeURIComponent(framerReadKey)}`,
    { method: "POST", headers: { "X-Plugin-Nonce": pluginNonce } },
  );
  const framerExchangeCode = framerPoll.body?.exchangeCode as string | undefined;
  expect(
    framerPoll.status === 200 &&
      framerExchangeCode &&
      /^frh_v2\.exchange\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(framerExchangeCode),
    "Framer poll did not return the purpose-bound exchange credential",
  );
  const tamperedFramerExchange = await request("/api/public/v1/framer-plugin/exchange", {
    body: { exchangeCode: `${framerExchangeCode.slice(0, -1)}x` },
  });
  expect(tamperedFramerExchange.status === 410, "Tampered Framer exchange credential was accepted");
  const framerExchange = await request("/api/public/v1/framer-plugin/exchange", {
    body: { exchangeCode: framerExchangeCode },
  });
  const framerSessionToken = framerExchange.body?.sessionToken as string | undefined;
  expect(
    framerExchange.status === 200 &&
      framerSessionToken &&
      /^frh_v2\.connect\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(framerSessionToken) &&
      framerExchange.body?.userId === undefined,
    "Framer exchange leaked identity or did not issue a purpose-bound connect credential",
  );
  const connectFramer = await request("/api/v1/framer-plugin/connect", {
    token: framerSessionToken,
    body: {
      apiKey: "framer-local-security-secret",
      projectId: "local-project",
      collectionId: "local-collection",
      collectionName: "Security blogs",
      businessId: A.businessId,
    },
  });
  expect(connectFramer.status === 200, "Framer connect failed with its single-use credential");
  const storedFramerIntegration = await prisma.publishingIntegration.findFirst({
    where: { userId: A.userId, businessId: A.businessId, platform: "FRAMER" },
    select: { framerApiKey: true },
  });
  expect(
    storedFramerIntegration?.framerApiKey &&
      storedFramerIntegration.framerApiKey !== "framer-local-security-secret" &&
      !storedFramerIntegration.framerApiKey.includes("framer-local-security-secret"),
    "Framer API key was stored in plaintext",
  );
  const replayFramerConnect = await request("/api/v1/framer-plugin/connect", {
    token: framerSessionToken,
    body: {
      apiKey: "framer-local-security-secret",
      projectId: "local-project",
      collectionName: "Security blogs",
      businessId: A.businessId,
    },
  });
  expect(replayFramerConnect.status === 401, "Framer connect credential was replayable");
  pass("Framer purpose-bound credentials, encrypted storage, tamper rejection, and atomic single use");

  const anonymous = await request("/api/v1/business/settings/info", { body: {} });
  expect(anonymous.status === 401 && anonymous.body?.message === "Unauthorized", "Anonymous business route was not rejected");
  pass("anonymous protected-route rejection");

  const tampered = `${tokenA.slice(0, -1)}${tokenA.endsWith("a") ? "b" : "a"}`;
  const tamperedResponse = await request("/api/v1/business/settings/info", { token: tampered, body: {} });
  expect(tamperedResponse.status === 401, "Tampered backend assertion was accepted");
  const expiredResponse = await request("/api/v1/business/settings/info", {
    token: customAssertion(A.userId, { iat: Date.now() - 120_000, exp: Date.now() - 60_000 }),
    body: {},
  });
  expect(expiredResponse.status === 401, "Expired backend assertion was accepted");
  const audienceResponse = await request("/api/v1/business/settings/info", {
    token: customAssertion(A.userId, { aud: "attacker-service" }),
    body: {},
  });
  expect(audienceResponse.status === 401, "Wrong-audience assertion was accepted");
  pass("tampered, expired, and wrong-audience assertion rejection");

  const billingSecretOnAuthEmail = await request(
    "/api/v1/internal/auth-email/password-reset",
    {
      body: {},
      headers: { "X-Internal-Secret": internalBillingSecret },
    },
  );
  const authEmailSecretOnBilling = await request(
    "/api/v1/billing/internal/events",
    {
      body: {},
      headers: { "X-Internal-Secret": internalAuthEmailSecret },
    },
  );
  const billingSecretOnOnboarding = await request(
    "/api/v1/website/internal/trigger-onboarding",
    {
      body: { businessId: A.businessId },
      headers: { "X-Internal-Secret": internalBillingSecret },
    },
  );
  const normalUserRewardfulAdmin = await request(
    "/api/v1/rewardful/internal/health",
    { token: tokenA },
  );
  expect(
    billingSecretOnAuthEmail.status === 401 &&
      authEmailSecretOnBilling.status === 401 &&
      billingSecretOnOnboarding.status === 401,
    "An internal purpose-bound secret authorized a different capability",
  );
  expect(
    normalUserRewardfulAdmin.status === 403,
    "A normal user reached Rewardful administrative diagnostics",
  );
  pass("purpose-bound internal secrets and Rewardful SUPERADMIN isolation");

  const anonymousAccount = await request("/api/v1/account/context");
  expect(anonymousAccount.status === 401, "Anonymous account context was accepted");
  const [accountContext, accountSecurity, postAuthA, postAuthB, dashboardAccess, nonAdminSurface] = await Promise.all([
    request("/api/v1/account/context", { token: tokenA }),
    request("/api/v1/account/security", { token: tokenA }),
    request("/api/v1/account/post-auth-destination", { token: tokenA }),
    request("/api/v1/account/post-auth-destination", { token: tokenB }),
    request("/api/v1/account/dashboard-access", { token: tokenA }),
    request("/api/v1/superadmin/agencies/metrics/overview", { token: tokenA }),
  ]);
  expect(
    accountContext.status === 200 &&
      accountContext.body?.data?.id === A.userId &&
      accountContext.body?.data?.role === "USER" &&
      !JSON.stringify(accountContext.body).includes(B.userId),
    "Account context crossed the authenticated identity boundary",
  );
  expect(
    accountSecurity.status === 200 &&
      accountSecurity.body?.data?.hasCredentialAccount === true &&
      !JSON.stringify(accountSecurity.body).includes("local-password-hash"),
    "Account security route leaked a password hash or returned the wrong state",
  );
  expect(
    postAuthA.body?.data?.resumeOnboarding === true &&
      postAuthB.body?.data?.resumeOnboarding === false,
    "Post-auth destination was not scoped to the authenticated user",
  );
  expect(nonAdminSurface.status === 403, "Normal user reached a SUPERADMIN backend route");
  expect(dashboardAccess.body?.data?.hasAccess === true, "Backend dashboard gate rejected an eligible user");
  expect(accountContext.headers.get("cache-control")?.includes("no-store"), "Account context was cacheable");
  pass("account context, credential-hash redaction, post-auth isolation, and backend role gate");

  const ownBusiness = await request("/api/v1/business/settings/info", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  expect(ownBusiness.status === 200 && ownBusiness.body?.data?.business?.id === A.businessId, "Tenant A could not read its business");
  const crossBusiness = await request("/api/v1/business/settings/info", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  expect(crossBusiness.status === 404 && !crossBusiness.body?.data, "Tenant A read tenant B business");
  const crossDashboard = await request("/api/v1/dashboard/snapshot", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  expect(crossDashboard.status === 404, "Tenant A read tenant B dashboard cache surface");
  const ownAccess = await request("/api/v1/business/access", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  const crossAccess = await request("/api/v1/business/access", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  const websiteList = await request("/api/v1/website/list", {
    token: tokenA,
    body: { includeInactive: true },
  });
  expect(ownAccess.status === 200, "Backend business access check rejected the owner");
  expect(crossAccess.status === 404, "Backend business access check authorized another tenant");
  const websiteListJson = JSON.stringify(websiteList.body);
  expect(
    websiteList.status === 200 && websiteList.body?.data?.[0]?.id === A.businessId,
    "Owned website list projection was unavailable",
  );
  expect(
    !websiteListJson.includes('"userId"') &&
      !websiteListJson.includes("stripeSubscriptionId") &&
      !websiteListJson.includes("stripeSubscriptionItemId") &&
      !websiteListJson.includes("stripePriceId") &&
      !websiteListJson.includes("removalOperationKey") &&
      !websiteListJson.includes("onboardingCorrelationId"),
    "Website list exposed tenant, billing, or operation identifiers",
  );
  const canceledWebsite = websiteList.body?.data?.find(
    (website: { id?: string }) => website.id === A.canceledBusinessId,
  );
  expect(
    canceledWebsite?.isActive === false &&
      canceledWebsite?.workspaceAccess?.canAccessWorkspace === false &&
      canceledWebsite?.workspaceAccess?.canSelectWorkspace === false &&
      canceledWebsite?.workspaceAccess?.reason === "website_canceled",
    "Canceled owned record was omitted from recovery history or exposed as a workspace",
  );
  const canceledSwitch = await request("/api/v1/website/switch", {
    token: tokenA,
    body: { businessId: A.canceledBusinessId },
  });
  expect(
    canceledSwitch.status === 409 &&
      canceledSwitch.body?.success === false &&
      canceledSwitch.body?.message === "Website is not available for selection" &&
      !JSON.stringify(canceledSwitch.body).includes("stripe") &&
      !JSON.stringify(canceledSwitch.body).includes("subscription"),
    "Canceled workspace switch was accepted or leaked internal billing state",
  );
  const canceledPrimaryUpdate = await request("/api/v1/website/update", {
    method: "PATCH",
    token: tokenA,
    body: { businessId: A.canceledBusinessId, isPrimary: true },
  });
  expect(
    canceledPrimaryUpdate.status === 409 &&
      canceledPrimaryUpdate.body?.message ===
        "Website is not available for selection",
    "Generic website update path promoted a canceled workspace",
  );
  const safeOwnUpdate = await request("/api/v1/website/update", {
    method: "PATCH",
    token: tokenA,
    body: { businessId: A.businessId, businessName: "Security Business A" },
  });
  const safeOwnUpdateJson = JSON.stringify(safeOwnUpdate.body);
  expect(
    safeOwnUpdate.status === 200 &&
      safeOwnUpdate.body?.data?.data?.id === A.businessId &&
      !safeOwnUpdateJson.includes('"userId"') &&
      !safeOwnUpdateJson.includes("stripeSubscription") &&
      !safeOwnUpdateJson.includes("removalOperationKey"),
    "Website update response exposed a tenant, billing, or operation field",
  );
  const persistedPrimary = await prisma.business.findFirst({
    where: { userId: A.userId, isPrimary: true },
    select: { id: true },
  });
  expect(
    persistedPrimary?.id === A.businessId,
    "Rejected canceled-workspace switch mutated the user's primary selection",
  );
  const concurrentSwitches = await Promise.all([
    request("/api/v1/website/switch", {
      token: tokenA,
      body: { businessId: A.switchBusinessOneId },
    }),
    request("/api/v1/website/switch", {
      token: tokenA,
      body: { businessId: A.switchBusinessTwoId },
    }),
  ]);
  expect(
    concurrentSwitches.every((result) => result.status === 200),
    "Concurrent eligible workspace switches did not complete safely",
  );
  const primaryAfterConcurrentSwitch = await prisma.business.findMany({
    where: { userId: A.userId, isPrimary: true },
    select: { id: true },
  });
  expect(
    primaryAfterConcurrentSwitch.length === 1 &&
      [A.switchBusinessOneId, A.switchBusinessTwoId].includes(
        primaryAfterConcurrentSwitch[0]?.id as
          | typeof A.switchBusinessOneId
          | typeof A.switchBusinessTwoId,
      ),
    "Concurrent workspace switches created zero or multiple primary records",
  );
  const restorePrimary = await request("/api/v1/website/switch", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  const finalPrimary = await prisma.business.findMany({
    where: { userId: A.userId, isPrimary: true },
    select: { id: true },
  });
  expect(
    restorePrimary.status === 200 &&
      finalPrimary.length === 1 &&
      finalPrimary[0]?.id === A.businessId,
    "Workspace selection did not restore one deterministic primary record",
  );
  pass("business/dashboard isolation, allow-listed projection, and canceled-workspace rejection");

  const anonymousBilling = await request("/api/v1/billing/portal-session", { body: {} });
  const ownBillingWithoutSubscription = await request("/api/v1/billing/portal-session", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  const crossBilling = await request("/api/v1/billing/portal-session", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  const injectedBilling = await request("/api/v1/billing/payment-method-session", {
    token: tokenA,
    body: { businessId: A.businessId, userId: B.userId },
  });
  const anonymousCancel = await request("/api/v1/billing/subscription/cancel", {
    body: { businessId: A.businessId },
  });
  const crossCancel = await request("/api/v1/billing/subscription/cancel", {
    token: tokenA,
    body: { businessId: B.businessId, cancelAtPeriodEnd: false },
  });
  const injectedReactivate = await request(
    "/api/v1/billing/subscription/reactivate",
    {
      token: tokenA,
      body: { businessId: A.businessId, userId: B.userId },
    },
  );
  const anonymousPlanChange = await request(
    "/api/v1/billing/subscription/change-plan",
    {
      body: {
        businessId: A.businessId,
        targetBillingPeriod: "monthly",
        targetPlanTier: "SEO_SOCIAL",
      },
    },
  );
  const crossPlanChange = await request(
    "/api/v1/billing/subscription/change-plan",
    {
      token: tokenA,
      body: {
        businessId: B.businessId,
        targetBillingPeriod: "monthly",
        targetPlanTier: "SEO_SOCIAL",
      },
    },
  );
  const injectedPlanChange = await request(
    "/api/v1/billing/subscription/change-plan",
    {
      token: tokenA,
      body: {
        businessId: A.businessId,
        targetBillingPeriod: "monthly",
        targetPlanTier: "SEO_SOCIAL",
        stripePriceId: "price_attacker_controlled",
        userId: B.userId,
      },
    },
  );
  const anonymousCancelScheduledPlanChange = await request(
    "/api/v1/billing/subscription/cancel-scheduled-change",
    { body: { businessId: A.businessId } },
  );
  const crossCancelScheduledPlanChange = await request(
    "/api/v1/billing/subscription/cancel-scheduled-change",
    { token: tokenA, body: { businessId: B.businessId } },
  );
  const injectedCancelScheduledPlanChange = await request(
    "/api/v1/billing/subscription/cancel-scheduled-change",
    {
      token: tokenA,
      body: {
        businessId: A.businessId,
        userId: B.userId,
        scheduleId: "sched_attacker_controlled",
      },
    },
  );
  const anonymousPrimaryCheckout = await request("/api/v1/billing/checkout", {
    body: {},
  });
  const injectedPrimaryCheckout = await request("/api/v1/billing/checkout", {
    token: tokenA,
    body: {
      userId: B.userId,
      businessId: B.businessId,
      stripeCustomerId: "cus_attacker_controlled",
      stripePriceId: "price_attacker_controlled",
      billingPeriod: "monthly",
      planTier: "SEO",
    },
  });
  const anonymousAddWebsiteCheckout = await request(
    "/api/v1/billing/checkout/add-website",
    { body: { businessId: A.businessId } },
  );
  const crossAddWebsiteCheckout = await request(
    "/api/v1/billing/checkout/add-website",
    {
      token: tokenA,
      body: { businessId: B.businessId },
    },
  );
  const injectedAddWebsiteCheckout = await request(
    "/api/v1/billing/checkout/add-website",
    {
      token: tokenA,
      body: {
        businessId: A.businessId,
        userId: B.userId,
        stripeCustomerId: "cus_attacker_controlled",
        stripePriceId: "price_attacker_controlled",
      },
    },
  );
  const anonymousSessionVerification = await request(
    "/api/v1/billing/checkout/verify-session",
    {
      body: { sessionId: "cs_test_1234567890abcdefghijkl" },
    },
  );
  const malformedSessionVerification = await request(
    "/api/v1/billing/checkout/verify-session",
    {
      token: tokenA,
      body: { sessionId: "not-a-stripe-session" },
    },
  );
  const injectedSessionVerification = await request(
    "/api/v1/billing/checkout/verify-session",
    {
      token: tokenA,
      body: {
        sessionId: "cs_test_1234567890abcdefghijkl",
        businessId: A.businessId,
        userId: B.userId,
        stripeCustomerId: "cus_attacker_controlled",
      },
    },
  );
  const anonymousBillingHistory = await request(
    `/api/v1/billing/history?businessId=${A.businessId}`,
  );
  const crossBillingHistory = await request(
    `/api/v1/billing/history?businessId=${B.businessId}`,
    { token: tokenA },
  );
  const ownBillingHistory = await request(
    `/api/v1/billing/history?businessId=${A.businessId}`,
    { token: tokenA },
  );
  const ownSubscriptionStatus = await request(
    `/api/v1/billing/subscription?businessId=${A.businessId}`,
    { token: tokenA },
  );
  const crossSubscriptionStatus = await request(
    `/api/v1/billing/subscription?businessId=${B.businessId}`,
    { token: tokenA },
  );
  expect(anonymousBilling.status === 401, "Anonymous billing portal request was accepted");
  expect(ownBillingWithoutSubscription.status === 400, "Owned unsubscribed website returned an unsafe billing result");
  expect(crossBilling.status === 404, "Billing portal crossed the business ownership boundary");
  expect(injectedBilling.status === 400, "Billing route accepted client-supplied identity");
  expect(anonymousCancel.status === 401, "Anonymous subscription cancellation was accepted");
  expect(crossCancel.status === 404, "Subscription cancellation crossed the tenant boundary");
  expect(
    injectedReactivate.status === 400,
    "Subscription reactivation accepted client-supplied identity",
  );
  expect(anonymousPlanChange.status === 401, "Anonymous plan change was accepted");
  expect(crossPlanChange.status === 404, "Plan change crossed the tenant boundary");
  expect(
    injectedPlanChange.status === 400,
    "Plan change accepted caller-supplied identity or Stripe price",
  );
  expect(
    anonymousCancelScheduledPlanChange.status === 401,
    "Anonymous scheduled plan cancellation was accepted",
  );
  expect(
    crossCancelScheduledPlanChange.status === 404,
    "Scheduled plan cancellation crossed the tenant boundary",
  );
  expect(
    injectedCancelScheduledPlanChange.status === 400,
    "Scheduled plan cancellation accepted caller-supplied identity or schedule",
  );
  expect(
    anonymousPrimaryCheckout.status === 401,
    "Anonymous primary checkout was accepted",
  );
  expect(
    injectedPrimaryCheckout.status === 400,
    "Primary checkout accepted caller-supplied identity, business, customer, or price",
  );
  expect(
    anonymousAddWebsiteCheckout.status === 401,
    "Anonymous add-website checkout was accepted",
  );
  expect(
    crossAddWebsiteCheckout.status === 404,
    "Add-website checkout crossed the business ownership boundary",
  );
  expect(
    injectedAddWebsiteCheckout.status === 400,
    "Add-website checkout accepted caller-supplied identity, customer, or price",
  );
  expect(
    anonymousSessionVerification.status === 401,
    "Anonymous checkout-session verification was accepted",
  );
  expect(
    malformedSessionVerification.status === 400,
    "Checkout-session verification accepted a malformed provider identifier",
  );
  expect(
    injectedSessionVerification.status === 400,
    "Checkout-session verification accepted caller-supplied identity or customer fields",
  );
  expect(anonymousBillingHistory.status === 401, "Anonymous billing history was exposed");
  expect(crossBillingHistory.status === 404, "Billing history crossed the tenant boundary");
  expect(crossSubscriptionStatus.status === 404, "Subscription status crossed the tenant boundary");
  const billingReadJson = JSON.stringify([
    ownBillingHistory.body,
    ownSubscriptionStatus.body,
  ]);
  expect(
    ownBillingHistory.status === 200 && ownSubscriptionStatus.status === 200,
    "Owned billing read models were unavailable",
  );
  expect(
    !billingReadJson.includes("stripeCustomerId") &&
      !billingReadJson.includes("stripeSubscriptionId") &&
      !billingReadJson.includes("stripeSubscriptionItemId") &&
      !billingReadJson.includes("stripePriceId"),
    "Browser billing read models exposed provider identifiers",
  );
  expect(
    !JSON.stringify([anonymousBilling.body, ownBillingWithoutSubscription.body, crossBilling.body]).includes("STRIPE"),
    "Billing errors exposed Stripe configuration details",
  );
  pass("billing checkout, reads, portal, and lifecycle enforce ownership, minimize provider IDs, and reject identity/provider injection");

  const missingStripeSignature = await request("/api/v1/stripe/webhook", {
    body: { type: "setup_intent.created" },
  });
  const invalidStripeSignature = await stripeWebhookRequest(
    {
      id: "evt_local_invalid_signature",
      object: "event",
      api_version: "2026-03-25.dahlia",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "seti_local_invalid",
          object: "setup_intent",
          metadata: { userId: A.userId },
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "setup_intent.created",
    },
    { signature: "t=1,v1=invalid" },
  );
  const webhookEventId =
    "evt_local_security_" + crypto.randomBytes(10).toString("hex");
  const harmlessStripeEvent = {
    id: webhookEventId,
    object: "event",
    api_version: "2026-03-25.dahlia",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "seti_local_security",
        object: "setup_intent",
        metadata: { userId: A.userId, businessId: A.businessId },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "setup_intent.created",
  };
  const acceptedStripeWebhook =
    await stripeWebhookRequest(harmlessStripeEvent);
  const replayedStripeWebhook =
    await stripeWebhookRequest(harmlessStripeEvent);
  expect(
    missingStripeSignature.status === 401,
    "Stripe webhook accepted a request without a signature",
  );
  expect(
    invalidStripeSignature.status === 401,
    "Stripe webhook accepted an invalid signature",
  );
  expect(
    acceptedStripeWebhook.status === 200 &&
      acceptedStripeWebhook.body?.received === true,
    "Stripe webhook rejected a valid raw-body signature",
  );
  expect(
    replayedStripeWebhook.status === 200 &&
      replayedStripeWebhook.body?.duplicate === true,
    "Stripe webhook event replay was not idempotently rejected",
  );
  pass("Stripe raw-body signature verification and webhook replay protection");

  const injectedIdentity = await request("/api/v1/business/settings/basic", {
    token: tokenA,
    body: {
      businessId: A.businessId,
      userId: B.userId,
      businessName: "Injected",
      businessType: "Security Test",
      businessDescription: "Rejected identity injection",
      businessWebsiteUrl: "https://security-a.local.test",
    },
  });
  expect(injectedIdentity.status === 400, "Client-supplied userId was accepted");
  pass("client identity injection rejection");

  const crossMutations = await Promise.all([
    request("/api/v1/business/settings/competitors/update", {
      token: tokenA,
      body: { competitorId: B.competitorId, name: "Compromised", url: "https://attacker.invalid" },
    }),
    request("/api/v1/business/settings/keywords/update", {
      token: tokenA,
      body: { keywordId: B.keywordId, keyword: "compromised", keywordType: "MUST_HAVE" },
    }),
    request("/api/v1/business/settings/rankings/update", {
      token: tokenA,
      body: { rankingId: B.rankingId, website: "https://attacker.invalid", ranking: "1" },
    }),
  ]);
  expect(crossMutations.every((result) => result.status === 404), "A cross-tenant record mutation was not rejected");
  const tenantBAfter = await request("/api/v1/business/settings/info", {
    token: tokenB,
    body: { businessId: B.businessId },
  });
  const tenantBData = tenantBAfter.body?.data?.business;
  expect(
    tenantBData?.competitiors?.[0]?.name === "Tenant B Competitor" &&
      tenantBData?.keywords?.[0]?.keyword === "tenant-b-keyword" &&
      tenantBData?.currentRanking?.[0]?.ranking === "10",
    "Tenant B records changed after rejected mutation",
  );
  pass("competitor, keyword, and ranking IDOR prevention");

  const ownBlogs = await request("/api/v1/blog/all-blogs", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  expect(
    ownBlogs.status === 200 &&
      ownBlogs.body?.data?.blogs?.some((blog: { id?: string }) => blog.id === A.blogId),
    "Tenant A could not read its own backend content",
  );
  const crossBlogList = await request("/api/v1/blog/all-blogs", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  expect(
    crossBlogList.status === 200 &&
      Array.isArray(crossBlogList.body?.data?.blogs) &&
      crossBlogList.body.data.blogs.length === 0 &&
      !JSON.stringify(crossBlogList.body).includes("Tenant B private blog"),
    "Tenant A listed tenant B content",
  );
  const crossBlogDetail = await request("/api/v1/blog/blog-info", {
    token: tokenA,
    body: { blogId: B.blogId },
  });
  expect(crossBlogDetail.status === 404 && !crossBlogDetail.body?.data, "Tenant A read tenant B blog detail");

  const ownKeywords = await request("/api/v1/keyword/get-keywords", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  expect(
    ownKeywords.status === 200 &&
      ownKeywords.body?.keywords?.some((keyword: { id?: string }) => keyword.id === A.planId),
    "Tenant A could not read its own backend keyword plan",
  );
  const crossKeywords = await request("/api/v1/keyword/get-keywords", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  expect(
    crossKeywords.status === 200 &&
      Array.isArray(crossKeywords.body?.keywords) &&
      crossKeywords.body.keywords.length === 0 &&
      !JSON.stringify(crossKeywords.body).includes("tenant-b-private-plan"),
    "Tenant A listed tenant B keyword plan",
  );
  pass("backend content and keyword tenant isolation");

  const drOwn = await request(`/api/v1/dr-dashboard/overview?businessId=${A.businessId}`, { token: tokenA });
  const drCross = await request(`/api/v1/dr-dashboard/overview?businessId=${B.businessId}`, { token: tokenA });
  const drLegacyPathCross = await request(
    `/api/v1/dr-dashboard/${B.userId}/overview?businessId=${A.businessId}`,
    { token: tokenA },
  );
  const publishingLegacyPathCross = await request(`/api/v1/publishing/user/${B.userId}`, {
    token: tokenA,
  });
  const offPageLegacyPathCross = await request(
    `/api/v1/off-page/${B.userId}/opportunities?businessId=${A.businessId}`,
    { token: tokenA },
  );
  const offPageCanonicalCross = await request(
    `/api/v1/off-page/opportunities?businessId=${B.businessId}`,
    { token: tokenA },
  );
  const offPageCanonicalAnonymous = await request(
    `/api/v1/off-page/opportunities?businessId=${A.businessId}`,
  );
  // The two seeded identities are reserved for this local audit. Reset only
  // their guest-posting fixtures so repeated hostile runs stay deterministic
  // without touching any real local account or global cache.
  await prisma.$transaction([
    prisma.guestPostSubmission.deleteMany({ where: { userId: A.userId } }),
    prisma.guestPostCampaign.deleteMany({ where: { userId: A.userId } }),
    prisma.guestPostPublisher.deleteMany({ where: { userId: A.userId } }),
  ]);
  const guestPostingCanonical = await request("/api/v1/guest-posting/publishers", {
    token: tokenA,
  });
  const guestPostingQueryCross = await request(
    `/api/v1/guest-posting/publishers?userId=${B.userId}`,
    { token: tokenA },
  );
  const guestPublisherCreate = await request("/api/v1/guest-posting/publishers", {
    token: tokenA,
    body: {
      name: "Security Publisher A",
      websiteUrl: "https://publisher-a.local.test",
    },
  });
  const guestPublisherId = guestPublisherCreate.body?.data?.id as string | undefined;
  const guestOwnCampaignCreate = await request("/api/v1/guest-posting/campaigns", {
    token: tokenA,
    body: { businessId: A.businessId, name: "Security Campaign A" },
  });
  const guestCampaignId = guestOwnCampaignCreate.body?.data?.id as string | undefined;
  const guestCrossCampaignCreate = await request("/api/v1/guest-posting/campaigns", {
    token: tokenA,
    body: { businessId: B.businessId, name: "Cross-tenant campaign must not exist" },
  });
  const guestCrossBlogSubmission = await request("/api/v1/guest-posting/submissions", {
    token: tokenA,
    body: {
      campaignId: guestCampaignId,
      publisherId: guestPublisherId,
      blogId: B.blogId,
      title: "Cross-tenant blog submission must not exist",
    },
  });
  const [crossCampaignWrites, crossBlogSubmissionWrites] = await Promise.all([
    prisma.guestPostCampaign.count({
      where: { userId: A.userId, businessId: B.businessId },
    }),
    prisma.guestPostSubmission.count({
      where: { userId: A.userId, blogId: B.blogId },
    }),
  ]);
  expect(drOwn.status === 200, "Tenant A could not read its own DR dashboard");
  expect(drCross.status === 404, "Tenant A read tenant B DR dashboard");
  expect(drLegacyPathCross.status === 403, "Legacy DR path accepted a mismatched userId");
  expect(publishingLegacyPathCross.status === 403, "Legacy publishing path accepted a mismatched userId");
  expect(offPageLegacyPathCross.status === 403, "Legacy off-page path accepted a mismatched userId");
  expect(offPageCanonicalCross.status === 404, "Canonical off-page route exposed another tenant's business");
  expect(offPageCanonicalAnonymous.status === 401, "Canonical off-page route accepted an anonymous caller");
  expect(guestPostingCanonical.status === 200, "Canonical guest-posting route requires a client userId");
  expect(guestPostingQueryCross.status === 403, "Guest-posting accepted a mismatched query userId");
  expect(
    guestPublisherCreate.status === 200 && Boolean(guestPublisherId),
    "Canonical guest-posting publisher creation requires a client userId",
  );
  expect(
    guestOwnCampaignCreate.status === 200 && Boolean(guestCampaignId),
    "Canonical guest-posting campaign creation requires a client userId",
  );
  expect(
    guestCrossCampaignCreate.status >= 400 && crossCampaignWrites === 0,
    "Guest-posting created a campaign for another tenant's business",
  );
  expect(
    guestCrossBlogSubmission.status >= 400 && crossBlogSubmissionWrites === 0,
    "Guest-posting attached another tenant's blog to a submission",
  );

  const externalOwn = await request(`/api/v1/external-backlinks/summary?businessId=${A.businessId}`, {
    token: tokenA,
  });
  const externalCross = await request(`/api/v1/external-backlinks/summary?businessId=${B.businessId}`, {
    token: tokenA,
  });
  const externalLegacyPathCross = await request(
    `/api/v1/external-backlinks/${B.userId}/summary?businessId=${A.businessId}`,
    { token: tokenA },
  );
  const malformedFilters = await request(
    `/api/v1/external-backlinks/backlinks?businessId=${A.businessId}&filters=${encodeURIComponent("{not-json")}`,
    { token: tokenA },
  );
  const excessiveLimit = await request(
    `/api/v1/external-backlinks/referring-domains?businessId=${A.businessId}&limit=1000000`,
    { token: tokenA },
  );
  const crossSync = await request("/api/v1/external-backlinks/sync", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  expect(externalOwn.status === 200, "Tenant A could not read its own external-backlink summary");
  expect(externalCross.status === 404, "Tenant A read tenant B external-backlink summary");
  expect(externalLegacyPathCross.status === 403, "Legacy external-backlink path accepted a mismatched userId");
  expect(malformedFilters.status === 400, "External-backlink route accepted malformed filter JSON");
  expect(excessiveLimit.status === 400, "External-backlink route accepted an excessive list limit");
  expect(crossSync.status === 404, "External-backlink sync accepted another tenant business");
  pass("DR and external-backlink route isolation and input bounds");

  const onboardingEntry = await request("/api/v1/onboarding/entry-guard", { token: tokenA });
  const onboardingStatus = await request("/api/v1/onboarding/status", { token: tokenA });
  expect(onboardingEntry.status === 200, "Onboarding entry guard backend route failed");
  expect(onboardingStatus.status === 200, "Onboarding status backend route failed");
  expect(
    onboardingStatus.body?.data?.websites?.some(
      (website: { businessId?: string }) => website.businessId === A.businessId,
    ) && !JSON.stringify(onboardingStatus.body).includes(B.businessId),
    "Onboarding status crossed the tenant boundary",
  );
  pass("backend onboarding identity isolation");

  await prisma.user.updateMany({
    where: { id: { in: [A.userId, B.userId] } },
    data: {
      termsAcceptedAt: null,
      termsVersion: null,
      privacyAcceptedAt: null,
      privacyVersion: null,
      legalConsentIp: null,
      legalConsentUserAgent: null,
    },
  });
  const anonymousConsent = await request("/api/v1/legal/consent");
  expect(anonymousConsent.status === 401, "Anonymous legal-consent read was accepted");
  const initialConsent = await request("/api/v1/legal/consent", { token: tokenA });
  expect(
    initialConsent.status === 200 && initialConsent.body?.data?.requiresConsent === true,
    "Owned legal-consent state was not returned",
  );
  const injectedConsent = await request("/api/v1/legal/consent", {
    token: tokenA,
    headers: { "X-Forwarded-For": "203.0.113.99" },
    body: {
      userId: B.userId,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "2026-05-01",
      privacyVersion: "2026-05-01",
    },
  });
  expect(injectedConsent.status === 400, "Legal consent accepted client-supplied identity");
  const acceptedConsent = await request("/api/v1/legal/consent", {
    token: tokenA,
    headers: { "X-Forwarded-For": "203.0.113.99", "User-Agent": "local-security-audit" },
    body: {
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "2026-05-01",
      privacyVersion: "2026-05-01",
    },
  });
  expect(
    acceptedConsent.status === 200 && acceptedConsent.body?.data?.requiresConsent === false,
    "Legal consent could not be recorded for the authenticated user",
  );
  const consentUsers = await prisma.user.findMany({
    where: { id: { in: [A.userId, B.userId] } },
    select: { id: true, termsAcceptedAt: true, legalConsentIp: true },
  });
  const consentA = consentUsers.find((user) => user.id === A.userId);
  const consentB = consentUsers.find((user) => user.id === B.userId);
  expect(Boolean(consentA?.termsAcceptedAt), "Authenticated consent was not persisted");
  expect(!consentB?.termsAcceptedAt, "Legal consent changed another tenant's user record");
  expect(consentA?.legalConsentIp !== "203.0.113.99", "Untrusted forwarding header controlled consent IP evidence");
  pass("legal-consent backend ownership, strict input, and proxy-aware audit evidence");

  const anonymousGmbEditor = await request(
    `/api/v1/google-my-business/profile-editor/verification?businessId=${A.businessId}`,
  );
  expect(anonymousGmbEditor.status === 401, "Anonymous GMB profile-editor read was accepted");
  const ownGmbVerification = await request(
    `/api/v1/google-my-business/profile-editor/verification?businessId=${A.businessId}`,
    { token: tokenA },
  );
  const serializedVerification = JSON.stringify(ownGmbVerification.body);
  expect(
    ownGmbVerification.status === 200 &&
      ownGmbVerification.body?.data?.connected === true &&
      ownGmbVerification.body?.data?.verification?.verified === true,
    "Tenant A could not read its own GMB verification state",
  );
  expect(
    !serializedVerification.includes("local-access-token") &&
      !serializedVerification.includes("local-refresh-token") &&
      !serializedVerification.includes("provider-secret-diagnostic"),
    "GMB verification route leaked OAuth credentials or provider diagnostics",
  );
  const crossGmbReads = await Promise.all([
    request(
      `/api/v1/google-my-business/profile-editor/categories?businessId=${B.businessId}`,
      { token: tokenA },
    ),
    request(
      `/api/v1/google-my-business/profile-editor/hours?businessId=${B.businessId}`,
      { token: tokenA },
    ),
    request(
      `/api/v1/google-my-business/profile-editor/verification?businessId=${B.businessId}`,
      { token: tokenA },
    ),
  ]);
  expect(
    crossGmbReads.every((response) => response.status === 404),
    "GMB profile-editor read crossed the tenant boundary",
  );
  const invalidGmbBody = await request(
    "/api/v1/google-my-business/profile-editor/categories",
    {
      method: "PUT",
      token: tokenA,
      body: {
        businessId: A.businessId,
        primaryCategoryId: "gcid:restaurant",
        secondaryCategoryIds: [],
        userId: B.userId,
      },
    },
  );
  expect(invalidGmbBody.status === 400, "GMB profile editor accepted identity injection");
  const crossGmbWrite = await request(
    "/api/v1/google-my-business/profile-editor/categories",
    {
      method: "PUT",
      token: tokenA,
      body: {
        businessId: B.businessId,
        primaryCategoryId: "gcid:restaurant",
        secondaryCategoryIds: [],
      },
    },
  );
  expect(crossGmbWrite.status === 404, "GMB profile editor wrote another tenant's business");
  const categoryMutation = {
    businessId: A.businessId,
    primaryCategoryId: "gcid:restaurant",
    secondaryCategoryIds: ["gcid:cafe"],
  };
  const concurrentGmbWrites = await Promise.all([
    request("/api/v1/google-my-business/profile-editor/categories", {
      method: "PUT",
      token: tokenA,
      body: categoryMutation,
    }),
    request("/api/v1/google-my-business/profile-editor/categories", {
      method: "PUT",
      token: tokenA,
      body: categoryMutation,
    }),
  ]);
  expect(
    concurrentGmbWrites.every((response) => response.status === 200),
    "Owned GMB profile-editor mutation failed",
  );
  const pendingCategoryActions = await prisma.gMBActionRecommendation.count({
    where: {
      businessId: A.businessId,
      gmbId: A.gmbId,
      actionType: "category_update",
      status: "PENDING",
      source: "user_edit",
    },
  });
  expect(
    pendingCategoryActions === 1,
    "Concurrent GMB retries created duplicate pending actions",
  );
  pass("GMB profile-editor auth, tenant isolation, secret redaction, and idempotent writes");

  const updatedName = `Security Business A ${Date.now()}`;
  const updateOwn = await request("/api/v1/business/settings/basic", {
    token: tokenA,
    body: {
      businessId: A.businessId,
      businessName: updatedName,
      businessType: "Security Test",
      businessDescription: "Cache invalidation verification",
      businessWebsiteUrl: "https://security-a.local.test",
    },
  });
  expect(updateOwn.status === 200, "Owned business update failed");
  const afterInvalidation = await request("/api/v1/business/settings/info", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  expect(afterInvalidation.body?.data?.business?.businessName === updatedName, "Business cache served stale data after mutation");
  pass("event-driven tenant cache invalidation");

  const crossTenantSitemap = await request("/api/v1/business/get-sitemap-url", {
    token: tokenA,
    body: { businessId: B.businessId, websiteUrl: "https://security-b.local.test/sitemap.xml" },
  });
  expect(crossTenantSitemap.status === 404, "Sitemap route crossed the tenant boundary");
  const metadataSitemap = await request("/api/v1/business/get-sitemap-url", {
    token: tokenA,
    body: { businessId: A.businessId, websiteUrl: "http://169.254.169.254/latest/meta-data" },
  });
  expect(metadataSitemap.status === 400, "Sitemap route accepted a metadata-service URL");
  const metadataCustomApi = await request("/api/v1/publishing/connect", {
    token: tokenA,
    body: {
      businessId: A.businessId,
      platform: "CUSTOM_API",
      customApiUrl: "http://169.254.169.254/latest/meta-data",
    },
  });
  expect(metadataCustomApi.status === 400, "Custom publishing API accepted a metadata-service URL");
  const metadataLegacyWordPress = await request("/api/v1/wordpress/credentials", {
    token: tokenA,
    body: {
      websiteUrl: "http://169.254.169.254/latest/meta-data",
      username: "security-a",
      app_password: "not-a-real-password",
    },
  });
  expect(metadataLegacyWordPress.status === 400, "Legacy WordPress credentials accepted a metadata-service URL");
  const legacyWordPressRead = await request("/api/v1/wordpress/credentials", { token: tokenA });
  expect(
    legacyWordPressRead.status === 200 &&
      !JSON.stringify(legacyWordPressRead.body).includes("not-a-real-password"),
    "Legacy WordPress credential plaintext leaked from the read route",
  );
  pass("sitemap, custom API, and WordPress outbound SSRF rejection");

  const anonymousTokenList = await request("/api/v1/api-tokens/list", {
    body: { businessId: A.businessId },
  });
  expect(anonymousTokenList.status === 401, "Anonymous API-token list was accepted");
  const crossTokenList = await request("/api/v1/api-tokens/list", {
    token: tokenA,
    body: { businessId: B.businessId },
  });
  expect(crossTokenList.status === 404, "Tenant A listed tenant B API tokens");
  const createToken = await request("/api/v1/api-tokens/create", {
    token: tokenA,
    body: { businessId: A.businessId, name: "Local audit token", permissions: ["read:blogs", "read:keywords"] },
  });
  const plainApiToken = createToken.body?.data?.plainToken as string | undefined;
  const apiTokenId = createToken.body?.data?.token?.id as string | undefined;
  expect(createToken.status === 200 && plainApiToken && apiTokenId, "API token creation failed");
  expect(/^uai_v2_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(plainApiToken), "API token does not use the v2 random-secret format");
  const listTokens = await request("/api/v1/api-tokens/list", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  expect(listTokens.status === 200 && !JSON.stringify(listTokens.body).includes(plainApiToken), "API token plaintext leaked from list");
  const publicHeaderRead = await request("/api/public/v1/blogs", { token: plainApiToken });
  expect(publicHeaderRead.status === 200, `Header API token failed with ${publicHeaderRead.status}`);
  const publicPathRead = await request(`/api/public/v1/blogs/${encodeURIComponent(plainApiToken)}`);
  expect(publicPathRead.status === 401, "v2 API token was accepted in a URL path");
  const regenerate = await request("/api/v1/api-tokens/regenerate", {
    token: tokenA,
    body: { tokenId: apiTokenId },
  });
  const newPlainApiToken = regenerate.body?.data?.plainToken as string | undefined;
  expect(regenerate.status === 200 && newPlainApiToken, "API token regeneration failed");
  expect((await request("/api/public/v1/blogs", { token: plainApiToken })).status === 401, "Old API token remained active after rotation");
  expect((await request("/api/public/v1/blogs", { token: newPlainApiToken })).status === 200, "Rotated API token was not active");
  const apiForensicRows = await prisma.apiToken.findMany({
    where: { id: { in: [apiTokenId, regenerate.body?.data?.token?.id] } },
    select: {
      id: true,
      isActive: true,
      revokedAt: true,
      revocationReason: true,
      rotatedFromTokenId: true,
      connectedSiteUrlAtCreation: true,
    },
  });
  const oldApiForensic = apiForensicRows.find((row) => row.id === apiTokenId);
  const newApiForensic = apiForensicRows.find((row) => row.id !== apiTokenId);
  expect(
    oldApiForensic?.isActive === false &&
      oldApiForensic.revocationReason === "rotated" &&
      oldApiForensic.revokedAt instanceof Date &&
      newApiForensic?.rotatedFromTokenId === apiTokenId &&
      Boolean(newApiForensic.connectedSiteUrlAtCreation),
    "API token rotation did not preserve forensic lineage",
  );
  pass("API-token one-time disclosure, transport, ownership, and atomic rotation");

  const generateWp = await request("/api/v1/auth/wordpress/generate-key", {
    token: tokenA,
    body: { businessId: A.businessId },
  });
  const wpKey = generateWp.body?.data?.integrationKey as string | undefined;
  expect(generateWp.status === 200 && wpKey, `WordPress key generation failed: ${generateWp.status}`);
  expect(/^wp_key_v2_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(wpKey), "WordPress key format is not v2 ID+secret");
  const storedWp = await prisma.publishingIntegration.findFirst({
    where: { userId: A.userId, businessId: A.businessId, platform: "WORDPRESS" },
    select: { wordpressIntegrationKey: true, wordpressIntegrationKeyDigest: true },
  });
  expect(
    storedWp?.wordpressIntegrationKey?.startsWith("uai_secret_v2:wordpress-integration-key:") &&
      storedWp.wordpressIntegrationKey !== wpKey &&
      storedWp.wordpressIntegrationKeyDigest?.startsWith("hmac-sha256:wp:v2:"),
    "WordPress key was not encrypted plus HMAC-digested at rest",
  );
  const wrongWp = await request("/api/v1/auth/wordpress/validate-key", {
    body: { integrationKey: `${wpKey.slice(0, -1)}x`, wordpressSiteUrl: "https://security-a.local.test" },
  });
  const wrongSiteWp = await request("/api/v1/auth/wordpress/validate-key", {
    body: { integrationKey: wpKey, wordpressSiteUrl: "https://attacker.local.test" },
  });
  const validWp = await request("/api/v1/auth/wordpress/validate-key", {
    body: { integrationKey: wpKey, wordpressSiteUrl: "https://security-a.local.test" },
  });
  expect(validWp.status === 200, `Valid WordPress key failed: ${validWp.status}`);
  expect(wrongWp.status === 401 && wrongSiteWp.status === 401, "WordPress invalid key/site binding was accepted");
  expect(wrongWp.body?.message === wrongSiteWp.body?.message, "WordPress auth errors reveal failure reason");
  const noWebhookCredential = await request("/api/v1/auth/wordpress/webhook", {
    body: { event: "post.updated", data: { post_id: "missing" } },
  });
  expect(noWebhookCredential.status === 401, "WordPress webhook accepted missing credential");
  const wrongSiteWebhook = await request("/api/v1/auth/wordpress/webhook", {
    token: wpKey,
    headers: { "X-WordPress-Site": "https://attacker.local.test" },
    body: { event: "post.updated", data: { post_id: "missing" } },
  });
  expect(wrongSiteWebhook.status === 401, "WordPress webhook accepted a different site");
  const malformedWebhook = await request("/api/v1/auth/wordpress/webhook", {
    token: wpKey,
    headers: { "X-WordPress-Site": "https://security-a.local.test" },
    body: { event: "attacker.event", data: { post_id: "missing" }, extra: true },
  });
  expect(malformedWebhook.status === 400, "WordPress webhook accepted an unknown event or extra field");
  const revokeWp = await request("/api/v1/auth/wordpress/revoke-key", {
    method: "DELETE",
    token: tokenA,
    body: { businessId: A.businessId },
  });
  expect(revokeWp.status === 200, "WordPress key revocation failed");
  expect(
    (await request("/api/v1/auth/wordpress/validate-key", {
      body: { integrationKey: wpKey, wordpressSiteUrl: "https://security-a.local.test" },
    })).status === 401,
    "Revoked WordPress key remained active",
  );
  const revokedWp = await prisma.publishingIntegration.findFirst({
    where: { userId: A.userId, businessId: A.businessId, platform: "WORDPRESS" },
    select: {
      isActive: true,
      wordpressIntegrationKey: true,
      wordpressIntegrationKeyDigest: true,
      wordpressIntegrationKeyFirstCreatedAt: true,
      wordpressIntegrationKeyCreatedAt: true,
      wordpressIntegrationKeyLastUsedAt: true,
      wordpressIntegrationKeyRevokedAt: true,
      wordpressIntegrationKeyRotationCount: true,
    },
  });
  expect(
    revokedWp?.isActive === false &&
      revokedWp.wordpressIntegrationKey === null &&
      Boolean(revokedWp.wordpressIntegrationKeyDigest) &&
      revokedWp.wordpressIntegrationKeyFirstCreatedAt instanceof Date &&
      revokedWp.wordpressIntegrationKeyCreatedAt instanceof Date &&
      revokedWp.wordpressIntegrationKeyLastUsedAt instanceof Date &&
      revokedWp.wordpressIntegrationKeyRevokedAt instanceof Date &&
      revokedWp.wordpressIntegrationKeyRotationCount >= 1,
    "WordPress revocation erased forensic timestamps or retained decryptable key material",
  );
  pass("WordPress encrypted storage, HMAC verification, site binding, webhook auth, and revocation");

  let rateLimited = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await request("/api/v1/auth/wordpress/validate-key", {
      body: { integrationKey: `wp_key_invalid_${attempt}`, wordpressSiteUrl: "https://security-a.local.test" },
    });
    if (result.status === 429) {
      expect(Boolean(result.headers.get("retry-after")), "429 response omitted Retry-After");
      rateLimited = true;
      break;
    }
  }
  expect(rateLimited, "WordPress credential brute-force protection did not activate");
  pass("Redis-backed credential brute-force rate limit");

  console.log(JSON.stringify({ success: true, passed: passed.length, checks: passed }, null, 2));
}

main()
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
