import { describe, expect, it } from "bun:test";
import z from "zod";
import {
  getWebsiteDataToolSchema,
  saveBusinessDataToolSchema,
} from "../tools/llm.tools";

function collectFormatPaths(
  schema: unknown,
  currentPath = "",
  matches: string[] = [],
): string[] {
  if (!schema || typeof schema !== "object") {
    return matches;
  }

  const record = schema as Record<string, unknown>;
  if ("format" in record) {
    matches.push(currentPath || "root");
  }

  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectFormatPaths(item, `${currentPath}.${key}[${index}]`, matches);
      });
      continue;
    }

    collectFormatPaths(
      value,
      currentPath ? `${currentPath}.${key}` : key,
      matches,
    );
  }

  return matches;
}

function collectPropertyNamesPaths(
  schema: unknown,
  currentPath = "",
  matches: string[] = [],
): string[] {
  if (!schema || typeof schema !== "object") {
    return matches;
  }

  const record = schema as Record<string, unknown>;
  if ("propertyNames" in record) {
    matches.push(currentPath || "root");
  }

  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectPropertyNamesPaths(item, `${currentPath}.${key}[${index}]`, matches);
      });
      continue;
    }

    collectPropertyNamesPaths(
      value,
      currentPath ? `${currentPath}.${key}` : key,
      matches,
    );
  }

  return matches;
}

function expectAllObjectPropertiesRequired(schema: unknown): void {
  if (!schema || typeof schema !== "object") {
    return;
  }

  const record = schema as Record<string, unknown>;
  if (record.type === "object" && record.properties) {
    const propertyKeys = Object.keys(record.properties as Record<string, unknown>);
    const requiredKeys = Array.isArray(record.required) ? record.required : [];

    expect(requiredKeys).toEqual(propertyKeys);

    for (const value of Object.values(
      record.properties as Record<string, unknown>,
    )) {
      expectAllObjectPropertiesRequired(value);
    }
  }

  for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      value.forEach((item) => expectAllObjectPropertiesRequired(item));
    } else {
      expectAllObjectPropertiesRequired(value);
    }
  }
}

describe("get-website-info tool schema", () => {
  it("does not emit unsupported format values anywhere in the chunk-only schema", () => {
    const jsonSchema = z.toJSONSchema(getWebsiteDataToolSchema);

    expect(collectFormatPaths(jsonSchema)).toEqual([]);
  });

  it("marks only chunk as required in the emitted schema", () => {
    const jsonSchema = z.toJSONSchema(getWebsiteDataToolSchema);

    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.required).toEqual(["chunk"]);
  });

  it("accepts a nullable chunk because the canonical URL comes from runtime context", () => {
    const parsed = getWebsiteDataToolSchema.parse({
      chunk: null,
    });

    expect(parsed).toEqual({
      chunk: null,
    });
  });

  it("does not expose a url field to the model", () => {
    const jsonSchema = z.toJSONSchema(getWebsiteDataToolSchema);

    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toBeTruthy();
    expect(
      jsonSchema.properties && "url" in jsonSchema.properties,
    ).toBe(false);
  });
});

describe("save-business-data-to-database tool schema", () => {
  it("does not emit unsupported format values or propertyNames anywhere in the nested schema", () => {
    const jsonSchema = z.toJSONSchema(saveBusinessDataToolSchema);
    expect(collectFormatPaths(jsonSchema)).toEqual([]);
    expect(collectPropertyNamesPaths(jsonSchema)).toEqual([]);
  });

  it("marks every object property as required to satisfy strict OpenAI tool validation", () => {
    const jsonSchema = z.toJSONSchema(saveBusinessDataToolSchema);
    expectAllObjectPropertiesRequired(jsonSchema);
  });

  it("keeps userId out of the tool schema because runtime injects it from context", () => {
    const jsonSchema = z.toJSONSchema(saveBusinessDataToolSchema);

    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toBeTruthy();
    expect(
      jsonSchema.properties && "userId" in jsonSchema.properties,
    ).toBe(false);
  });
});
