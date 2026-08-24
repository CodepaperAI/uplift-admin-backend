import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  generateBlogFromPlannedKeywords,
  getBlogGenerationStatuses,
  generateTitlesOnly,
  getAllBlogs,
  getBlogById,
  getAvailableLanguages,
  postBlog,
  triggerDailyBlogGeneration,
  regenerateMissedBlogs,
  updateBlog,
} from "../controllers/blog.controller";

const BlogRouter: Router = Router();

BlogRouter.use(requireBackendAuth);
BlogRouter.post("/new", postBlog);
BlogRouter.put("/:id", updateBlog);
BlogRouter.post("/generate-blog", generateBlogFromPlannedKeywords);
BlogRouter.post("/generation-statuses", getBlogGenerationStatuses);
BlogRouter.post("/generate-titles", generateTitlesOnly);
BlogRouter.post("/all-blogs", getAllBlogs);
BlogRouter.post("/blog-info", getBlogById);
BlogRouter.post("/get-available-languages", getAvailableLanguages);
BlogRouter.post("/trigger-daily-blog-generation", triggerDailyBlogGeneration);
BlogRouter.post("/regenerate-missed-blogs", regenerateMissedBlogs);

export default BlogRouter;
