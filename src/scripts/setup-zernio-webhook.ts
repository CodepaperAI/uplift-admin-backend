import { ZernioClient } from "../services/zernio/zernio.client";

const WEBHOOK_NAME = "Uplift AI Social Publishing";
const WEBHOOK_EVENTS = [
  "post.scheduled",
  "post.published",
  "post.failed",
  "post.partial",
  "account.connected",
  "account.disconnected",
];

function webhookUrl(): string {
  const explicit = process.env.ZERNIO_WEBHOOK_PUBLIC_URL?.trim();
  const backendUrl = process.env.BACKEND_URL?.trim();
  const candidate = explicit || (backendUrl
    ? new URL("/api/v1/social-publishing/webhooks/zernio", backendUrl).toString()
    : "");
  if (!candidate) {
    throw new Error(
      "Set ZERNIO_WEBHOOK_PUBLIC_URL or BACKEND_URL before configuring the webhook",
    );
  }
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("The Zernio webhook must use a publicly reachable HTTPS URL");
  }
  return parsed.toString();
}

async function main() {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("ZERNIO_WEBHOOK_SECRET must contain at least 32 characters");
  }
  const url = webhookUrl();
  const client = new ZernioClient();
  const configured = await client.listWebhookSettings();
  const existing = configured.find(
    (webhook) => webhook.url === url || webhook.name === WEBHOOK_NAME,
  );
  const webhook = existing
    ? await client.updateWebhookSetting({
        id: existing._id,
        name: WEBHOOK_NAME,
        url,
        secret,
        events: WEBHOOK_EVENTS,
      })
    : await client.createWebhookSetting({
        name: WEBHOOK_NAME,
        url,
        secret,
        events: WEBHOOK_EVENTS,
      });

  console.log(
    JSON.stringify(
      {
        configured: true,
        action: existing ? "updated" : "created",
        webhookId: webhook._id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.isActive,
      },
      null,
      2,
    ),
  );
}

await main();
