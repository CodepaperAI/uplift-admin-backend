export type CommandPagination = {
  page: number;
  pageSize: number;
  skip: number;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(typeof value === "string" ? value : "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A ceiling on `page`, because `skip` becomes a SQL OFFSET.
 *
 * `pageSize` was always clamped; `page` was not, so `?page=999999999` produced
 * an offset of a quarter of a trillion. PostgreSQL answers that by walking and
 * discarding every row up to the offset, and at a large enough page the
 * multiplication leaves the safe-integer range and stops being an integer at
 * all. Ten thousand pages is far past any real roster and keeps the offset
 * bounded no matter what arrives in the query string.
 */
const MAX_PAGE = 10_000;

export function parseCommandPagination(input: {
  page?: unknown;
  pageSize?: unknown;
  defaultPageSize?: number;
  maxPageSize?: number;
}): CommandPagination {
  const maxPageSize = Math.max(1, input.maxPageSize ?? 100);
  const defaultPageSize = Math.min(
    maxPageSize,
    Math.max(1, input.defaultPageSize ?? 50),
  );
  const page = Math.min(MAX_PAGE, positiveInteger(input.page) ?? 1);
  const pageSize = Math.min(
    maxPageSize,
    positiveInteger(input.pageSize) ?? defaultPageSize,
  );
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function commandPaginationResult(input: {
  page: number;
  pageSize: number;
  total: number;
}) {
  return {
    ...input,
    totalPages: Math.max(1, Math.ceil(input.total / input.pageSize)),
  };
}
