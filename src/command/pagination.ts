export type CommandPagination = {
  page: number;
  pageSize: number;
  skip: number;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(typeof value === "string" ? value : "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

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
  const page = positiveInteger(input.page) ?? 1;
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
