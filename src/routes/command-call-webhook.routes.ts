import { Router } from "express";
import {
  receiveFathomCommandWebhook,
  receiveFirefliesCommandWebhook,
} from "../controllers/command-call-webhook.controller";

const CommandCallWebhookRouter = Router();

CommandCallWebhookRouter.post("/fireflies", receiveFirefliesCommandWebhook);
CommandCallWebhookRouter.post("/fathom", receiveFathomCommandWebhook);

export default CommandCallWebhookRouter;
