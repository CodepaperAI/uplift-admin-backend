import type { Request, Response } from "express";
import { connect } from "framer-api";
import {
  applyPublicRateLimitHeaders,
  buildPublicRateLimitError,
  evaluatePublicRateLimit,
} from "../utils/public-rate-limit.utils";

/**
 * POST /api/public/v1/framer-plugin/validate-key
 *
 * Tests a user-provided Framer API key + project URL/ID, returns the list of
 * CMS collections with auto-discovered field mappings. Unauthenticated but
 * rate-limited aggressively (Framer's API enforces its own limits too).
 */

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

interface ValidateResult {
  ok: boolean;
  siteName?: string;
  siteUrl?: string;
  collections: Array<{
    id: string;
    name: string;
    fieldCount: number;
    mapping: {
      titleFieldId?: string;
      contentFieldId?: string;
      excerptFieldId?: string;
      imageFieldId?: string;
      tagsFieldId?: string;
    };
    mappingComplete: boolean;
  }>;
}

function normaliseProjectUrl(projectId: string): string {
  const trimmed = projectId.trim();
  if (trimmed.startsWith("http")) return trimmed;
  return `https://framer.com/projects/${trimmed.replace(/^\/+/, "")}`;
}

function discoverMapping(fields: Array<{ id: string; name: string }>) {
  const mapping: ValidateResult["collections"][number]["mapping"] = {};
  for (const field of fields) {
    const name = field.name.toLowerCase().trim();
    if (!mapping.titleFieldId && ["title", "name", "post title", "blog title"].includes(name)) {
      mapping.titleFieldId = field.id;
    }
    if (
      !mapping.contentFieldId &&
      ["content", "body", "post body", "article", "blog content"].includes(name)
    ) {
      mapping.contentFieldId = field.id;
    }
    if (
      !mapping.excerptFieldId &&
      ["excerpt", "summary", "description", "short description"].includes(name)
    ) {
      mapping.excerptFieldId = field.id;
    }
    if (
      !mapping.imageFieldId &&
      ["featured image", "cover", "thumbnail", "image", "hero image", "cover image", "hero"].includes(
        name
      )
    ) {
      mapping.imageFieldId = field.id;
    }
    if (!mapping.tagsFieldId && ["tags", "categories", "labels", "topic", "topics"].includes(name)) {
      mapping.tagsFieldId = field.id;
    }
  }
  return mapping;
}

export async function framerPluginValidateKey(req: Request, res: Response) {
  try {
    const { apiKey, projectId } = req.body ?? {};

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !["apiKey", "projectId"].includes(key))
    ) {
      return res.status(400).json({ code: "invalid", title: "Invalid request" });
    }

    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4_096) {
      return res.status(400).json({ code: "invalid", title: "apiKey is required" });
    }
    if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 512) {
      return res.status(400).json({ code: "invalid", title: "projectId is required" });
    }

    const clientIp =
      req.ip || (req.headers["x-forwarded-for"]?.toString() ?? "unknown");
    const rateLimit = evaluatePublicRateLimit({
      store: rateLimitMap,
      key: clientIp,
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
    });
    applyPublicRateLimitHeaders(res, rateLimit);

    if (!rateLimit.allowed) {
      return res
        .status(429)
        .json(
          buildPublicRateLimitError({
            scope: "public_audit",
            status: rateLimit,
            resourceLabel: "Framer key validations",
            actionLabel: "validate another key",
            windowLabel: "hour",
          })
        );
    }

    let framer: any;
    try {
      framer = await connect(normaliseProjectUrl(projectId), apiKey.trim());
    } catch (err: any) {
      const message = String(err?.message || "").toLowerCase();
      const code = message.includes("unauthorized") || message.includes("invalid")
        ? "invalid"
        : message.includes("permission")
        ? "permissions"
        : message.includes("expired")
        ? "expired"
        : message.includes("not found") || message.includes("project")
        ? "wrong_project"
        : "network";
      console.warn("[Framer Plugin Validate] Provider rejected credentials", {
        code,
      });
      return res.status(400).json({ code, title: "Framer rejected the key" });
    }

    try {
      const collectionsRaw = (await framer.getCollections()) as Array<{ id: string; name: string }>;
      const collections: ValidateResult["collections"] = [];
      for (const c of collectionsRaw) {
        try {
          const collection = await framer.getCollection(c.id);
          const fields = (await collection.getFields()) as Array<{ id: string; name: string }>;
          const mapping = discoverMapping(fields);
          const mappingComplete = Boolean(mapping.titleFieldId && mapping.contentFieldId);
          collections.push({
            id: c.id,
            name: c.name,
            fieldCount: fields.length,
            mapping,
            mappingComplete,
          });
        } catch {
          collections.push({
            id: c.id,
            name: c.name,
            fieldCount: 0,
            mapping: {},
            mappingComplete: false,
          });
        }
      }

      return res.json({
        ok: true,
        collections,
      } satisfies ValidateResult);
    } finally {
      try {
        await framer.disconnect?.();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.error("[Framer Plugin Validate]", err);
    return res.status(500).json({ code: "network", title: "Could not validate key" });
  }
}
