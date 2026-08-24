/**
 * blog-critique-context.ts
 *
 * Per-generation-run state for the expert-voice critique-revise loop, carried
 * via AsyncLocalStorage (same pattern as blog-image-usage-context). The
 * generator sets it up with the run's real substance + config; saveBlogInDb
 * reads it to judge each draft, accumulate attempts, and keep the best.
 *
 * Only the FULL keyword-blog path establishes this context, so saveBlogInDb
 * automatically skips the loop on the quick/trial path (getStore() === null).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CompetitorSubstance,
  OfferingSubstance,
} from "../../utils/blog-substance.utils";
import type { ModuleContext } from "./blog-modules";
import type { BlogGroundingPacket } from "../../utils/blog-grounding.utils";
import type { SectionValidationFailure } from "../../utils/blog-section-repair.utils";
import type { GroundedBlogOutline } from "../../services/grounded-blog-outline.service";
import type { ExpertVoiceVerdict } from "../../services/expert-voice-judge.service";

export interface BlogCritiqueSubstance {
  businessName: string;
  competitors: CompetitorSubstance[];
  offering: OfferingSubstance;
  /** Offerings with retrieved first-party passages suitable for detailed coverage. */
  evidenceBackedOfferings?: string[];
}

export interface JudgedDraftSnapshot {
  overall: number;
  groundingIssueCount?: number;
  /** Snapshot of the content-bearing payload fields for keep-best-of-N. */
  payload: Record<string, unknown>;
}

export interface CapturedDraft {
  title: string;
  content: string;
  excerpt: string;
  slug: string;
  /**
   * Exact application-owned CREATE_BLOG payload after deterministic assembly.
   * Local recovery tooling uses this to package metadata and scheduling without
   * re-asking the writer or guessing fields. It is never persisted by dry-run.
   */
  payload?: Record<string, unknown>;
  /**
   * Dry-run review context. This is intentionally returned only to the local
   * comparison/pilot harness so it can build a transparent evidence package
   * without querying or mutating production after generation.
   */
  generationContext?: {
    seoTitle: string;
    structureType: string;
    contentIntent: string;
    contentArchetype: string | null;
    locale: string;
    canonicalFactPacket: Record<string, unknown>;
    outline: GroundedBlogOutline | null;
  };
  analytics?: Record<string, unknown>;
  llmUsage?: {
    provider: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    estimatedUsd: number | null;
    fallbackUsed: boolean;
    fallbackReason?: string;
  };
}

export interface BlogCritiqueContext {
  enabled: boolean;
  bar: number;
  maxRevisions: number;
  keyword: string;
  correlationId?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  substance: BlogCritiqueSubstance;
  /**
   * Per-article module plan for the deterministic module gate. When present,
   * saveBlogInDb enforces that every applicable rank-module actually rendered.
   * Undefined on paths that don't compute it (gate then no-ops).
   */
  moduleContext?: ModuleContext;
  /** Closed-world facts used by both the writer prompt and persistence gate. */
  grounding?: BlogGroundingPacket;
  outline?: GroundedBlogOutline;
  /**
   * The sectioned writer never asks the model to author FAQ markup. Keep its
   * canonical three-pair FAQ here so the save gate can restore it after model
   * prose sanitization and before final validation.
   */
  applicationOwnedFaq?: {
    sectionId: string;
    html: string;
  };
  /**
   * Structure label of the locked title (e.g. "alternatives", "how-to"). An
   * alternatives title promises option comparison, so the comparison gate must
   * tolerate comparative content even when the title text carries no explicit
   * comparison vocabulary ("…: options").
   */
  titleStructure?: string;
  /** Strategist/archetype length contract enforced before editorial judging. */
  wordCountRange?: {
    min: number;
    max: number;
    target: number;
  };
  /** Application-owned publication schedule; model-provided dates are ignored. */
  plannedPublishInfo?: {
    date: string;
    time: string;
  };
  /** Mutable accumulators (per run). */
  drafts: JudgedDraftSnapshot[];
  /** Number of drafts rejected by deterministic grounding/module/phrase gates. */
  validationFailures?: number;
  /** Terminal gate failure: the graph must stop instead of asking the writer again. */
  terminalFailure?: string;
  /** Application-owned section repair state; passing sections are immutable. */
  pendingSectionRepair?: {
    previousContent: string;
    failures: SectionValidationFailure[];
    /** Exact locked sections the application is allowed to replace or extend. */
    targetSectionIds: string[];
  };
  sectionRepairAttempts?: Record<string, number>;
  validationFailureHistory?: SectionValidationFailure[];
  /** Latest quality verdict, consumed by the application-owned section repair loop. */
  latestExpertVoiceVerdict?: ExpertVoiceVerdict;
  /**
   * Dry-run: when true, saveBlogInDb captures the final draft into `captured`
   * and DOES NOT persist (no DB write, no images). Used by the comparison
   * harness so it can run the real pipeline without touching prod.
   */
  dryRun?: boolean;
  captured?: CapturedDraft;
  /** Set only after the application receives a concrete blog id from the API. */
  saveSucceeded?: boolean;
  savedBlogId?: string;
  savedAsDuplicate?: boolean;
  /** One application-owned forced persistence attempt for the legacy writer. */
  legacyForcedSaveAttempts?: number;
}

export type GroundedCritiqueContextFields = Pick<
  BlogCritiqueContext,
  "moduleContext" | "grounding" | "outline"
>;

/**
 * Keep the emergency legacy-writer rollback fail-safe end to end. Disabling
 * the grounded writer contract must also remove the deterministic grounding,
 * outline, and module gates; otherwise the legacy prompt is still judged
 * against a contract it never received and every draft fails closed.
 */
export function buildGroundedCritiqueContextFields(
  enabled: boolean,
  fields: GroundedCritiqueContextFields,
): Partial<GroundedCritiqueContextFields> {
  return enabled ? fields : {};
}

const storage = new AsyncLocalStorage<BlogCritiqueContext>();

export function runWithBlogCritiqueContext<T>(
  context: BlogCritiqueContext,
  callback: () => Promise<T>,
): Promise<T> {
  return storage.run(context, callback);
}

export function getBlogCritiqueContext(): BlogCritiqueContext | undefined {
  return storage.getStore();
}
