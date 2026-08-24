import type { Request, Response, NextFunction } from "express";
import { MANAGED_AGENCIES_ENABLED } from "../config/feature-flags";
import {
  extractAgencyDomainFromRequest,
  resolveAgencyFromDomain,
} from "../utils/agency-context.utils";

export async function resolveAgency(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  req.agencyId = undefined;
  req.agencySlug = undefined;

  if (!MANAGED_AGENCIES_ENABLED) {
    next();
    return;
  }

  const domain: string | null = extractAgencyDomainFromRequest(req);

  if (!domain) {
    next();
    return;
  }

  try {
    const agency = await resolveAgencyFromDomain(domain);

    if (agency) {
      req.agencyId = agency.id;
      req.agencySlug = agency.slug;
    }
  } catch {
    req.agencyId = undefined;
    req.agencySlug = undefined;
  }

  next();
}
