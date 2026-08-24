import { serve } from "inngest/express";
import { functions, inngest } from "./client";

export const inngestHandler = serve({
  client: inngest,
  functions: functions,
});
