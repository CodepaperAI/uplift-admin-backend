/**
 * offpage-outcome-verifier.ts
 *
 * The outcome-verification layer — "verify instead of confirming randomly". When
 * a user marks an opportunity done and provides the link to what they did, we
 * re-fetch it and confirm it's actually live:
 *  - Reddit: the thread/comment exists and isn't removed/deleted.
 *  - Directory: the listing page is reachable and mentions the business.
 * Fails soft to a "failed" status (transient error) vs "not_found" (checked,
 * not there) so the UI can tell the difference.
 */

import axios from "axios";
import { fetchWithScraperAPI } from "../../utils/tools.utils";

export type OutcomeStatus = "verified" | "not_found" | "failed";

export interface OutcomeResult {
  status: OutcomeStatus;
  evidence: Record<string, unknown>;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function verifyRedditPost(url: string): Promise<OutcomeResult> {
  if (!/reddit\.com\/r\/[^/]+\/comments\//i.test(url)) {
    return { status: "not_found", evidence: { reason: "not a reddit thread/comment URL" } };
  }
  try {
    const html = await fetchWithScraperAPI(url, { render: true, deviceType: "desktop" });
    const lower = html.toLowerCase();
    const missing =
      lower.includes("page not found") ||
      lower.includes("sorry, nobody on reddit goes by that name") ||
      html.length < 500;
    const removed = lower.includes("[removed]") || lower.includes("[deleted]");
    const live = !missing && !removed;
    return {
      status: live ? "verified" : "not_found",
      evidence: { htmlLength: html.length, removed, missing },
    };
  } catch (err) {
    return { status: "failed", evidence: { error: (err as Error).message } };
  }
}

async function verifyDirectoryListing(
  url: string,
  businessName: string,
): Promise<OutcomeResult> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 15_000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
      headers: { "User-Agent": UA },
      responseType: "text",
    });
    if (res.status >= 400) {
      return { status: "not_found", evidence: { httpStatus: res.status } };
    }
    const html = String(res.data ?? "").toLowerCase();
    const name = businessName.trim().toLowerCase();
    const found = name ? html.includes(name) : true;
    return {
      status: found ? "verified" : "not_found",
      evidence: { httpStatus: res.status, businessNameFound: found },
    };
  } catch (err) {
    return { status: "failed", evidence: { error: (err as Error).message } };
  }
}

/** Verify that the user's claimed off-page action (post/listing) is actually live. */
export async function verifyOpportunityOutcome(
  leverKey: string,
  url: string,
  businessName: string,
): Promise<OutcomeResult> {
  if (!/^https?:\/\//i.test(url)) {
    return { status: "failed", evidence: { reason: "invalid url" } };
  }
  if (leverKey === "reddit") return verifyRedditPost(url);
  if (leverKey === "directory") return verifyDirectoryListing(url, businessName);
  return { status: "failed", evidence: { reason: "unsupported lever" } };
}
