import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("production-v2 Inngest integration", () => {
  test("routes every blog event through the optimized production writer", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    const taskStart = source.indexOf("export const generateBlogTask");
    const taskEnd = source.indexOf("export const dailyBlogScheduler", taskStart);
    const task = source.slice(taskStart, taskEnd);
    const v2Writer = task.indexOf("generateProductionV2Blog({");
    expect(taskStart).toBeGreaterThanOrEqual(0);
    expect(taskEnd).toBeGreaterThan(taskStart);
    expect(v2Writer).toBeGreaterThanOrEqual(0);
    expect(task).not.toContain("generateBlogFromKeywordLLM(");
    expect(task).not.toContain("selectedBlogImage");
    expect(task).not.toContain('step.run("generate-blog-content"');
    expect(task).toContain(
      "durableStep: (id, handler) => step.run(id, handler)",
    );
    expect(task).toContain("getProductionPublishingHandoffDecision({");
    expect(task).toContain('step.run("handoff-v2-blog-to-publishing"');
  });

  test("splits every billable provider boundary into a durable named step", () => {
    const serviceRoot = resolve(
      import.meta.dir,
      "../services/blog-pipeline-v2",
    );
    const pipeline = readFileSync(resolve(serviceRoot, "pipeline.ts"), "utf8");
    const editorial = readFileSync(
      resolve(serviceRoot, "staged-writer.ts"),
      "utf8",
    );
    const images = readFileSync(
      resolve(serviceRoot, "image-pipeline.ts"),
      "utf8",
    );

    expect(pipeline).toContain('"production-v2-select-links"');
    expect(pipeline).toContain('"production-v2-topic-research"');
    expect(pipeline).toContain('"production-v2-persist"');
    expect(pipeline).not.toContain('"production-v2-editorial-length-repair"');
    expect(pipeline).not.toContain('"production-v2-validate-and-persist"');
    expect(editorial).toContain(
      '`production-v2-editorial-${stage.replaceAll("_", "-")}`',
    );
    expect(images).toContain('`production-v2-image-${brief.role}`');
  });

  test("pins every backend blog/generate producer", () => {
    const sources = [
      resolve(import.meta.dir, "../inngest/client.ts"),
      resolve(import.meta.dir, "../controllers/blog.controller.ts"),
    ].map((path) => readFileSync(path, "utf8"));
    const sends = sources
      .join("\n")
      .match(/name:\s*["']blog\/generate["'][\s\S]{0,180}?data:/g);
    const pinned = sources
      .join("\n")
      .match(/name:\s*["']blog\/generate["'][\s\S]{0,180}?data:\s*buildPinnedBlogGenerateEventData/g);
    expect(sends).toHaveLength(6);
    expect(pinned).toHaveLength(6);
  });

  test("exposes authenticated generation status and records queued work before dispatch", () => {
    const controller = readFileSync(
      resolve(import.meta.dir, "../controllers/blog.controller.ts"),
      "utf8",
    );
    const router = readFileSync(
      resolve(import.meta.dir, "../services/blog.service.ts"),
      "utf8",
    );
    const queueRecord = controller.indexOf("queueProductionBlogGenerationRun({");
    const dispatch = controller.indexOf('name: "blog/generate"', queueRecord);
    expect(queueRecord).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(queueRecord);
    expect(router).toContain(
      'BlogRouter.post("/generation-statuses", getBlogGenerationStatuses);',
    );
    expect(router.indexOf("BlogRouter.use(requireBackendAuth)")).toBeLessThan(
      router.indexOf('BlogRouter.post("/generation-statuses"'),
    );
  });
});
