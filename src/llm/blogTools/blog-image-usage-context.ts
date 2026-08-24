import { AsyncLocalStorage } from "node:async_hooks";

export type BlogImageUsageContext = {
  userId?: string | null;
  businessId?: string | null;
  blogId?: string | null;
  correlationId?: string | null;
  /** Dry-run: skip real image generation, return placeholders (comparison harness). */
  dryRun?: boolean;
};

const blogImageUsageStorage = new AsyncLocalStorage<BlogImageUsageContext>();

export function runWithBlogImageUsageContext<T>(
  context: BlogImageUsageContext,
  callback: () => Promise<T>,
): Promise<T> {
  return blogImageUsageStorage.run(context, callback);
}

export function getBlogImageUsageContext(): BlogImageUsageContext | undefined {
  return blogImageUsageStorage.getStore();
}
