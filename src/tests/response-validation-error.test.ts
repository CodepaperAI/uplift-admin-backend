import { describe, expect, test } from "bun:test";
import type { Response } from "express";

import { handleValidationError } from "../utils/response.utils";
import {
  CONFIRM_SECONDARY_DETAILS,
  PATCH_ONBOARDING_V2_STATE,
} from "../validators/quick-scrape.validation";

const businessId = "26338194-2831-4525-b616-99bf6402d9da";

function mockResponse() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => body };
}

function validationResponse(input: unknown) {
  const result = PATCH_ONBOARDING_V2_STATE.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected validation to fail");

  const response = mockResponse();
  handleValidationError(response.res, result.error);
  return response;
}

describe("structured validation errors", () => {
  test("identifies endpoint-owned author image fields without echoing values", () => {
    const privateUrl = "https://private.example.test/author.png?token=secret";
    const response = validationResponse({
      businessId,
      step: "author",
      author: {
        name: "Example Author",
        imageUrl: privateUrl,
        imageName: "author.png",
      },
    });

    expect(response.status()).toBe(400);
    expect(response.body().message).toBe(
      "author.imageUrl: Field is not accepted",
    );
    expect(response.body().error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "author.imageUrl: Field is not accepted",
      details: {
        issues: [
          {
            field: "author.imageUrl",
            message: "Field is not accepted",
            code: "unrecognized_keys",
          },
          {
            field: "author.imageName",
            message: "Field is not accepted",
            code: "unrecognized_keys",
          },
        ],
      },
    });
    expect(JSON.stringify(response.body())).not.toContain(privateUrl);
  });

  test("returns the precise nested field and safe reason for final autosave", () => {
    const response = validationResponse({
      businessId,
      step: "payment",
      status: "awaiting_payment",
      businessDetails: {
        businessPhone: "647-555-0123",
      },
      author: {
        bio: "x".repeat(2_001),
      },
    });

    expect(response.status()).toBe(400);
    expect(response.body().message).toBe(
      "businessDetails.businessPhone: Enter a valid phone number including country code",
    );
    expect(response.body().error.details.issues).toEqual([
      {
        field: "businessDetails.businessPhone",
        message: "Enter a valid phone number including country code",
        code: "custom",
      },
      {
        field: "author.bio",
        message: "Author bio must be 2000 characters or fewer",
        code: "too_big",
      },
    ]);
  });

  test("returns the precise direct businessPhone field for secondary confirmation", () => {
    const result = CONFIRM_SECONDARY_DETAILS.safeParse({
      businessAddress: "100 King Street West",
      businessCity: "Toronto",
      businessCountry: "Canada",
      businessName: "Example Inc.",
      businessPhone: "416-555-0123",
      businessState: "Ontario",
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected validation to fail");

    const response = mockResponse();
    handleValidationError(response.res, result.error);
    expect(response.status()).toBe(400);
    expect(response.body().message).toBe(
      "businessPhone: Enter a valid phone number including country code",
    );
    expect(response.body().error.details.issues).toEqual([
      {
        field: "businessPhone",
        message: "Enter a valid phone number including country code",
        code: "custom",
      },
    ]);
  });
});
