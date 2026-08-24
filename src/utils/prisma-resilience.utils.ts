import { Prisma } from "@prisma/client";

const TRANSIENT_PRISMA_ERROR_CODES = new Set(["P1001", "P1017", "P2024"]);
const TRANSIENT_CONNECTION_PATTERNS = [
  "error in postgresql connection",
  "kind: closed",
  "closed the connection",
  "connection terminated unexpectedly",
  "server closed the connection unexpectedly",
  "socket connection was closed unexpectedly",
  "can't reach database server",
  "timed out fetching a new connection from the pool",
  "connection error",
];

type RetryInfo = {
  attempt: number;
  nextAttempt: number;
  error: unknown;
};

export type PrismaRetryOptions = {
  operationName: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  onRetry?: (info: RetryInfo) => void | Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCause(error: unknown): unknown {
  if (error instanceof Error) {
    return error.cause;
  }

  if (
    error &&
    typeof error === "object" &&
    "cause" in error &&
    (error as { cause?: unknown }).cause !== undefined
  ) {
    return (error as { cause: unknown }).cause;
  }

  return undefined;
}

export function getPrismaErrorMessage(error: unknown): string {
  const segments: string[] = [];

  function collect(value: unknown): void {
    if (!value) {
      return;
    }

    if (value instanceof Error) {
      if (value.message) {
        segments.push(value.message);
      }
      collect(value.cause);
      return;
    }

    if (typeof value === "string") {
      segments.push(value);
      return;
    }

    if (typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string") {
        segments.push(message);
      }
      collect((value as { cause?: unknown }).cause);
      return;
    }

    segments.push(String(value));
  }

  collect(error);
  return segments.join(" | ");
}

export function getPrismaErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code;
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  const cause = getCause(error);
  if (cause && cause !== error) {
    return getPrismaErrorCode(cause);
  }

  return null;
}

export function isTransientPrismaConnectionError(error: unknown): boolean {
  const code = getPrismaErrorCode(error);
  if (code && TRANSIENT_PRISMA_ERROR_CODES.has(code)) {
    return true;
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return true;
  }

  const message = getPrismaErrorMessage(error).toLowerCase();
  if (
    TRANSIENT_CONNECTION_PATTERNS.some((pattern) => message.includes(pattern))
  ) {
    return true;
  }

  const cause = getCause(error);
  if (cause && cause !== error) {
    return isTransientPrismaConnectionError(cause);
  }

  return false;
}

export async function runWithTransientPrismaRetry<T>(
  runAttempt: (attempt: number) => Promise<T>,
  options: PrismaRetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 250;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runAttempt(attempt);
    } catch (error) {
      const shouldRetry =
        attempt < maxAttempts && isTransientPrismaConnectionError(error);

      if (!shouldRetry) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      await options.onRetry?.({
        attempt,
        nextAttempt,
        error,
      });

      if (retryDelayMs > 0) {
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  throw new Error(
    `Unexpected retry loop exit for Prisma operation ${options.operationName}.`,
  );
}
