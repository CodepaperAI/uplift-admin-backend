import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  COMMAND_DECISION_DEFINITIONS,
  COMMISSION_DECISION_KEYS,
  getCommandDecisionDefinition,
} from "./decision-policy";

export type ApprovedDecision = {
  id: string;
  key: string;
  version: number;
  value: Prisma.JsonValue;
  effectiveAt: Date;
  approvedAt: Date;
};

export async function resolveApprovedCommandDecisions(
  asOf = new Date(),
): Promise<Record<string, ApprovedDecision>> {
  const rows = await prisma.commandDecision.findMany({
    where: {
      status: "approved",
      approvedAt: { not: null },
      effectiveAt: { lte: asOf },
      OR: [{ retiredAt: null }, { retiredAt: { gt: asOf } }],
    },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  const result: Record<string, ApprovedDecision> = {};
  for (const row of rows) {
    if (result[row.key] || !row.approvedAt) continue;
    result[row.key] = {
      id: row.id,
      key: row.key,
      version: row.version,
      value: row.value,
      effectiveAt: row.effectiveAt,
      approvedAt: row.approvedAt,
    };
  }
  return result;
}

export async function getCommandDecisionReadiness(asOf = new Date()) {
  const approved = await resolveApprovedCommandDecisions(asOf);
  const activeServices = await prisma.commandService.findMany({
    where: { isActive: true },
    select: {
      id: true,
      key: true,
      name: true,
      rateVersions: {
        where: {
          status: "approved",
          approvedAt: { not: null },
          effectiveFrom: { lte: asOf },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
        },
        orderBy: { effectiveFrom: "desc" },
        take: 1,
      },
    },
  });
  const missingDecisions = COMMISSION_DECISION_KEYS.filter((key) => !approved[key]);
  const missingServiceRates = activeServices
    .filter((service) => service.rateVersions.length === 0)
    .map((service) => ({ id: service.id, key: service.key, name: service.name }));

  return {
    readyForCommission: missingDecisions.length === 0 && missingServiceRates.length === 0,
    missingDecisions,
    missingServiceRates,
    approved,
  };
}

export async function listCommandDecisionCenter(asOf = new Date()) {
  const [rows, readiness] = await Promise.all([
    prisma.commandDecision.findMany({
      orderBy: [{ key: "asc" }, { version: "desc" }],
    }),
    getCommandDecisionReadiness(asOf),
  ]);
  const versionsByKey = new Map<string, typeof rows>();
  for (const row of rows) {
    const current = versionsByKey.get(row.key) ?? [];
    current.push(row);
    versionsByKey.set(row.key, current);
  }
  return {
    definitions: COMMAND_DECISION_DEFINITIONS.map((definition) => ({
      key: definition.key,
      decision: definition.decision,
      category: definition.category,
      label: definition.label,
      requiresLegal: definition.requiresLegal,
      requiredFor: definition.requiredFor,
      versions: versionsByKey.get(definition.key) ?? [],
      current: readiness.approved[definition.key] ?? null,
    })),
    readiness: {
      readyForCommission: readiness.readyForCommission,
      missingDecisions: readiness.missingDecisions,
      missingServiceRates: readiness.missingServiceRates,
    },
  };
}

export function assertDecisionMayBeApproved(input: {
  key: string;
  isSuperadmin: boolean;
  legalConfirmed: boolean;
}) {
  const definition = getCommandDecisionDefinition(input.key);
  if (!definition) throw new Error("Unsupported Command decision");
  if (!input.isSuperadmin) throw new Error("Only a superadmin can approve operating decisions");
  if (definition.requiresLegal && !input.legalConfirmed) {
    throw new Error("This decision requires recorded legal confirmation");
  }
  return definition;
}
