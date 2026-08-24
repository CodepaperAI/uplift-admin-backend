import { decrypt, encrypt } from "./encryption";

export const SHOPIFY_OAUTH_STATE_COOKIE = "shopify_oauth_state";
export const SHOPIFY_OAUTH_CONTEXT_COOKIE = "shopify_oauth_context";
const SHOPIFY_OAUTH_CONTEXT_ENCRYPTION_CONTEXT = "shopify-oauth-context";

export interface ShopifyOAuthSessionContext {
  state: string;
  shop: string;
  businessId?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  apiVersion?: string | null;
  apiMethod?: "REST" | "GRAPHQL" | null;
  blogId?: string | null;
  autoPublish?: boolean | null;
  publishAs?: "DRAFT" | "PUBLISH" | null;
}

export interface ShopifyOAuthCredentialResolutionInput {
  state: string;
  shop: string;
  tempContext?: ShopifyOAuthSessionContext | null;
  envClientId?: string | null;
  envClientSecret?: string | null;
}

export interface ShopifyOAuthCredentialResolution {
  clientId: string;
  clientSecret: string;
  source: "TEMP" | "ENV";
}

export function normalizeShopifyDomain(shop: string): string {
  const stripped = shop.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (!stripped.includes(".")) {
    return `${stripped}.myshopify.com`.toLowerCase();
  }

  return stripped.toLowerCase();
}

export function serializeShopifyOAuthContext(
  context: ShopifyOAuthSessionContext,
): string {
  return encrypt(
    JSON.stringify(context),
    SHOPIFY_OAUTH_CONTEXT_ENCRYPTION_CONTEXT,
  );
}

export function parseShopifyOAuthContext(
  encryptedValue?: string | null,
): ShopifyOAuthSessionContext | null {
  if (!encryptedValue) {
    return null;
  }

  try {
    const decrypted = decrypt(
      encryptedValue,
      SHOPIFY_OAUTH_CONTEXT_ENCRYPTION_CONTEXT,
    );
    const parsed = JSON.parse(decrypted) as ShopifyOAuthSessionContext;

    if (!parsed?.state || !parsed?.shop) {
      return null;
    }

    return {
      ...parsed,
      shop: normalizeShopifyDomain(parsed.shop),
    };
  } catch (error) {
    console.warn("[Shopify OAuth] Failed to parse temp OAuth context:", error);
    return null;
  }
}

export function resolveShopifyOAuthCredentials({
  state,
  shop,
  tempContext,
  envClientId,
  envClientSecret,
}: ShopifyOAuthCredentialResolutionInput): ShopifyOAuthCredentialResolution | null {
  const normalizedShop = normalizeShopifyDomain(shop);

  if (
    tempContext &&
    tempContext.state === state &&
    normalizeShopifyDomain(tempContext.shop) === normalizedShop &&
    tempContext.clientId &&
    tempContext.clientSecret
  ) {
    return {
      clientId: tempContext.clientId,
      clientSecret: tempContext.clientSecret,
      source: "TEMP",
    };
  }

  if (envClientId && envClientSecret) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      source: "ENV",
    };
  }

  return null;
}
