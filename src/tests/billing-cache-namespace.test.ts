import { describe, expect, it } from "bun:test";

import {
  BILLING_HISTORY_CACHE_NAMESPACE,
  SUBSCRIPTION_STATUS_CACHE_NAMESPACE,
} from "../controllers/billing-portal.controller";

describe("billing cache namespaces", () => {
  it("keeps billing history and subscription projections isolated", () => {
    expect(BILLING_HISTORY_CACHE_NAMESPACE).not.toBe(
      SUBSCRIPTION_STATUS_CACHE_NAMESPACE,
    );
  });
});
