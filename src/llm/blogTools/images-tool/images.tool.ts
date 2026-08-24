/**
 * Compatibility export for the byte-frozen local GPT-5 mini recovery runner.
 * Production blog generation uses services/blog-pipeline-v2/image-pipeline.ts.
 */
export {
  generateRecoveryImageWithOpenAI as generateWithOpenAI,
  type RecoveryOpenAiImage as ImageResult,
} from "../../../services/recovery-image-generator.service";
