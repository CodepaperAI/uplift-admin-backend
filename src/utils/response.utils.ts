import type { Response } from "express";
import { ZodError } from "zod";

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  error?: any;
  timestamp: string;
}

export const sendSuccess = <T>(
  res: Response,
  data: T,
  message: string = "Success",
  statusCode: number = 200
) => {
  const response: ApiResponse<T> = {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(response);
};

export const sendError = (
  res: Response,
  message: string,
  statusCode: number = 400,
  error?: any
) => {
  const publicMessage =
    statusCode >= 500 ? "Request could not be completed" : message;
  // Never reflect arbitrary provider, database, or runtime errors to callers.
  // Validation details are built locally from Zod issues and contain neither
  // submitted values nor stack/provider diagnostics.
  const safeValidationError =
    error?.code === "VALIDATION_ERROR"
      ? {
          code: "VALIDATION_ERROR",
          message: publicMessage,
          details: error.details,
        }
      : undefined;
  const response: ApiResponse = {
    success: false,
    message: publicMessage,
    error: safeValidationError,
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(response);
};

export type ValidationIssueDetail = {
  field: string;
  message: string;
  code: string;
};

function validationFieldPath(path: PropertyKey[]): string {
  if (path.length === 0) return "request";

  return path.reduce<string>((result, part) => {
    if (typeof part === "number") return `${result}[${part}]`;
    const segment = String(part);
    return result ? `${result}.${segment}` : segment;
  }, "");
}

function safeValidationMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 240) || "Invalid value";
}

/**
 * Converts Zod's nested issue paths into a stable, input-free API shape.
 * Unknown keys are expanded individually so clients can point to the exact
 * unsupported field without receiving the submitted value or schema internals.
 */
export function formatValidationIssues(
  error: ZodError,
): ValidationIssueDetail[] {
  return error.issues.flatMap<ValidationIssueDetail>((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        field: validationFieldPath([...issue.path, key]),
        message: "Field is not accepted",
        code: issue.code,
      }));
    }

    return [{
      field: validationFieldPath(issue.path),
      message: safeValidationMessage(issue.message),
      code: issue.code,
    }];
  });
}

export const handleValidationError = (res: Response, error: ZodError) => {
  const issues = formatValidationIssues(error);
  const firstIssue = issues[0];
  const message = firstIssue
    ? `${firstIssue.field}: ${firstIssue.message}`
    : "Request validation failed";
  const flattened = error.flatten();

  return sendError(res, message, 400, {
    code: "VALIDATION_ERROR",
    message,
    details: {
      ...flattened,
      issues,
    },
  });
};

// Backward compatibility helper - maintains existing response structure
export const sendLegacySuccess = <T>(
  res: Response,
  data: T,
  message: string = "Success",
  statusCode: number = 200
) => {
  // Keep existing format but add success field for backward compatibility
  const response = {
    success: true,
    message,
    ...data,
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(response);
};
