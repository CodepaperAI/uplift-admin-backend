import attributeData from "../data/gmb-attributes.json";
import { getCategoryById } from "./gmb-categories";

export type GMBAttributeValueType = "BOOL" | "ENUM" | "URL" | "REPEATED_ENUM";

export type GMBAttributeEnumOption = {
  value: string;
  label: string;
};

export type GMBAttributeDefinition = {
  id: string;
  displayName: string;
  group: string;
  valueType: GMBAttributeValueType;
  enumOptions?: GMBAttributeEnumOption[];
  applicableGroups: string[];
  requiredForGroups?: string[];
};

type CatalogShape = {
  version: string;
  source: string;
  completeness: string;
  note: string;
  attributes: GMBAttributeDefinition[];
};

const catalog = attributeData as CatalogShape;

let byIdIndex: Map<string, GMBAttributeDefinition> | null = null;

function ensureIndex() {
  if (byIdIndex) return;
  byIdIndex = new Map();
  for (const def of catalog.attributes) byIdIndex.set(def.id, def);
}

export const GMB_ATTRIBUTE_CATALOG_VERSION = catalog.version;

export function getAttributeById(id: string): GMBAttributeDefinition | null {
  ensureIndex();
  return byIdIndex!.get(id) ?? null;
}

export function listAllAttributes(): GMBAttributeDefinition[] {
  return catalog.attributes.slice();
}

function attributeApplies(def: GMBAttributeDefinition, group: string): boolean {
  return def.applicableGroups.includes("*") || def.applicableGroups.includes(group);
}

/**
 * Attributes that apply to a business given its chosen category ids.
 * Union across all category groups. Returns deduped, grouped order preserved.
 */
export function getAttributesForCategoryIds(categoryIds: string[]): GMBAttributeDefinition[] {
  const groups = new Set<string>();
  for (const id of categoryIds) {
    const cat = getCategoryById(id);
    if (cat) groups.add(cat.group);
  }
  if (groups.size === 0) {
    // No known categories - return universal attributes only so the editor still works.
    return catalog.attributes.filter((def) => def.applicableGroups.includes("*"));
  }
  const seen = new Set<string>();
  const result: GMBAttributeDefinition[] = [];
  for (const def of catalog.attributes) {
    if (seen.has(def.id)) continue;
    let applies = false;
    if (def.applicableGroups.includes("*")) {
      applies = true;
    } else {
      for (const g of groups) {
        if (attributeApplies(def, g)) {
          applies = true;
          break;
        }
      }
    }
    if (applies) {
      seen.add(def.id);
      result.push(def);
    }
  }
  return result;
}

/**
 * Attributes that are flagged as required for the primary category's group.
 * Drives the "attributes_required" health check.
 */
export function getRequiredAttributesForPrimaryCategory(primaryCategoryId: string | null): GMBAttributeDefinition[] {
  if (!primaryCategoryId) return [];
  const cat = getCategoryById(primaryCategoryId);
  if (!cat) return [];
  return catalog.attributes.filter((def) =>
    def.requiredForGroups?.includes(cat.group) ?? false,
  );
}

/**
 * A submitted attribute value (from the API request body or the editor).
 * The valueType in the request must match the catalog definition.
 */
export type GMBAttributeSubmission = {
  attributeId: string;
  boolValue?: boolean | null;
  enumValue?: string | null;
  urlValue?: string | null;
  enumValues?: string[] | null;
};

export type AttributeValidationIssue =
  | { code: "unknown_id"; attributeId: string }
  | { code: "wrong_value_type"; attributeId: string; expected: GMBAttributeValueType }
  | { code: "invalid_enum_value"; attributeId: string; value: string }
  | { code: "invalid_url"; attributeId: string };

export function validateAttributeSubmissions(
  submissions: GMBAttributeSubmission[],
): AttributeValidationIssue[] {
  ensureIndex();
  const issues: AttributeValidationIssue[] = [];

  for (const sub of submissions) {
    const def = byIdIndex!.get(sub.attributeId);
    if (!def) {
      issues.push({ code: "unknown_id", attributeId: sub.attributeId });
      continue;
    }

    switch (def.valueType) {
      case "BOOL":
        if (typeof sub.boolValue !== "boolean" && sub.boolValue !== null) {
          issues.push({ code: "wrong_value_type", attributeId: sub.attributeId, expected: "BOOL" });
        }
        break;
      case "ENUM": {
        if (sub.enumValue == null) break;
        const known = def.enumOptions?.some((o) => o.value === sub.enumValue);
        if (!known) {
          issues.push({ code: "invalid_enum_value", attributeId: sub.attributeId, value: sub.enumValue });
        }
        break;
      }
      case "REPEATED_ENUM": {
        if (!sub.enumValues) break;
        for (const v of sub.enumValues) {
          const known = def.enumOptions?.some((o) => o.value === v);
          if (!known) {
            issues.push({ code: "invalid_enum_value", attributeId: sub.attributeId, value: v });
          }
        }
        break;
      }
      case "URL":
        if (sub.urlValue == null || sub.urlValue === "") break;
        try {
          const parsed = new URL(sub.urlValue);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            issues.push({ code: "invalid_url", attributeId: sub.attributeId });
          }
        } catch {
          issues.push({ code: "invalid_url", attributeId: sub.attributeId });
        }
        break;
    }
  }

  return issues;
}
