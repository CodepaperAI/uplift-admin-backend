import type { Request, Response } from "express";
import { sendError, sendSuccess } from "../utils/response.utils";
import { GhlReadOnlyClient } from "../command/ghl-readonly.client";

/**
 * What GoHighLevel will and will not tell us about the hosted pages.
 *
 * Exists to settle one question with evidence: can a funnel's tracking code be
 * set through the API, or is it a UI-only setting? Asserting that from memory
 * once was already a mistake, and "you cannot automate this" is exactly the
 * kind of claim that deserves a check rather than a recollection.
 *
 * It also returns each funnel's live path, which answers the other open
 * question — where the booking page actually is, since guessing at URLs found
 * nothing but 404s.
 *
 * **Never returns raw provider objects.** A GHL location record can carry an
 * API key, and a diagnostic that helpfully dumps everything is how a credential
 * ends up in a log or a screenshot. Field *names* are listed so a
 * tracking-code field would be visible if one existed; only an explicit
 * whitelist of harmless values is echoed.
 */

/** Location fields safe to show. Everything else is reported by name only. */
const SAFE_LOCATION_FIELDS = new Set([
  "id",
  "name",
  "domain",
  "country",
  "timezone",
  "website",
]);

/** Anything whose name hints at a secret is not even named, let alone echoed. */
function isSensitiveName(name: string): boolean {
  return /key|token|secret|password|credential|auth/i.test(name);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

export async function getCommandGhlSites(
  req: Request,
  res: Response,
): Promise<void> {
  const token = process.env.GHL_COMMAND_READ_TOKEN?.trim();
  const locationId = process.env.GHL_COMMAND_LOCATION_ID?.trim();
  if (!token || !locationId) {
    sendError(
      res,
      "This service has no GoHighLevel credentials configured. GHL_COMMAND_READ_TOKEN and GHL_COMMAND_LOCATION_ID are set on the service that runs the sync, not on this one.",
      503,
    );
    return;
  }

  const client = new GhlReadOnlyClient({
    token,
    locationId,
    baseUrl: process.env.GHL_COMMAND_API_BASE_URL,
  });

  // Each read is reported on its own: a 404 on funnels is itself the answer to
  // "is this reachable", and one failure must not hide the others.
  const attempt = async <T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<{ label: string; ok: boolean; value?: T; error?: string }> => {
    try {
      return { label, ok: true, value: await run() };
    } catch (error) {
      return {
        label,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const [funnels, location] = await Promise.all([
    attempt("funnels", () => client.funnels()),
    attempt("location", () => client.location()),
  ]);

  const funnelRows = funnels.ok
    ? (funnels.value ?? []).map((raw) => {
        const funnel = raw as Record<string, unknown>;
        return {
          id: typeof funnel._id === "string" ? funnel._id : (funnel.id ?? null),
          name: funnel.name ?? null,
          url: funnel.url ?? null,
          domain: funnel.domain ?? null,
          type: funnel.type ?? null,
          // The whole point: is there anything tracking-shaped on a funnel?
          fieldNames: Object.keys(funnel).filter(
            (key) => !isSensitiveName(key),
          ),
          trackingLikeFields: Object.keys(funnel).filter((key) =>
            /track|script|head|body|pixel|gtm|analytic/i.test(key),
          ),
        };
      })
    : [];

  const locationShape = location.ok
    ? {
        safeValues: Object.fromEntries(
          Object.entries(location.value ?? {}).filter(([key]) =>
            SAFE_LOCATION_FIELDS.has(key),
          ),
        ),
        fieldNames: Object.keys(location.value ?? {})
          .filter((key) => !isSensitiveName(key))
          .map((key) => `${key}: ${describe((location.value ?? {})[key])}`),
        trackingLikeFields: Object.keys(location.value ?? {}).filter((key) =>
          /track|script|head|body|pixel|gtm|analytic/i.test(key),
        ),
        sensitiveFieldsWithheld: Object.keys(location.value ?? {}).filter(
          isSensitiveName,
        ).length,
      }
    : null;

  sendSuccess(
    res,
    {
      reads: [
        { label: "funnels", ok: funnels.ok, error: funnels.error ?? null },
        { label: "location", ok: location.ok, error: location.error ?? null },
      ],
      funnelCount: funnelRows.length,
      funnels: funnelRows,
      location: locationShape,
      /**
       * The conclusion, stated by the data rather than by whoever reads it: if
       * both lists are empty, no tracking-code field is exposed anywhere the
       * API will show us, and the setting is UI-only.
       */
      trackingCodeExposedByApi:
        funnelRows.some((row) => row.trackingLikeFields.length > 0) ||
        (locationShape?.trackingLikeFields.length ?? 0) > 0,
    },
    "Command GHL sites",
  );
}
