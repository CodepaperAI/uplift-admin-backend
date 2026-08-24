import { z } from "zod";

const allowedTriggers = [
  "my_recordings",
  "shared_external_recordings",
  "my_shared_with_team_recordings",
  "shared_team_recordings",
] as const;

const responseSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  secret: z.string().startsWith("whsec_"),
  created_at: z.string(),
  include_transcript: z.boolean(),
  include_crm_matches: z.boolean(),
  include_summary: z.boolean(),
  include_action_items: z.boolean(),
  triggered_for: z.array(z.string()),
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function destinationUrl(): string {
  const explicit = process.env.FATHOM_WEBHOOK_URL?.trim();
  const raw = explicit
    ? explicit
    : `${required("BACKEND_URL").replace(/\/$/, "")}/api/v1/command/webhooks/fathom`;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error("Fathom webhook destination must use public HTTPS");
  }
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1"
  ) {
    throw new Error("Fathom cannot deliver to a loopback webhook destination");
  }
  if (parsed.pathname !== "/api/v1/command/webhooks/fathom") {
    throw new Error(
      "Fathom webhook destination must end at /api/v1/command/webhooks/fathom",
    );
  }
  return parsed.toString();
}

function triggers(): Array<(typeof allowedTriggers)[number]> {
  const raw =
    process.env.FATHOM_WEBHOOK_TRIGGERED_FOR?.trim() || "my_recordings";
  const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (!values.length) throw new Error("At least one Fathom recording trigger is required");
  for (const value of values) {
    if (!(allowedTriggers as readonly string[]).includes(value)) {
      throw new Error(`Unsupported Fathom recording trigger: ${value}`);
    }
  }
  return values as Array<(typeof allowedTriggers)[number]>;
}

if (process.env.FATHOM_WEBHOOK_CREATE_CONFIRMED !== "true") {
  throw new Error(
    "Set FATHOM_WEBHOOK_CREATE_CONFIRMED=true to create the external webhook",
  );
}

const apiKey = required("FATHOM_API_KEY");
const response = await fetch("https://api.fathom.ai/external/v1/webhooks", {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
  },
  body: JSON.stringify({
    destination_url: destinationUrl(),
    triggered_for: triggers(),
    include_action_items: true,
    include_crm_matches: false,
    include_summary: true,
    // Reviews fetch the transcript ephemerally after the signed event. Keeping
    // it out of the webhook minimizes sensitive data in ingress/logging layers.
    include_transcript: false,
  }),
  signal: AbortSignal.timeout(20_000),
});

if (!response.ok) {
  throw new Error(`Fathom webhook creation failed (${response.status})`);
}

const created = responseSchema.parse(await response.json());
console.log(
  JSON.stringify(
    {
      success: true,
      webhookId: created.id,
      destinationUrl: created.url,
      triggeredFor: created.triggered_for,
      fathomWebhookSecret: created.secret,
      nextStep:
        "Store fathomWebhookSecret as FATHOM_WEBHOOK_SECRET, restart seo-be, then record a two-minute test meeting.",
    },
    null,
    2,
  ),
);
