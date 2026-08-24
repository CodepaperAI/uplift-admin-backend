import { describe, expect, it } from "bun:test";
import {
  buildModulePlanPromptBlock,
  selectModules,
  type ModuleContext,
  type ModuleId,
} from "../llm/blogTools/blog-modules";
import {
  buildMissingModuleRevisionMessage,
  findMissingModules,
} from "../utils/blog-module-gate.utils";

const LOCAL_SERVICE: ModuleContext = {
  businessModel: "service",
  locationTier: "city",
  useLocalSection: true,
  intent: "commercial",
  isComparative: false,
  isHowTo: false,
  hasFacts: true,
  hasReviews: true,
};

const ECOMMERCE: ModuleContext = {
  businessModel: "product",
  locationTier: "none",
  useLocalSection: false,
  intent: "commercial",
  isComparative: true,
  isHowTo: false,
  hasFacts: true,
  hasReviews: false,
};

const NATIONAL_B2B: ModuleContext = {
  businessModel: "service",
  locationTier: "none",
  useLocalSection: false,
  intent: "informational",
  isComparative: false,
  isHowTo: true,
  hasFacts: false,
  hasReviews: false,
};

describe("selectModules — business-type matrix (generalises, no per-vertical code)", () => {
  it("local service: includes local-tip, at-a-glance, and reviews without forcing a competitor table", () => {
    const ids = selectModules(LOCAL_SERVICE).map((m) => m.id);
    expect(ids).toContain("quick-answer");
    expect(ids).toContain("toc"); // applies to all
    expect(ids).toContain("local-tip");
    expect(ids).toContain("at-a-glance");
    expect(ids).toContain("reviews");
    expect(ids).not.toContain("comparison-table"); // only explicitly comparative topics
    expect(ids).toContain("faq");
    expect(ids).toContain("author-eeat");
    expect(ids).not.toContain("schema");
    expect(ids).not.toContain("howto-steps");
  });

  it("e-commerce: includes comparison + at-a-glance, NO local-tip, NO reviews", () => {
    const ids = selectModules(ECOMMERCE).map((m) => m.id);
    expect(ids).toContain("comparison-table");
    expect(ids).toContain("methodology"); // comparative → E-E-A-T methodology
    expect(ids).toContain("at-a-glance"); // product business
    expect(ids).not.toContain("local-tip");
    expect(ids).not.toContain("reviews"); // hasReviews false
  });

  it("national B2B how-to: includes howto-steps, NO local-tip, NO at-a-glance, NO comparison", () => {
    const ids = selectModules(NATIONAL_B2B).map((m) => m.id);
    expect(ids).toContain("howto-steps");
    expect(ids).toContain("quick-answer");
    expect(ids).toContain("faq");
    expect(ids).not.toContain("local-tip");
    expect(ids).not.toContain("at-a-glance"); // service, no facts/reviews/location
    expect(ids).not.toContain("comparison-table"); // informational, not comparative
    expect(ids).not.toContain("methodology"); // not comparative
  });

  it("with NO strategist decision, falls back to all applicable (safe default)", () => {
    const ids = selectModules(LOCAL_SERVICE).map((m) => m.id);
    expect(ids).toContain("at-a-glance"); // applicable, no decision → included
  });

  it("WITH a decision, enforces baseline + (chosen ∩ applicable) only — decide, don't pile on", () => {
    const ctx: ModuleContext = {
      ...ECOMMERCE,
      chosenModules: ["comparison-table"] as ModuleId[],
    };
    const ids = selectModules(ctx).map((m) => m.id);
    // baseline always-on:
    expect(ids).toContain("quick-answer");
    expect(ids).toContain("faq");
    expect(ids).not.toContain("schema");
    // chosen + applicable:
    expect(ids).toContain("comparison-table");
    // applicable but NOT chosen → dropped (no longer piled on):
    expect(ids).not.toContain("at-a-glance");
    expect(ids).not.toContain("methodology");
  });

  it("a chosen module that doesn't apply is still filtered out (safety rail)", () => {
    const ctx: ModuleContext = {
      ...NATIONAL_B2B,
      chosenModules: ["local-tip", "howto-steps"] as ModuleId[],
    };
    const ids = selectModules(ctx).map((m) => m.id);
    expect(ids).not.toContain("local-tip"); // appliesTo false → filtered even though chosen
    expect(ids).toContain("howto-steps"); // chosen + applicable
  });

  it("the prompt block names every selected module", () => {
    const modules = selectModules(LOCAL_SERVICE);
    const block = buildModulePlanPromptBlock(modules);
    expect(block).toContain("QUICK ANSWER BOX");
    expect(block).toContain("LOCAL TIP");
    expect(block.length).toBeGreaterThan(0);
  });
});

// A draft that satisfies every module a national B2B how-to requires.
const COMPLETE_B2B_HTML = `
<div class="quick-answer"><strong>Quick answer:</strong> ...</div>
<nav class="toc"><ul><li><a href="#a">A</a></li></ul></nav>
<ol class="howto-steps"><li>Step</li></ol>
<p class="faq-answer" style="x">A</p>
<div class="key-takeaways"><h2>Key Takeaways</h2><ul><li>x</li></ul></div>
<div class="author-bio">By Jane</div>`;

describe("findMissingModules — deterministic enforcement", () => {
  it("returns empty when every required module rendered", () => {
    expect(findMissingModules(COMPLETE_B2B_HTML, NATIONAL_B2B)).toEqual([]);
  });

  it("flags a missing quick-answer box", () => {
    const html = COMPLETE_B2B_HTML.replace(/class="quick-answer"/, 'class="intro"');
    const missing = findMissingModules(html, NATIONAL_B2B).map((m) => m.id);
    expect(missing).toContain("quick-answer");
  });

  it("requires semantic FAQ answer markup without model-generated schema", () => {
    const html = COMPLETE_B2B_HTML.replace(/class="faq-answer"/, 'class="answer"');
    const missing = findMissingModules(html, NATIONAL_B2B).map((m) => m.id);
    expect(missing).toContain("faq");
  });

  it("does not let an unrelated table satisfy the comparison-table module", () => {
    const html = `${COMPLETE_B2B_HTML}<table class="at-a-glance"><tr><td>Fact</td></tr></table>`;
    const missing = findMissingModules(html, ECOMMERCE).map((m) => m.id);
    expect(missing).toContain("comparison-table");
  });

  it("does not require modules that don't apply (no local-tip for national B2B)", () => {
    // COMPLETE_B2B_HTML has no local-tip; national B2B must still pass.
    const missing = findMissingModules(COMPLETE_B2B_HTML, NATIONAL_B2B).map((m) => m.id);
    expect(missing).not.toContain("local-tip");
  });

  it("is total/defensive: null ctx or empty content → nothing missing", () => {
    expect(findMissingModules(COMPLETE_B2B_HTML, null)).toEqual([]);
    expect(findMissingModules("", NATIONAL_B2B)).toEqual([]);
    expect(findMissingModules(123, NATIONAL_B2B)).toEqual([]);
  });

  it("is reentrant — repeated calls give stable results", () => {
    const a = findMissingModules(COMPLETE_B2B_HTML, LOCAL_SERVICE);
    const b = findMissingModules(COMPLETE_B2B_HTML, LOCAL_SERVICE);
    expect(a).toEqual(b);
  });

  it("revision message names the missing modules with their specs", () => {
    const missing = findMissingModules("<p>nothing</p>", NATIONAL_B2B);
    const msg = buildMissingModuleRevisionMessage(missing, NATIONAL_B2B);
    expect(msg.toLowerCase()).toContain("not saved");
    expect(msg).toContain("QUICK ANSWER BOX");
  });
});
