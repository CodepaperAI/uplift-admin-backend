import { decrypt, encrypt, isEncrypted } from "./encryption";

export type PublishingSecretKind =
  | "wordpress-password"
  | "wordpress-integration-key"
  | "shopify-access-token"
  | "shopify-client-id"
  | "shopify-client-secret"
  | "webflow-site-token"
  | "framer-api-key"
  | "custom-api-key"
  | "custom-api-secret";

const PREFIX = "uai_secret_v2";

function context(kind: PublishingSecretKind): string {
  return `publishing-secret:${kind}:v2`;
}

export function encryptPublishingSecret(
  value: string,
  kind: PublishingSecretKind,
): string {
  return `${PREFIX}:${kind}:${encrypt(value, context(kind))}`;
}

export function decryptPublishingSecret(
  storedValue: string,
  kind: PublishingSecretKind,
): string {
  const expectedPrefix = `${PREFIX}:${kind}:`;
  if (storedValue.startsWith(expectedPrefix)) {
    return decrypt(storedValue.slice(expectedPrefix.length), context(kind));
  }
  if (storedValue.startsWith(`${PREFIX}:`)) {
    throw new Error("Publishing credential context mismatch");
  }
  return isEncrypted(storedValue) ? decrypt(storedValue) : storedValue;
}
