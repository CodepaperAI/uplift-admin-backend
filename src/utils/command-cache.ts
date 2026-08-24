import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "./tenant-response-cache";

const COMMAND_SCOPE = "platform-command-panel";

export async function readCommandCache<T>(namespace: string): Promise<T | null> {
  return readTenantCache<T>({ namespace, userId: COMMAND_SCOPE });
}

export async function writeCommandCache<T>(
  namespace: string,
  value: T,
  ttlSeconds = 120,
): Promise<void> {
  await writeTenantCache({ namespace, userId: COMMAND_SCOPE, value, ttlSeconds });
}

export async function invalidateCommandCache(): Promise<void> {
  await invalidateTenantCache(COMMAND_SCOPE);
}
