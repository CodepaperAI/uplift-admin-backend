import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "../config/db.config";

type Fixture = {
  runId: string;
  password: string;
  users: Record<"superadmin" | "admin" | "sales" | "user", {
    id: string;
    email: string;
    repId: string | null;
  }>;
};

const smokeIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;

function requireLocalExecution(): void {
  if (process.env.COMMAND_ROLES_LOCAL_SMOKE !== "true") {
    throw new Error("Set COMMAND_ROLES_LOCAL_SMOKE=true to run this local-only test");
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
    throw new Error("Command role smoke test refuses non-local databases");
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
  const headers = new Headers({
    Origin: "http://localhost:3002",
    "X-Real-IP": smokeIp,
  });
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

async function createFixture(runId = randomUUID()): Promise<Fixture> {
  const password = `Aa9!${randomBytes(24).toString("base64url")}`;
  const passwordHash = await hashPassword(password);
  const definitions = [
    { key: "superadmin" as const, role: "SUPERADMIN" as const },
    { key: "admin" as const, role: "ADMIN" as const },
    { key: "sales" as const, role: "SALES" as const },
    { key: "user" as const, role: "USER" as const },
  ];
  const users = {} as Fixture["users"];
  for (const definition of definitions) {
    const email = `command-roles-${runId}-${definition.key}@example.invalid`;
    const user = await prisma.user.create({
      data: {
        email,
        name: `Command ${definition.key} smoke`,
        emailVerified: true,
        role: definition.role,
        commandPanelEnabled: true,
      },
      select: { id: true },
    });
    await prisma.account.create({
      data: {
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: passwordHash,
      },
    });
    const rep = definition.key === "sales" || definition.key === "user"
      ? await prisma.commandRepProfile.create({
          data: {
            userId: user.id,
            name: `Command ${definition.key} smoke`,
            basePay: definition.key === "sales" ? "2500" : null,
            currency: definition.key === "sales" ? "cad" : null,
            startDate: new Date("2026-01-01T12:00:00.000Z"),
            isActive: true,
          },
          select: { id: true },
        })
      : null;
    users[definition.key] = { id: user.id, email, repId: rep?.id ?? null };
  }
  return { runId, password, users };
}

function fixtureEmails(runId: string): string[] {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Invalid smoke run id");
  return ["superadmin", "admin", "sales", "user"].map(
    (key) => `command-roles-${runId}-${key}@example.invalid`,
  );
}

async function cleanup(runId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { email: { in: fixtureEmails(runId) } } });
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await request({
    path: "/api/auth/sign-in/email",
    method: "POST",
    body: { email, password },
  });
  expectStatus(response, 200, `${email} sign-in`);
  const cookie = cookieHeader(response);
  if (!cookie.includes("uplift-command")) {
    throw new Error(`${email} did not receive the isolated Command cookie`);
  }
  return cookie;
}

async function verifyFixture(fixture: Fixture): Promise<string[]> {
  const checks: string[] = [];
  for (const key of ["superadmin", "admin", "sales", "user"] as const) {
    const account = fixture.users[key];
    const cookie = await signIn(account.email, fixture.password);
    const session = await request({ path: "/api/backend/command/session", cookie });
    expectStatus(session, 200, `${key} Command session`);
    const sessionPayload = (await session.json()) as {
      data?: { role?: string; repId?: string | null; capabilities?: string[] };
    };
    if (sessionPayload.data?.role?.toLowerCase() !== key) {
      throw new Error(`${key} session resolved the wrong current database role`);
    }
    if (account.repId && sessionPayload.data?.repId !== account.repId) {
      throw new Error(`${key} session did not resolve its database rep identity`);
    }

    if (key === "superadmin") {
      expectStatus(
        await request({ path: "/api/backend/command/access", cookie }),
        200,
        "SUPERADMIN permission matrix",
      );
      expectStatus(
        await request({ path: "/api/backend/command/settings", cookie }),
        200,
        "SUPERADMIN commission settings",
      );
      checks.push("superadmin-full-control");
    }

    if (key === "admin") {
      expectStatus(
        await request({ path: "/api/backend/command/services", cookie }),
        200,
        "ADMIN service reporting",
      );
      expectStatus(
        await request({ path: "/api/backend/command/services", method: "POST", cookie, body: {} }),
        403,
        "ADMIN commission-rate mutation",
      );
      expectStatus(
        await request({ path: "/api/backend/command/access", cookie }),
        403,
        "ADMIN permission-matrix access",
      );
      checks.push("admin-operational-without-rate-or-role-control");
    }

    if (key === "sales") {
      expectStatus(
        await request({ path: "/api/backend/command/deals", cookie }),
        200,
        "SALES own deals",
      );
      expectStatus(
        await request({ path: "/api/backend/command/commissions", cookie }),
        200,
        "SALES own commission",
      );
      expectStatus(
        await request({ path: `/api/backend/command/commissions?repId=${fixture.users.user.repId}`, cookie }),
        403,
        "SALES cross-rep commission",
      );
      expectStatus(
        await request({ path: "/api/backend/command/stripe/overview", cookie }),
        403,
        "SALES company financials",
      );
      expectStatus(
        await request({ path: "/api/backend/command/calls", cookie }),
        403,
        "SALES coaching before approval and capability grant",
      );
      checks.push("sales-own-financial-scope");
    }

    if (key === "user") {
      expectStatus(
        await request({ path: "/api/backend/command/pipeline", cookie }),
        200,
        "USER own operational pipeline",
      );
      expectStatus(
        await request({ path: "/api/backend/command/deals", cookie }),
        403,
        "USER deal money",
      );
      expectStatus(
        await request({ path: "/api/backend/command/commissions", cookie }),
        403,
        "USER commission",
      );
      expectStatus(
        await request({ path: `/api/backend/command/commissions?repId=${account.repId}`, cookie }),
        403,
        "USER explicit own commission",
      );
      expectStatus(
        await request({ path: "/api/backend/command/calls", cookie }),
        403,
        "USER coaching",
      );
      checks.push("general-user-operational-only");
    }

    expectStatus(
      await request({ path: "/api/auth/sign-out", method: "POST", cookie, body: {} }),
      200,
      `${key} sign-out`,
    );
  }
  return checks;
}

requireLocalExecution();
const mode = process.argv[2] ?? "verify";

try {
  if (mode === "cleanup") {
    const runId = process.argv[3];
    if (!runId) throw new Error("cleanup requires a smoke run id");
    await cleanup(runId);
    console.log(JSON.stringify({ success: true, cleaned: runId }));
  } else if (mode === "seed") {
    const fixture = await createFixture();
    console.log(JSON.stringify({ success: true, fixture }));
  } else if (mode === "verify") {
    const fixture = await createFixture();
    try {
      const checks = await verifyFixture(fixture);
      console.log(JSON.stringify({ success: true, checks }));
    } finally {
      await cleanup(fixture.runId);
    }
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
} finally {
  await prisma.$disconnect();
}
