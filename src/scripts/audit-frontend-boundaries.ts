import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type FrontendPolicy = {
  name: string;
  root: string;
  sourceRoots: string[];
  prismaAllowlist: Set<string>;
  secretAllowlist: Map<string, Set<string>>;
  forbidsDatabaseClientDependencies?: boolean;
};

const workspaceRoot = resolve(import.meta.dir, "../../..");
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "prisma",
]);

const policies: FrontendPolicy[] = [
  {
    name: "seo-fe",
    root: join(workspaceRoot, "seo-fe"),
    sourceRoots: ["src"],
    prismaAllowlist: new Set(),
    secretAllowlist: new Map(),
    forbidsDatabaseClientDependencies: true,
  },
  {
    name: "seo-admin",
    root: join(workspaceRoot, "seo-admin"),
    sourceRoots: ["app", "config", "lib"],
    prismaAllowlist: new Set(),
    secretAllowlist: new Map(),
    forbidsDatabaseClientDependencies: true,
  },
  {
    name: "sales-panel",
    root: join(workspaceRoot, "sales-panel"),
    sourceRoots: ["app", "lib"],
    prismaAllowlist: new Set(),
    secretAllowlist: new Map(),
    forbidsDatabaseClientDependencies: true,
  },
];

const forbiddenFrontendDependencies = new Set([
  "@google/genai",
  "@pinecone-database/pinecone",
  "context.dev",
  "openai",
  "redis",
  "stripe",
]);
const sensitiveEnvironmentNames = [
  "BUNNY_STORAGE_ACCESS_KEY",
  "CONTEXT_DEV_API_KEY",
  "DATABASE_URL",
  "GHL_API_KEY",
  "GHL_API_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "INTERNAL_AUTH_EMAIL_SECRET",
  "OPENAI_API_KEY",
  "REDIS_URL",
  "STRIPE_SECRET_KEY",
  "BACKEND_AUTH_SECRET",
  "BETTER_AUTH_SECRET",
] as const;

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if ([...sourceExtensions].some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

async function audit(policy: FrontendPolicy): Promise<string[]> {
  const failures: string[] = [];
  const packageJson = JSON.parse(
    await readFile(join(policy.root, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const dependency of forbiddenFrontendDependencies) {
    if (dependencies[dependency]) {
      failures.push(`${policy.name}: forbidden server dependency ${dependency}`);
    }
  }
  if (policy.forbidsDatabaseClientDependencies) {
    for (const dependency of ["@prisma/adapter-pg", "@prisma/client", "pg", "prisma"]) {
      if (dependencies[dependency]) {
        failures.push(`${policy.name}: forbidden database dependency ${dependency}`);
      }
    }
  }

  const files = (
    await Promise.all(policy.sourceRoots.map((root) => walk(join(policy.root, root))))
  ).flat();
  for (const file of files) {
    const localPath = relative(policy.root, file).replaceAll("\\", "/");
    const source = await readFile(file, "utf8");
    const isTestFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(localPath);
    const importsPrisma =
      /(?:from|import\s*\()\s*["'][^"']*(?:@prisma\/client|(?:^|\/)prisma(?:-client)?)[^"']*["']/.test(
        source,
      ) || /\bPrismaClient\b/.test(source);
    if (importsPrisma && !policy.prismaAllowlist.has(localPath)) {
      failures.push(`${policy.name}/${localPath}: business Prisma access is not allowed`);
    }
    if (
      !isTestFile &&
      /\b(?:createCipheriv|createDecipheriv|privateDecrypt|privateEncrypt)\b/.test(source)
    ) {
      failures.push(`${policy.name}/${localPath}: business cryptography belongs in seo-be`);
    }
    for (const environmentName of sensitiveEnvironmentNames) {
      if (isTestFile) continue;
      if (!source.includes(environmentName)) continue;
      const allowlist = policy.secretAllowlist.get(environmentName);
      if (!allowlist?.has(localPath)) {
        failures.push(
          `${policy.name}/${localPath}: ${environmentName} is outside the approved auth/API boundary`,
        );
      }
    }
  }
  return failures;
}

const failures = (await Promise.all(policies.map(audit))).flat();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  "Frontend boundary audit passed: business data, provider secrets, Redis, and business cryptography remain backend-owned.",
);
