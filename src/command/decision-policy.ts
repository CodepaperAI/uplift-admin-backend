import { z } from "zod";

const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toLowerCase());
const fxRates = z.record(
  z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toLowerCase()),
  z.string().regex(/^\d+(?:\.\d{1,8})?$/),
);

export const COMMAND_DECISION_DEFINITIONS = [
  {
    key: "clawback_policy",
    decision: "D2",
    category: "compensation",
    label: "Clawback window",
    requiresLegal: false,
    requiredFor: ["commission"],
    recommendedValue: { windowDays: 60 },
    schema: z.object({ windowDays: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(90)]) }).strict(),
  },
  {
    key: "draw_policy",
    decision: "D3",
    category: "compensation",
    label: "Draw treatment",
    requiresLegal: true,
    requiredFor: ["commission", "cac"],
    recommendedValue: { type: "recoverable" },
    schema: z.object({ type: z.enum(["recoverable", "non_recoverable"]) }).strict(),
  },
  {
    key: "ghl_service_attribution",
    decision: "D4",
    category: "mapping",
    label: "GHL service attribution",
    requiresLegal: false,
    requiredFor: ["commission"],
    recommendedValue: { method: "pipeline" },
    schema: z
      .object({
        method: z.enum(["pipeline", "custom_field"]),
        customFieldId: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.method === "custom_field" && !value.customFieldId) {
          context.addIssue({
            code: "custom",
            path: ["customFieldId"],
            message: "A GHL custom field id is required",
          });
        }
      }),
  },
  {
    key: "meeting_provider",
    decision: "D5",
    category: "coaching",
    label: "Meeting notes provider and retention",
    requiresLegal: true,
    requiredFor: ["coaching"],
    recommendedValue: {
      provider: "fireflies",
      retentionDays: 90,
      consentPolicy: "explicit_consent",
    },
    schema: z
      .object({
        provider: z.enum(["fireflies", "fathom"]),
        retentionDays: z.number().int().min(1).max(3650),
        consentPolicy: z.enum(["provider_managed", "explicit_consent"]),
      })
      .strict(),
  },
  {
    key: "coaching_visibility",
    decision: "D6",
    category: "coaching",
    label: "Coaching visibility",
    requiresLegal: false,
    requiredFor: ["coaching"],
    recommendedValue: { visibility: "rep_own" },
    schema: z.object({ visibility: z.enum(["manager_only", "rep_own"]) }).strict(),
  },
  {
    key: "departing_rep_residuals",
    decision: "D7",
    category: "compensation",
    label: "Departing rep residual commission",
    requiresLegal: true,
    requiredFor: ["commission"],
    recommendedValue: { policy: "stop_on_departure" },
    schema: z.object({ policy: z.enum(["stop_on_departure", "continue_residual"]) }).strict(),
  },
  {
    key: "deal_credit_policy",
    decision: "D8",
    category: "compensation",
    label: "Deal credit",
    requiresLegal: false,
    requiredFor: ["commission"],
    recommendedValue: { policy: "single_owner" },
    schema: z.object({ policy: z.enum(["single_owner", "split_credit"]) }).strict(),
  },
  {
    key: "currency_policy",
    decision: "D9",
    category: "compensation",
    label: "Commission currency",
    requiresLegal: false,
    requiredFor: ["commission", "cac", "ltv"],
    recommendedValue: { mode: "separate_currency" },
    schema: z
      .object({
        mode: z.enum(["separate_currency", "base_currency"]),
        baseCurrency: currency.optional(),
        fxSource: z.string().trim().min(2).max(120).optional(),
        fxRates: fxRates.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.mode === "base_currency" &&
          (!value.baseCurrency || !value.fxSource || !value.fxRates)
        ) {
          context.addIssue({
            code: "custom",
            message: "Base-currency mode requires baseCurrency, an approved FX source, and effective rates",
          });
        }
      }),
  },
  {
    key: "past_due_release_policy",
    decision: "C-08",
    category: "compensation",
    label: "Past-due release posting",
    requiresLegal: false,
    requiredFor: ["commission"],
    recommendedValue: { policy: "current_open_period_adjustment" },
    schema: z.object({ policy: z.literal("current_open_period_adjustment") }).strict(),
  },
  {
    key: "cpl_policy",
    decision: "M-11",
    category: "metrics",
    label: "Cost per lead definition",
    requiresLegal: false,
    requiredFor: ["cpl"],
    recommendedValue: {
      numerator: "acquisition_cost",
      denominator: "new_assigned_leads",
    },
    schema: z
      .object({
        numerator: z.literal("acquisition_cost"),
        denominator: z.literal("new_assigned_leads"),
      })
      .strict(),
  },
  {
    key: "provider_override_policy",
    decision: "N-07",
    category: "data_governance",
    label: "Provider correction precedence",
    requiresLegal: false,
    requiredFor: ["overrides", "commission"],
    recommendedValue: { precedence: "approved_override_after_provider" },
    schema: z.object({ precedence: z.literal("approved_override_after_provider") }).strict(),
  },
  {
    key: "billing_operations_scope",
    decision: "S-08",
    category: "data_governance",
    label: "Billing Operations scope",
    requiresLegal: false,
    requiredFor: ["governance"],
    recommendedValue: { mode: "outside_command_panel" },
    schema: z.object({ mode: z.literal("outside_command_panel") }).strict(),
  },
] as const;

export type CommandDecisionKey = (typeof COMMAND_DECISION_DEFINITIONS)[number]["key"];

const definitionByKey = new Map(
  COMMAND_DECISION_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function getCommandDecisionDefinition(key: string) {
  return definitionByKey.get(key as CommandDecisionKey) ?? null;
}

export function parseCommandDecisionValue(key: string, value: unknown): unknown {
  const definition = getCommandDecisionDefinition(key);
  if (!definition) throw new Error("Unsupported Command decision");
  return definition.schema.parse(value);
}

export const COMMISSION_DECISION_KEYS = COMMAND_DECISION_DEFINITIONS.filter(
  (definition) => (definition.requiredFor as readonly string[]).includes("commission"),
).map((definition) => definition.key);

export const COMMAND_DECISION_WRITE_INPUT = z
  .object({
    key: z.string().trim().min(1).max(100),
    value: z.unknown(),
    status: z.enum(["draft", "approved"]).default("draft"),
    effectiveAt: z.coerce.date(),
    legalConfirmed: z.boolean().default(false),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const COMMAND_RECOMMENDED_DECISIONS_INPUT = z
  .object({
    effectiveAt: z.coerce.date(),
    legalConfirmed: z.boolean(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
