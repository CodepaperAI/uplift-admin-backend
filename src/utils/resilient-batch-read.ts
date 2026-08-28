/**
 * A batched read that survives one unreadable row.
 *
 * Prisma deserialises a whole result set before returning it, so a single row it
 * cannot map — an enum value the schema does not list, a NULL in a column the
 * schema declares required — throws for the entire query. One such row in the
 * `user` table took out `metrics/users` completely: the Customer Analysis
 * onboarding chart rendered `0 of 0` for all 2,480 accounts because of one
 * signup, and the only clue was a sanitised 500.
 *
 * This repository cannot fix that at the source. The Prisma schema is a
 * hash-pinned mirror of the canonical seo-be schema, so relaxing a column here
 * would be asserting something false about the real database, and `check:surface`
 * refuses the change anyway.
 *
 * So instead of guessing which column drifted, the read degrades: the fast path
 * is one query and is untouched, and only on failure does it bisect the id list
 * to find the rows that cannot be read. Everything readable is returned, and the
 * ids that failed are returned with it — which is what turns "the page is empty"
 * into "this row is broken, here is its id".
 *
 * The bisection is bounded: each level halves the range, so isolating k bad rows
 * out of n costs O(k log n) queries and only ever runs when something is already
 * wrong.
 */

export type ResilientBatchResult<T> = {
  rows: T[];
  /** Ids inside a chunk that could not be read, individually confirmed. */
  failedIds: string[];
  /** True when the single fast-path query succeeded, which is the normal case. */
  cleanRead: boolean;
};

/**
 * `read` must accept any subset of `ids` and resolve to the rows for that
 * subset. It is called once with everything, then with progressively smaller
 * slices only if that throws.
 */
export async function resilientBatchRead<T>(input: {
  ids: readonly string[];
  read: (ids: string[]) => Promise<T[]>;
  /** Below this size a failing chunk is probed one id at a time. */
  minChunkSize?: number;
  onRowFailure?: (id: string, error: unknown) => void;
}): Promise<ResilientBatchResult<T>> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) {
    return { rows: [], failedIds: [], cleanRead: true };
  }

  try {
    return { rows: await input.read(ids), failedIds: [], cleanRead: true };
  } catch {
    // Fall through to the bisection below. The original error is reported per
    // row by `onRowFailure`, where it can be attributed to an id.
  }

  const minChunkSize = Math.max(1, input.minChunkSize ?? 8);
  const rows: T[] = [];
  const failedIds: string[] = [];

  const attempt = async (slice: string[]): Promise<void> => {
    if (slice.length === 0) return;
    try {
      rows.push(...(await input.read(slice)));
      return;
    } catch (error) {
      if (slice.length === 1) {
        const id = slice[0]!;
        failedIds.push(id);
        input.onRowFailure?.(id, error);
        return;
      }
      if (slice.length <= minChunkSize) {
        // Small enough that probing each id costs less than more halving.
        for (const id of slice) await attempt([id]);
        return;
      }
      const middle = Math.floor(slice.length / 2);
      await attempt(slice.slice(0, middle));
      await attempt(slice.slice(middle));
    }
  };

  await attempt(ids);
  return { rows, failedIds, cleanRead: false };
}
