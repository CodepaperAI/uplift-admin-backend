import { prisma } from "../config/db.config";
import { encrypt, isEncrypted } from "../utils/encryption";

async function migrateWordPressCredentials() {
  console.log("🔄 Starting WordPress credentials migration...");

  try {
    const wordpressIntegrations = await prisma.wordPressintegration.findMany({
      select: {
        id: true,
        app_password: true,
        websiteUrl: true,
      },
    });

    console.log(
      `📊 Found ${wordpressIntegrations.length} WordPress integrations to check`
    );

    let encryptedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const integration of wordpressIntegrations) {
      try {
        if (isEncrypted(integration.app_password)) {
          console.log(
            `⏭️  Skipping ${integration.websiteUrl} - already encrypted`
          );
          skippedCount++;
          continue;
        }

        // Encrypt the password
        const encryptedPassword = encrypt(integration.app_password);

        // Update the database
        await prisma.wordPressintegration.update({
          where: { id: integration.id },
          data: { app_password: encryptedPassword },
        });

        console.log(`✅ Encrypted credentials for ${integration.websiteUrl}`);
        encryptedCount++;
      } catch (error) {
        console.error(
          `❌ Error encrypting credentials for ${integration.websiteUrl}:`,
          error
        );
        errorCount++;
      }
    }

    console.log("\n📈 Migration Summary:");
    console.log(`✅ Successfully encrypted: ${encryptedCount}`);
    console.log(`⏭️  Already encrypted (skipped): ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📊 Total processed: ${wordpressIntegrations.length}`);

    if (errorCount > 0) {
      console.log(
        "\n⚠️  Some credentials failed to encrypt. Please check the errors above."
      );
      process.exit(1);
    } else {
      console.log("\n🎉 Migration completed successfully!");
    }
  } catch (error) {
    console.error("💥 Migration failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrateWordPressCredentials();
}

export { migrateWordPressCredentials };
