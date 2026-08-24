import { createHash } from "node:crypto";

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

console.info("Admin API surface and schema snapshot checks passed.");
