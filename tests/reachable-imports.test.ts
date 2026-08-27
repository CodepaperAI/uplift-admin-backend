import { describe, expect, it } from "bun:test";
import {
  isBuiltin,
  packageNameOf,
  walkReachableImports,
} from "../scripts/reachable-imports";

/**
 * This walker decides which packages the production image installs, so a hole in
 * it ships a container that cannot boot. The cases below are the forms that
 * actually appear in this tree.
 */

function graphOf(files: Record<string, string>) {
  const key = (path: string) => path.replace("/repo/", "");
  return walkReachableImports({
    root: "/repo",
    entrypoint: "index.ts",
    fileExists: (path) => key(path) in files,
    readFile: (path) => {
      const source = files[key(path)];
      if (source === undefined) throw new Error(`no such file: ${path}`);
      return source;
    },
  });
}

describe("packageNameOf", () => {
  it("keeps the scope on scoped packages", () => {
    expect(packageNameOf("@prisma/adapter-pg")).toBe("@prisma/adapter-pg");
    expect(packageNameOf("@langchain/core/documents")).toBe("@langchain/core");
  });

  it("drops the deep path on unscoped packages", () => {
    expect(packageNameOf("stripe")).toBe("stripe");
    expect(packageNameOf("better-auth/node")).toBe("better-auth");
  });
});

describe("isBuiltin", () => {
  it("accepts builtins with and without the node: prefix", () => {
    expect(isBuiltin("node:crypto")).toBe(true);
    expect(isBuiltin("crypto")).toBe(true);
    expect(isBuiltin("bun:test")).toBe(true);
  });

  it("does not mistake a package for a builtin", () => {
    expect(isBuiltin("stripe")).toBe(false);
    // The npm package that shadows the builtin's name is still a package.
    expect(isBuiltin("puppeteer")).toBe(false);
  });
});

describe("walkReachableImports", () => {
  it("records bare imports and does not follow them", () => {
    const graph = graphOf({
      "index.ts": 'import express from "express";\n',
    });
    expect([...graph.packages.keys()]).toEqual(["express"]);
    expect(graph.files).toEqual(["/repo/index.ts"]);
  });

  it("follows relative imports transitively", () => {
    const graph = graphOf({
      "index.ts": 'import "./src/a";\n',
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": 'import stripe from "stripe";\n',
    });
    expect([...graph.packages.keys()]).toEqual(["stripe"]);
    expect(graph.packages.get("stripe")).toEqual(["src/b.ts"]);
  });

  it("does not reach a package behind a file the entrypoint never imports", () => {
    // The whole point: puppeteer lives in this tree but nothing loads it.
    const graph = graphOf({
      "index.ts": 'import "./src/served";\n',
      "src/served.ts": 'import express from "express";\n',
      "src/orphan.ts": 'import puppeteer from "puppeteer-extra";\n',
    });
    expect(graph.packages.has("puppeteer-extra")).toBe(false);
  });

  it("sees re-exports, type-only imports, dynamic imports and require", () => {
    const graph = graphOf({
      "index.ts": [
        'export { thing } from "./src/re-export";',
        'import type { Browser } from "some-types";',
        'const late = await import("lazy-package");',
        'const old = require("legacy-package");',
      ].join("\n"),
      "src/re-export.ts": 'import "redis";\n',
    });
    expect([...graph.packages.keys()].sort()).toEqual([
      "lazy-package",
      "legacy-package",
      "redis",
      "some-types",
    ]);
  });

  it("resolves a directory import to its index file", () => {
    const graph = graphOf({
      "index.ts": 'import "./src/routes";\n',
      "src/routes/index.ts": 'import "cors";\n',
    });
    expect([...graph.packages.keys()]).toEqual(["cors"]);
  });

  it("reports a relative import that resolves to nothing", () => {
    const graph = graphOf({ "index.ts": 'import "./src/missing";\n' });
    expect(graph.unresolved).toEqual(["index.ts -> ./src/missing"]);
  });

  it("survives an import cycle", () => {
    const graph = graphOf({
      "index.ts": 'import "./src/a";\n',
      "src/a.ts": 'import "./b";\nimport "zod";\n',
      "src/b.ts": 'import "./a";\n',
    });
    expect([...graph.packages.keys()]).toEqual(["zod"]);
    expect(graph.files.length).toBe(3);
  });

  it("ignores a specifier inside a comment only when it is not an import", () => {
    // Deliberately loose: a commented-out import is still reported, because
    // being conservative here costs a dependency entry and being wrong costs a
    // boot failure.
    const graph = graphOf({
      "index.ts": '// see https://example.com/docs\nimport "stripe";\n',
    });
    expect([...graph.packages.keys()]).toEqual(["stripe"]);
  });
});
