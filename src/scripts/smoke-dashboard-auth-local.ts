import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "../config/db.config";

function requireLocalExecution(): void {
  if (process.env.DASHBOARD_AUTH_LOCAL_SMOKE !== "true") {
    throw new Error(
      "Set DASHBOARD_AUTH_LOCAL_SMOKE=true to run this local-only test",
    );
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
    throw new Error("Dashboard auth smoke test refuses non-local databases");
  }
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const source = values.length > 0
    ? values
    : response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie")!]
      : [];
  return source
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function request(input: {
  path: string;
  method?: string;
  cookie?: string;
  body?: unknown;
}): Promise<Response> {
  const headers = new Headers({ Origin: "http://localhost:3001" });
  if (input.cookie) headers.set("Cookie", input.cookie);
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`http://localhost:3001${input.path}`, {
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
const email = `dashboard-auth-${suffix}@example.invalid`;
let userId: string | null = null;

try {
  const user = await prisma.user.create({
    data: {
      email,
      name: "Local dashboard auth smoke",
      emailVerified: true,
      role: "USER",
    },
    select: { id: true },
  });
  userId = user.id;
  await prisma.account.create({
    data: {
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: passwordHash,
    },
  });

  const signIn = await request({
    path: "/api/auth/sign-in/email",
    method: "POST",
    body: { email, password },
  });
  expectStatus(signIn, 200, "dashboard sign-in");
  const cookie = cookieHeader(signIn);
  if (!cookie.includes("better-auth") || cookie.includes("uplift-command")) {
    throw new Error("dashboard sign-in returned the wrong session cookie surface");
  }

  const session = await request({ path: "/api/auth/get-session", cookie });
  expectStatus(session, 200, "dashboard session read");
  const sessionPayload = (await session.json()) as { user?: { id?: string } };
  if (sessionPayload.user?.id !== user.id) {
    throw new Error("dashboard session resolved the wrong identity");
  }

  const context = await request({ path: "/api/auth/me", cookie });
  expectStatus(context, 200, "backend-owned account context");
  const contextPayload = (await context.json()) as { id?: string; role?: string };
  if (contextPayload.id !== user.id || contextPayload.role !== "USER") {
    throw new Error("account context did not use the database role source of truth");
  }

  const superadmin = await request({
    path: "/api/backend/superadmin/metrics/overview",
    cookie,
  });
  expectStatus(superadmin, 403, "USER-to-SUPERADMIN privilege escalation");

  const signOut = await request({
    path: "/api/auth/sign-out",
    method: "POST",
    cookie,
    body: {},
  });
  expectStatus(signOut, 200, "dashboard sign-out");

  const afterSignOut = await request({ path: "/api/auth/me", cookie });
  expectStatus(afterSignOut, 401, "revoked dashboard session replay");

  console.log(
    JSON.stringify({
      success: true,
      checks: [
        "dashboard-cookie-isolation",
        "backend-session-resolution",
        "database-role-source-of-truth",
        "superadmin-escalation-denied",
        "sign-out-revocation",
      ],
    }),
  );
} finally {
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
