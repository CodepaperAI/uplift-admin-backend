import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  addKeywordInstruction,
  checkKeywordSimilarity,
  deleteKeyword,
  generateNewKeywords,
  getDeletedKeywords,
  getKeywordAnalytics,
  getKeywordGenerationStatus,
  getKeywords,
  getUnusedKeywords,
  getUsedKeywords,
  keywordGenerator,
  missingKeywordGenerator,
  generateSingleMissingKeyword,
  restoreKeyword,
  searchKeywordsWithDataForSEO,
  uploadKeywordPlan,
} from "../controllers/keyword.controller";

const KeywordRouter: Router = Router();

KeywordRouter.use(requireBackendAuth);
KeywordRouter.post("/generate-keywords", keywordGenerator);
KeywordRouter.post("/upload-keyword", uploadKeywordPlan);
KeywordRouter.post("/upload-keyword-plan", (req, res) => {
  console.warn("[DEPRECATED] POST /api/v1/keyword/upload-keyword-plan is deprecated. Use POST /upload-keyword instead.");
  return uploadKeywordPlan(req, res);
});
KeywordRouter.post("/get-keywords", getKeywords);
KeywordRouter.post("/get-all-keywords", (req, res) => {
  console.warn("[DEPRECATED] POST /api/v1/keyword/get-all-keywords is deprecated. Use POST /get-keywords instead.");
  return getKeywords(req, res);
});
KeywordRouter.post("/generate-new-keywords", generateNewKeywords);
KeywordRouter.post("/delete-keyword", deleteKeyword);
KeywordRouter.post("/get-deleted-keywords", getDeletedKeywords);
KeywordRouter.post("/restore-keyword", restoreKeyword);
KeywordRouter.post("/generate-missing-keyword", missingKeywordGenerator);
KeywordRouter.post("/generate-single-missing-keyword", generateSingleMissingKeyword);
KeywordRouter.post("/add-keyword-instruction", addKeywordInstruction);

// New keyword tracking routes
KeywordRouter.post("/analytics", getKeywordAnalytics);
KeywordRouter.post("/unused", getUnusedKeywords);
KeywordRouter.post("/used", getUsedKeywords);
KeywordRouter.post("/check-similarity", checkKeywordSimilarity);

// 🆕 NEW: Keyword generation status route
KeywordRouter.post("/generation-status", getKeywordGenerationStatus);

// 🆕 NEW: Search keywords with DataForSEO
KeywordRouter.post("/search-keywords", searchKeywordsWithDataForSEO);

export default KeywordRouter;
