import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  GMB_TOKEN_ENCRYPTION_CONTEXT,
} from "../services/google-my-business.service";
import { decrypt, encrypt, isEncrypted } from "../utils/encryption";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
const originalConsoleError = console.error;

describe("GMB token encryption", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
    console.error = originalConsoleError;
  });

  it("encrypts and decrypts GMB tokens with the dedicated context", () => {
    const encrypted = encrypt("gmb-access-token", GMB_TOKEN_ENCRYPTION_CONTEXT);

    expect(isEncrypted(encrypted)).toBe(true);
    expect(decrypt(encrypted, GMB_TOKEN_ENCRYPTION_CONTEXT)).toBe(
      "gmb-access-token"
    );
  });

  it("does not decrypt GMB tokens with the default WordPress context", () => {
    const encrypted = encrypt("gmb-refresh-token", GMB_TOKEN_ENCRYPTION_CONTEXT);
    console.error = () => {};

    expect(() => decrypt(encrypted)).toThrow();
  });
});
