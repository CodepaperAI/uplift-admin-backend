import { Inngest, type ClientOptions } from "inngest";

const signingKey = process.env.INNGEST_SIGNING_KEY?.trim();
const options: ClientOptions = {
  id: "seo-admin-api",
  isDev:
    process.env.NODE_ENV === "development" || process.env.INNGEST_DEV === "true",
  ...(signingKey ? { signingKey } : {}),
};

// This client only emits events to the existing production Inngest service.
// The admin API never registers or serves worker functions.
export const inngest = new Inngest(options);
