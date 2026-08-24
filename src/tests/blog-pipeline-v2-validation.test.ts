import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

function serviceSource(file: string): string {
  return readFileSync(
    resolve(import.meta.dir, "../services/blog-pipeline-v2", file),
    "utf8",
  );
}

describe("production blog prompt-first contract", () => {
  test("runs the five editorial stages with one shared senior-editor instruction", () => {
    const source = serviceSource("staged-writer.ts");
    const start = source.indexOf("async function writeAgentTestingRecoveryDraft");
    const end = source.indexOf(
      "export async function writeProductionStagedV3Draft",
      start,
    );
    const writer = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const stage of ["research", "angle", "outline", "article", "seo_package"]) {
      expect(writer).toContain(`stage: "${stage}"`);
    }
    expect(writer.match(/PRODUCTION_PROMPT_FIRST_EDITORIAL_GUIDANCE/g)).toHaveLength(5);
    expect(source).toContain("Treat the keyword as an intent brief");
    expect(source).toContain("Choose semantic HTML and section depth based on the topic");
    expect(source).toContain("an FAQ only when they materially improve the article");
    expect(source).toContain("Quick summary immediately after the introduction");
    expect(source).toContain("End with a distinct, useful conclusion section");
    expect(source).toContain("Make the final H2 a natural conclusion");
    expect(source).toContain("Do not target a fixed word count");
  });

  test("ports the recovery title playbook into every active title-shaping stage", () => {
    const source = serviceSource("staged-writer.ts");
    const start = source.indexOf("async function writeAgentTestingRecoveryDraft");
    const end = source.indexOf(
      "export async function writeProductionStagedV3Draft",
      start,
    );
    const writer = source.slice(start, end);
    const titleGuidanceStart = source.indexOf(
      "export const PRODUCTION_TITLE_SELECTION_GUIDANCE",
    );
    const titleGuidanceEnd = source.indexOf(
      "export const PRODUCTION_PROMPT_FIRST_EDITORIAL_GUIDANCE",
      titleGuidanceStart,
    );
    const titleGuidance = source.slice(titleGuidanceStart, titleGuidanceEnd);

    expect(titleGuidanceStart).toBeGreaterThanOrEqual(0);
    expect(titleGuidanceEnd).toBeGreaterThan(titleGuidanceStart);
    expect(writer).toContain("at least six genuinely different");
    expect(titleGuidance).toContain("private do-not-repeat list");
    expect(titleGuidance).toContain("first three words");
    expect(titleGuidance).toContain("A Practical Guide");
    expect(titleGuidance).toContain("Everything You Need to Know");
    expect(titleGuidance).toContain("What to Expect");
    expect(titleGuidance).toContain("without forcing an awkward exact-match phrase");
    expect(titleGuidance).toContain("sound natural when read aloud");
    expect(titleGuidance).toContain("Do not blend another title family");
    expect(writer).toContain(
      "titlePlaybookGuidance: buildBlogTitlePlaybookPrompt(titlePlaybookStrategy)",
    );
    expect(
      writer.match(/PRODUCTION_TITLE_SELECTION_GUIDANCE/g),
    ).toHaveLength(4);
    expect(
      writer.match(/AGENT_TESTING_TITLE_EDITOR_INSTRUCTION/g),
    ).toHaveLength(4);
    expect(writer).toContain("Compare the final title against recentBusinessTitles");
  });

  test("returns the final model package without JavaScript content repair or rejection", () => {
    const source = serviceSource("staged-writer.ts");
    const start = source.indexOf("async function writeAgentTestingRecoveryDraft");
    const end = source.indexOf(
      "export async function writeProductionStagedV3Draft",
      start,
    );
    const writer = source.slice(start, end);

    expect(writer).toContain(
      "const finalArticle = articleIdentity(packaged.value);",
    );
    expect(writer).not.toContain("finalizeStagedArticleMechanics");
    expect(writer).not.toContain("normalizeAgentTestingFaqHeading");
    expect(writer).not.toContain("alignAgentTestingH1");
    expect(writer).not.toContain("normalizeProductionLinkRelations");
    expect(writer).not.toContain("productionTitleTagIssues");
    expect(writer).not.toContain("stagedTitleEditorialIssues");
    expect(writer).not.toContain("stagedTitleHistoryIssues");
    expect(writer).not.toContain("TitleRepair");
    expect(writer).not.toContain("rejectedTitleCandidates");
    expect(writer).not.toContain("blockers");
    expect(writer).not.toContain("throw new Error");
  });

  test("persists generated content without an editorial validator or repair branch", () => {
    const pipeline = serviceSource("pipeline.ts");

    expect(pipeline).toContain("writeProductionStagedV3Draft(");
    expect(pipeline).toContain("generateProductionBlogImages({");
    expect(pipeline).toContain("if (blogImagesEnabled)");
    expect(pipeline).toContain("generatedImageCount: images.length");
    expect(pipeline).toContain('?? ""');
    expect(pipeline).toContain("persistProductionBlog(");
    expect(pipeline).toContain('mode: "prompt-first"');
    expect(pipeline).toContain("postGenerationEditorialValidation: false");
    expect(pipeline).not.toContain("validateProductionDraft");
    expect(pipeline).not.toContain("validateProductionBlog");
    expect(pipeline).not.toContain("repairProductionStagedV3Length");
    expect(pipeline).not.toContain("BLOG_PIPELINE_V2_EDITORIAL_VALIDATION_FAILED");
    expect(pipeline).not.toContain("BLOG_PIPELINE_V2_VALIDATION_FAILED");
    expect(pipeline).not.toContain("validateConclusion");
    expect(pipeline).not.toContain("validateQuickSummary");
  });
});
