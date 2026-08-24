import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "../config/db.config";

function requireLocalExecution(): void {
  if (process.env.SALES_AUTH_LOCAL_SMOKE !== "true") {
    throw new Error("Set SALES_AUTH_LOCAL_SMOKE=true to run this local-only test");
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
    throw new Error("Sales auth smoke test refuses non-local databases");
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
  const headers = new Headers({ Origin: "http://localhost:3003" });
  if (input.cookie) headers.set("Cookie", input.cookie);
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`http://localhost:3003${input.path}`, {
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
const userIds: string[] = [];

try {
  const accounts = [
    { email: `sales-auth-${suffix}@example.invalid`, role: "SALES" as const, enabled: true },
    { email: `sales-disabled-${suffix}@example.invalid`, role: "SALES" as const, enabled: false },
    { email: `sales-user-${suffix}@example.invalid`, role: "USER" as const, enabled: true },
  ];
  for (const account of accounts) {
    const user = await prisma.user.create({
      data: {
        email: account.email,
        name: "Local sales auth smoke",
        emailVerified: true,
        role: account.role,
        commandPanelEnabled: account.enabled,
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
    body: { email: accounts[0]!.email, password },
  });
  expectStatus(signIn, 200, "enabled sales sign-in");
  const cookie = cookieHeader(signIn);
  if (!cookie.includes("uplift-sales") || cookie.includes("better-auth")) {
    throw new Error("sales sign-in returned the wrong cookie namespace");
  }

  expectStatus(
    await request({ path: "/api/authz", cookie }),
    200,
    "sales authorization context",
  );
  expectStatus(
    await request({ path: "/api/customers/search?q=no-match", cookie }),
    200,
    "sales backend cookie relay",
  );

  for (const account of accounts.slice(1)) {
    const denied = await request({
      path: "/api/auth/sign-in/email",
      method: "POST",
      body: { email: account.email, password },
    });
    if (denied.status < 400 || cookieHeader(denied)) {
      throw new Error("non-sales or disabled account received a sales session");
    }
  }

  const crossOrigin = await fetch("http://localhost:3003/api/assignments", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://localhost:3001",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ businessId: "not-used" }),
  });
  expectStatus(crossOrigin, 403, "cross-origin sales mutation");

  expectStatus(
    await request({ path: "/api/auth/sign-out", method: "POST", cookie, body: {} }),
    200,
    "sales sign-out",
  );
  expectStatus(
    await request({ path: "/api/authz", cookie }),
    403,
    "revoked sales session replay",
  );

  console.log(JSON.stringify({
    success: true,
    checks: [
      "sales-cookie-isolation",
      "database-role-and-enable-gate",
      "backend-cookie-relay",
      "non-sales-denied",
      "disabled-sales-denied",
      "cross-origin-mutation-denied",
      "sign-out-revocation",
    ],
  }));
} finally {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
