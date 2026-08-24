import { Router } from "express";
import {
  addWordPressCredentials,
  deleteWordPressCredentials,
  getWordPressCredentials,
} from "../controllers/wordpress.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const WordPressRouter = Router();

WordPressRouter.use(requireBackendAuth);
WordPressRouter.get("/credentials", getWordPressCredentials);
WordPressRouter.post("/credentials", addWordPressCredentials);
WordPressRouter.delete("/credentials", deleteWordPressCredentials);

export default WordPressRouter;
