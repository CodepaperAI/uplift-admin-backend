import { Router } from "express";
import { requireInternalAuthEmailSecret } from "../middleware/require-internal-secret";
import {
  sendChangeEmailVerificationEmailInternal,
  sendPasswordResetEmailInternal,
} from "../controllers/internal-auth-email.controller";

const InternalAuthEmailRouter: Router = Router();

InternalAuthEmailRouter.use(requireInternalAuthEmailSecret);

InternalAuthEmailRouter.post(
  "/password-reset",
  sendPasswordResetEmailInternal
);
InternalAuthEmailRouter.post(
  "/change-email-verification",
  sendChangeEmailVerificationEmailInternal
);

export default InternalAuthEmailRouter;
