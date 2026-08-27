import { createHash } from "node:crypto";
import { walkReachableImports } from "./reachable-imports";

const expectedSchemaHash =
  "b9482f66fd73d678fa61456bda78d51c47980c992d44d6ac20f70a9d59fa2191";
const expectedRdsCaHash =
  "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";
const entrypoint = await Bun.file("index.ts").text();
const packageJson = await Bun.file("package.json").json();
const schema = await Bun.file("prisma/schema.prisma").arrayBuffer();
const rdsCaBundle = await Bun.file("certs/aws-rds-global-bundle.pem").arrayBuffer();

const forbiddenEntrypointTokens = [
  'from "./src/routes"',
  'from "./src/inngest/serve"',
  'from "./src/inngest/client"',
  "DashboardRouter",
  "SalesPanelRouter",
  "PublicApiRouter",
  'app.use("/api/inngest"',
  'app.use("/api/public',
];
for (const token of forbiddenEntrypointTokens) {
  if (entrypoint.includes(token)) {
    throw new Error(`Admin surface violation: entrypoint contains ${token}`);
  }
}

for (const route of [
  'app.use("/api/v1/command"',
  'app.use("/api/v1/superadmin/agencies"',
  "app.use(ADMIN_AUTH_PATH",
]) {
  if (!entrypoint.includes(route)) {
    throw new Error(`Admin surface violation: missing ${route}`);
  }
}

if (Object.keys(packageJson.scripts ?? {}).some((name) => name.includes("migrate"))) {
  throw new Error("Admin API must not own or run Prisma migrations");
}

const actualSchemaHash = createHash("sha256")
  .update(new Uint8Array(schema))
  .digest("hex");
if (actualSchemaHash !== expectedSchemaHash) {
  throw new Error(
    "Prisma schema snapshot changed. Refresh it from the canonical seo-be schema and update provenance deliberately.",
  );
}

const actualRdsCaHash = createHash("sha256")
  .update(new Uint8Array(rdsCaBundle))
  .digest("hex");
if (actualRdsCaHash !== expectedRdsCaHash) {
  throw new Error(
    "AWS RDS CA bundle changed. Refresh it deliberately from the canonical infrastructure source.",
  );
}

/**
 * Everything the entrypoint can load must be installed in the image.
 *
 * The production image runs `bun install --production`, so `dependencies` is the
 * whole runtime closure. That is deliberate: the fork inherited 37 packages from
 * seo-be and the admin API can reach 15 of them, and the 22 it cannot were
 * putting their vulnerabilities on the deploy gate — nine unfixable criticals on
 * puppeteer, in an image with no Chromium and no reachable code that could
 * launch it.
 *
 * The saving is only safe while the split stays true, and nothing about an
 * `import` tells you which side of it you are on. So the closure is recomputed
 * here on every build: reach for a devDependency from anything the entrypoint
 * can load and this fails, rather than the container failing on boot.
 */
const runtimeDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
const graph = walkReachableImports({ root: process.cwd(), entrypoint: "index.ts" });

const undeclared: string[] = [];
for (const [name, importers] of graph.packages) {
  if (runtimeDependencies.has(name)) continue;
  const where = importers.slice(0, 3).join(", ");
  const more = importers.length > 3 ? ` (+${importers.length - 3} more)` : "";
  undeclared.push(`  ${name} — imported by ${where}${more}`);
}
if (undeclared.length > 0) {
  throw new Error(
    [
      `Admin surface violation: ${undeclared.length} package(s) are reachable from index.ts but absent from "dependencies", so the production image would not contain them:`,
      ...undeclared,
      "",
      'Either move the package into "dependencies", or stop the entrypoint reaching the code that imports it.',
    ].join("\n"),
  );
}

if (graph.unresolved.length > 0) {
  throw new Error(
    [
      "Admin surface violation: relative imports that resolve to nothing on disk:",
      ...graph.unresolved.slice(0, 10).map((entry) => `  ${entry}`),
    ].join("\n"),
  );
}

console.info(
  `Admin API surface and schema snapshot checks passed. Entrypoint reaches ${graph.files.length} files and ${graph.packages.size} of ${runtimeDependencies.size} runtime dependencies.`,
);
