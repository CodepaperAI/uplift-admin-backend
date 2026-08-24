import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "../config/db.config";

function requireLocalExecution(): void {
  if (process.env.ADMIN_AUTH_LOCAL_SMOKE !== "true") {
    throw new Error("Set ADMIN_AUTH_LOCAL_SMOKE=true to run this local-only test");
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)) {
    throw new Error("Admin auth smoke test refuses non-local databases");
  }
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function request(input: {
  path: string;
  method?: string;
  cookie?: string;
  body?: unknown;
}): Promise<Response> {
  const headers = new Headers({ Origin: "http://localhost:3002" });
  if (input.cookie) headers.set("Cookie", input.cookie);
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`http://localhost:3002${input.path}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    redirect: "manual",
  });
}

function expectStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${response.status}`);
  }
}

requireLocalExecution();

const suffix = randomUUID();
const password = `Aa9!${randomBytes(24).toString("base64url")}`;
const passwordHash = await hashPassword(password);
const allowedEmail = `admin-auth-allowed-${suffix}@example.invalid`;
const deniedEmail = `admin-auth-denied-${suffix}@example.invalid`;
const userIds: string[] = [];

try {
  for (const entry of [
    { email: allowedEmail, role: "ADMIN" as const, commandPanelEnabled: true },
    { email: deniedEmail, role: "USER" as const, commandPanelEnabled: false },
  ]) {
    const user = await prisma.user.create({
      data: {
        email: entry.email,
        name: "Local admin auth smoke",
        emailVerified: true,
        role: entry.role,
        commandPanelEnabled: entry.commandPanelEnabled,
      },
      select: { id: true },
    });
    userIds.push(user.id);
    await prisma.account.create({
      data: {
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: passwordHash,
      },
    });
  }

  const signIn = await request({
    path: "/api/auth/sign-in/email",
    method: "POST",
    body: { email: allowedEmail, password },
  });
  expectStatus(signIn, 200, "enabled admin sign-in");
  const cookie = cookieHeader(signIn);
  if (!cookie.includes("uplift-command")) {
    throw new Error("enabled admin sign-in did not return the isolated admin cookie");
  }

  const command = await request({ path: "/api/backend/command/session", cookie });
  expectStatus(command, 200, "enabled admin Command session");
  const commandPayload = (await command.json()) as { data?: { role?: string } };
  if (commandPayload.data?.role !== "ADMIN") {
    throw new Error("Command session did not resolve the current backend role");
  }

  const superadmin = await request({
    path: "/api/backend/superadmin/metrics/overview",
    cookie,
  });
  expectStatus(superadmin, 403, "ADMIN-to-SUPERADMIN privilege escalation");

  const deniedSignIn = await request({
    path: "/api/auth/sign-in/email",
    method: "POST",
    body: { email: deniedEmail, password },
  });
  if (deniedSignIn.status < 400 || cookieHeader(deniedSignIn)) {
    throw new Error("disabled Command user unexpectedly received an admin session");
  }

  const signOut = await request({
    path: "/api/auth/sign-out",
    method: "POST",
    cookie,
    body: {},
  });
  expectStatus(signOut, 200, "admin sign-out");

  const afterSignOut = await request({
    path: "/api/backend/command/session",
    cookie,
  });
  expectStatus(afterSignOut, 401, "revoked admin session replay");

  console.log(
    JSON.stringify({
      success: true,
      checks: [
        "isolated-cookie",
        "backend-role",
        "superadmin-escalation-denied",
        "disabled-user-denied",
        "sign-out-revocation",
      ],
    }),
  );
} finally {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
