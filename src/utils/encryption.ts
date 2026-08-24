import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const DEFAULT_CONTEXT = "wordpress-credentials";

function getEncryptionKey() {
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  if (encryptionKey.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be 64 characters long (32 bytes in hex)"
    );
  }

  return Buffer.from(encryptionKey, "hex");
}

function getContextBuffer(context?: string) {
  return Buffer.from(context || DEFAULT_CONTEXT, "utf8");
}

export function encrypt(text: string, context?: string): string {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);

    cipher.setAAD(getContextBuffer(context));

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  } catch (error) {
    console.error("Encryption error:", error);
    throw new Error("Failed to encrypt data");
  }
}

export function decrypt(encryptedText: string, context?: string): string {
  try {
    const parts = encryptedText.split(":");

    if (parts.length !== 3) {
      throw new Error("Invalid encrypted data format");
    }

    const [ivHex, authTagHex, encrypted] = parts;
    if (!ivHex || !authTagHex || !encrypted) {
      throw new Error("Invalid encrypted data format");
    }

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getEncryptionKey(),
      Buffer.from(ivHex, "hex")
    );

    decipher.setAAD(getContextBuffer(context));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Decryption error:", error);
    throw new Error("Failed to decrypt data");
  }
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function isEncrypted(text: string): boolean {
  const parts = text.split(":");
  return (
    parts.length === 3 &&
    parts[0]?.length === 32 &&
    parts[1]?.length === 32 &&
    (parts[2]?.length ?? 0) > 0
  );
}
