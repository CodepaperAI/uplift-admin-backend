import { decrypt, encrypt } from "./encryption";

export type StoredOAuthProvider =
  | "medium"
  | "reddit"
  | "shopify"
  | "webflow"
  | "wix";

const PREFIX = "uai_oauth_v2";

function context(provider: StoredOAuthProvider): string {
  return `oauth-token:${provider}:v2`;
}

/**
 * Encrypt provider credentials with an authenticated, provider-specific AAD.
 * The prefix makes the encryption context explicit without exposing the token.
 */
export function encryptOAuthToken(
  value: string,
  provider: StoredOAuthProvider,
): string {
  return `${PREFIX}:${provider}:${encrypt(value, context(provider))}`;
}

/**
 * Read v2 credentials using their provider-bound context. Unprefixed values are
 * legacy ciphertext written with the historical default context and remain
 * readable during rotation. A v2 token for another provider always fails.
 */
export function decryptOAuthToken(
  storedValue: string,
  provider: StoredOAuthProvider,
): string {
  const expectedPrefix = `${PREFIX}:${provider}:`;
  if (storedValue.startsWith(expectedPrefix)) {
    return decrypt(storedValue.slice(expectedPrefix.length), context(provider));
  }
  if (storedValue.startsWith(`${PREFIX}:`)) {
    throw new Error("OAuth credential context mismatch");
  }
  return decrypt(storedValue);
}

export function isProviderBoundOAuthToken(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}
