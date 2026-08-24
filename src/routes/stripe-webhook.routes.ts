import { Router } from "express";

import { handleStripeWebhook } from "../controllers/stripe-webhook.controller";

const StripeWebhookRouter = Router();
StripeWebhookRouter.post("/", handleStripeWebhook);

export default StripeWebhookRouter;
