import { Router } from "express";
import { userBusinessSetup } from "../controllers/llm.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const LLMRouter = Router();

LLMRouter.post(
  "/account-setup",
  requireBackendAuth,
  bindAuthenticatedUser,
  userBusinessSetup,
);

export default LLMRouter;
