import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * What the entrypoint can actually load.
 *
 * This repo is a fork of seo-be and carries its whole `src/` tree, but the admin
 * API serves three route groups. The production image installs only
 * `dependencies` (see Dockerfile), so a package that is reachable from
 * `index.ts` and *not* declared there is not a lint nit — it is a container that
 * boots into MODULE_NOT_FOUND. This walker is what makes that a build failure
 * instead of a 3am pager.
 *
 * Relative specifiers are followed; bare ones are recorded and not followed,
 * because the question is only ever "which packages does the reachable code
 * need", never "what do those packages themselves need".
 */

const SPECIFIER = new RegExp(
  [
    // import x from "y" / export { x } from "y" / import "y"
    String.raw`(?:^|[\n;])\s*(?:im|ex)port\s+(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']`,
    // await import("y")
    String.raw`\bimport\s*\(\s*["']([^"']+)["']\s*\)`,
    // require("y")
    String.raw`\brequire\s*\(\s*["']([^"']+)["']\s*\)`,
  ].join("|"),
  "g",
);

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const CANDIDATE_INDEXES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

/** True when the path is a file on disk. Injectable so the walker is testable. */
export type FileExists = (path: string) => boolean;

const fileExistsOnDisk: FileExists = (path) => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

function resolveRelative(
  fromFile: string,
  specifier: string,
  fileExists: FileExists,
): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (fileExists(candidate)) return candidate;
  }
  for (const index of CANDIDATE_INDEXES) {
    const candidate = join(base, index);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/** "@scope/pkg/deep/path" -> "@scope/pkg"; "pkg/deep" -> "pkg". */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "bun",
  "bun:test",
]);

export function isBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    BUILTINS.has(packageNameOf(specifier))
  );
}

export type ReachableGraph = {
  /** Absolute paths of every local file the entrypoint can load. */
  files: string[];
  /** Package name -> the reachable files importing it, repo-relative. */
  packages: Map<string, string[]>;
  /** Relative specifiers that resolved to nothing on disk. */
  unresolved: string[];
};

export function walkReachableImports(input: {
  root: string;
  entrypoint: string;
  readFile?: (path: string) => string;
  fileExists?: FileExists;
}): ReachableGraph {
  const read = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const fileExists = input.fileExists ?? fileExistsOnDisk;
  const entry = resolve(input.root, input.entrypoint);
  const files = new Set<string>();
  const packages = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const relativeTo = (path: string) =>
    path.startsWith(`${input.root}/`) ? path.slice(input.root.length + 1) : path;

  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);

    let source: string;
    try {
      source = read(file);
    } catch {
      continue;
    }

    SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        const target = resolveRelative(file, specifier, fileExists);
        if (target) queue.push(target);
        else unresolved.push(`${relativeTo(file)} -> ${specifier}`);
        continue;
      }
      if (isBuiltin(specifier)) continue;
      const name = packageNameOf(specifier);
      const importers = packages.get(name) ?? new Set<string>();
      importers.add(relativeTo(file));
      packages.set(name, importers);
    }
  }

  return {
    files: [...files].sort(),
    packages: new Map(
      [...packages.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, importers]) => [name, [...importers].sort()]),
    ),
    unresolved,
  };
}
