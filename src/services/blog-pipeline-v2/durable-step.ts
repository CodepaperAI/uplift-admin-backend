export type ProductionDurableStepRunner = <T>(
  id: string,
  handler: () => Promise<T>,
) => Promise<T>;

/**
 * Keep the production pipeline usable from both Inngest and local canary
 * scripts. Inngest supplies a durable runner; local callers execute the same
 * handler directly with identical prompts, models, and provider idempotency
 * keys.
 */
export function runProductionDurableStep<T>(
  runner: ProductionDurableStepRunner | undefined,
  id: string,
  handler: () => Promise<T>,
): Promise<T> {
  return runner ? runner(id, handler) : handler();
}
