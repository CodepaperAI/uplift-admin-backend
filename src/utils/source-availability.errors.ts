export type SourceAvailabilityCode =
  | "DATAFORSEO_BACKLINKS_UNAVAILABLE"
  | "REDDIT_FORBIDDEN"
  | "REDDIT_RATE_LIMITED";

export type SourceName = "dataforseo-backlinks" | "reddit";

type SourceAvailabilityErrorOptions = {
  source: SourceName;
  code: SourceAvailabilityCode;
  message: string;
  userMessage: string;
  retryable: boolean;
  statusCode?: number;
};

export class SourceAvailabilityError extends Error {
  readonly source: SourceName;
  readonly code: SourceAvailabilityCode;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(options: SourceAvailabilityErrorOptions) {
    super(options.message);
    this.name = "SourceAvailabilityError";
    this.source = options.source;
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

export function isSourceAvailabilityError(
  error: unknown
): error is SourceAvailabilityError {
  return error instanceof SourceAvailabilityError;
}
