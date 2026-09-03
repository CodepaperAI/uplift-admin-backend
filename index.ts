import { randomUUID } from "node:crypto";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
  urlencoded,
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { toNodeHandler } from "better-auth/node";
import { adminAuth, ADMIN_AUTH_PATH } from "./src/auth/admin-auth";
import { prisma } from "./src/config/db.config";
import { getAdminAuthContext } from "./src/controllers/admin-auth.controller";
import CommandRouter from "./src/routes/command.routes";
import PublicStatusProbeRouter from "./src/routes/public-status-probe.routes";
import SuperAdminRouter from "./src/routes/superadmin.routes";
import { configuredCorsOrigins } from "./src/admin-api-config";
import { checkTenantCacheReadiness } from "./src/utils/tenant-response-cache";

function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function createApp(): Application {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);

  /**
   * Every response on this API is JSON, and the panel's JSON is repetitive
   * enough to compress by roughly an order of magnitude: the Command overview
   * ships a few hundred roster rows whose keys repeat on every one.
   *
   * This sits ahead of the routers so it covers all of them rather than the
   * handful anyone thought to wrap. Node's fetch — which is what both the Vercel
   * server components and the panel relay use — already sends
   * `accept-encoding: gzip, deflate` and decodes transparently, so no caller
   * changes with it. `compression` sets `Vary: Accept-Encoding` itself, which
   * matters because a cache in front of this must not hand a gzipped body to a
   * client that did not ask for one.
   *
   * The 1 KB floor is the library default and the right one: below it the gzip
   * header costs more than the saving.
   */
  app.use(compression({ threshold: 1024 }));

  const allowedOrigins = configuredCorsOrigins();
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
      credentials: true,
      optionsSuccessStatus: 204,
    }),
  );

  app.use((req, res, next) => {
    const startedAt = performance.now();
    const requestId = req.header("x-request-id")?.trim() || randomUUID();
    res.setHeader("X-Request-Id", requestId);
    /**
     * How long the server itself took, on the response.
     *
     * The `finish` handler below cannot carry this: it runs after the headers
     * are on the wire. Wrapping `writeHead` is the last moment a header can
     * still be added, which makes the number available to anyone holding the
     * response — `curl -D -`, browser devtools — instead of only to whoever can
     * read CloudWatch. Separating server time from network time is most of
     * diagnosing "the panel feels slow".
     */
    const writeHead = res.writeHead.bind(res);
    res.writeHead = ((...args: Parameters<typeof writeHead>) => {
      if (!res.headersSent) {
        res.setHeader(
          "Server-Timing",
          `app;dur=${Math.round((performance.now() - startedAt) * 10) / 10}`,
        );
      }
      return writeHead(...args);
    }) as typeof res.writeHead;
    res.on("finish", () => {
      console.info(
        JSON.stringify({
          level: "info",
          service: "seo-admin-api",
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        }),
      );
    });
    next();
  });

  // Better Auth must receive the raw stream before Express body parsing.
  app.get(`${ADMIN_AUTH_PATH}/context`, getAdminAuthContext);
  app.use(ADMIN_AUTH_PATH, toNodeHandler(adminAuth));

  app.use(express.json({ limit: "1mb" }));
  app.use(urlencoded({ extended: false }));
  app.use(cookieParser());

  app.get("/health/live", (_req, res) => {
    res.status(200).json({ ok: true, service: "seo-admin-api" });
  });
  app.get("/health/ready", async (_req, res) => {
    try {
      const [databaseReady, cacheReady] = await Promise.all([
        prisma.$queryRaw`SELECT 1`.then(() => true),
        checkTenantCacheReadiness(),
      ]);
      if (!databaseReady || !cacheReady) {
        res.status(503).json({ ok: false, service: "seo-admin-api" });
        return;
      }
      res.status(200).json({ ok: true, service: "seo-admin-api" });
    } catch {
      res.status(503).json({ ok: false, service: "seo-admin-api" });
    }
  });
  app.get("/api/v1", (_req, res) => {
    res.status(200).json({ ok: true, service: "seo-admin-api", version: "v1" });
  });

  app.use("/api/v1/command", CommandRouter);
  app.use("/api/v1/status/components", PublicStatusProbeRouter);
  app.use("/api/v1/superadmin/agencies", SuperAdminRouter);

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: "Not found" });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(
      JSON.stringify({
        level: "error",
        service: "seo-admin-api",
        message: error instanceof Error ? error.message : "Unhandled request error",
      }),
    );
    res.status(500).json({ success: false, error: "Internal server error" });
  });
  return app;
}

const configuredPort = Number(process.env.PORT);
export const PORT =
  Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
    ? configuredPort
    : 3000;

if (import.meta.main) {
  const app = createApp();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.info(
      JSON.stringify({ level: "info", service: "seo-admin-api", event: "started", port: PORT }),
    );
  });

  const shutdown = (signal: string) => {
    console.info(
      JSON.stringify({ level: "info", service: "seo-admin-api", event: "shutdown", signal }),
    );
    server.close(async () => {
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
