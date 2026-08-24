import { generateEncryptionKey } from "../utils/encryption";

/**
 * Script to generate a secure encryption key for WordPress credentials
 * Run this script to generate a new encryption key for your environment
 */
function generateKey() {
  console.log("🔑 Generating secure encryption key...");

  const key = generateEncryptionKey();

  console.log("\n📋 Your encryption key:");
  console.log("=".repeat(80));
  console.log(key);
  console.log("=".repeat(80));

  console.log("\n📝 Add this to your .env file:");
  console.log(`ENCRYPTION_KEY=${key}`);

  console.log("\n⚠️  IMPORTANT SECURITY NOTES:");
  console.log("1. Keep this key secure and never commit it to version control");
  console.log(
    "2. Store it in your environment variables or secure key management system"
  );
  console.log(
    "3. If you lose this key, you will not be able to decrypt existing credentials"
  );
  console.log("4. Make sure to backup this key in a secure location");
  console.log(
    "5. Use the same key across all your environments (dev, staging, prod)"
  );

  console.log("\n🚀 Next steps:");
  console.log("1. Add the key to your .env file");
  console.log("2. Restart your application");
  console.log("3. Run the migration script to encrypt existing credentials");
  console.log("4. Test WordPress functionality to ensure everything works");
}

// Run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateKey();
}

export { generateKey };
