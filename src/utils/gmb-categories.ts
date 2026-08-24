import catalogData from "../data/gmb-categories.json";

export type GMBCategoryEntry = {
  id: string;
  name: string;
  group: string;
};

type CatalogShape = {
  version: string;
  source: string;
  completeness: string;
  note: string;
  categories: GMBCategoryEntry[];
};

const catalog = catalogData as CatalogShape;

let byIdIndex: Map<string, GMBCategoryEntry> | null = null;
let lowercaseIndex: Array<{ entry: GMBCategoryEntry; tokens: string[] }> | null = null;

function ensureIndexes() {
  if (byIdIndex && lowercaseIndex) return;
  byIdIndex = new Map();
  lowercaseIndex = [];
  for (const entry of catalog.categories) {
    byIdIndex.set(entry.id, entry);
    const tokens = entry.name.toLowerCase().split(/\s+/).filter(Boolean);
    lowercaseIndex.push({ entry, tokens });
  }
}

export const GMB_CATEGORY_CATALOG_VERSION = catalog.version;
export const GMB_CATEGORY_CATALOG_COMPLETENESS = catalog.completeness;

export function getCategoryById(id: string): GMBCategoryEntry | null {
  ensureIndexes();
  return byIdIndex!.get(id) ?? null;
}

export function listCategoryGroups(): string[] {
  ensureIndexes();
  const set = new Set<string>();
  for (const entry of catalog.categories) set.add(entry.group);
  return Array.from(set);
}

export function listAllCategories(): GMBCategoryEntry[] {
  return catalog.categories.slice();
}

/**
 * Lightweight ranked search: prefix matches score highest, substring next,
 * token-overlap last. Returns top `limit` results.
 */
export function searchCategories(query: string, limit = 25): GMBCategoryEntry[] {
  ensureIndexes();
  const q = query.trim().toLowerCase();
  if (!q) return listAllCategories().slice(0, limit);

  const queryTokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: GMBCategoryEntry; score: number }> = [];

  for (const { entry, tokens } of lowercaseIndex!) {
    const name = entry.name.toLowerCase();
    let score = 0;

    if (name === q) {
      score += 100;
    } else if (name.startsWith(q)) {
      score += 60;
    } else if (name.includes(q)) {
      score += 30;
    }

    for (const qt of queryTokens) {
      for (const t of tokens) {
        if (t === qt) score += 10;
        else if (t.startsWith(qt)) score += 6;
        else if (t.includes(qt)) score += 2;
      }
    }

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Validates that a category id exists in the local catalog.
 *
 * Important: a `false` result does not necessarily mean the id is invalid in
 * GMB itself — the seed catalog is partial. Callers that need authoritative
 * validation must hit the live GBP categories endpoint. For the picker UX this
 * is fine because the picker only emits ids it received from the catalog.
 */
export function isKnownCategoryId(id: string): boolean {
  ensureIndexes();
  return byIdIndex!.has(id);
}

/**
 * GBP limit: one primary category + up to 9 secondary categories per location.
 */
export const GMB_MAX_SECONDARY_CATEGORIES = 9;
export const GMB_MAX_TOTAL_CATEGORIES = GMB_MAX_SECONDARY_CATEGORIES + 1;

export type CategorySelection = {
  primaryId: string | null;
  secondaryIds: string[];
};

export type CategoryValidationIssue =
  | { code: "no_primary" }
  | { code: "duplicate_id"; id: string }
  | { code: "unknown_id"; id: string }
  | { code: "too_many_secondary"; count: number }
  | { code: "primary_in_secondary"; id: string };

export function validateCategorySelection(
  selection: CategorySelection,
): CategoryValidationIssue[] {
  const issues: CategoryValidationIssue[] = [];

  if (!selection.primaryId) {
    issues.push({ code: "no_primary" });
  } else if (!isKnownCategoryId(selection.primaryId)) {
    issues.push({ code: "unknown_id", id: selection.primaryId });
  }

  if (selection.secondaryIds.length > GMB_MAX_SECONDARY_CATEGORIES) {
    issues.push({ code: "too_many_secondary", count: selection.secondaryIds.length });
  }

  const seen = new Set<string>();
  for (const id of selection.secondaryIds) {
    if (selection.primaryId === id) {
      issues.push({ code: "primary_in_secondary", id });
    }
    if (seen.has(id)) {
      issues.push({ code: "duplicate_id", id });
    } else {
      seen.add(id);
    }
    if (!isKnownCategoryId(id)) {
      issues.push({ code: "unknown_id", id });
    }
  }

  return issues;
}
