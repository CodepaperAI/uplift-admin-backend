import {
  REWARDFUL_REMOTE_RESOURCES,
  getRewardfulApiHealth,
  listRewardfulRemoteResource,
} from "../services/rewardful-api.service";

type RewardfulListPayload = {
  data?: unknown;
  pagination?: {
    count?: unknown;
    total_count?: unknown;
  };
};

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function summarizeListPayload(payload: unknown): {
  count: number | null;
  totalCount: number | null;
} {
  if (!payload || typeof payload !== "object") {
    return { count: null, totalCount: null };
  }

  const data = payload as RewardfulListPayload;
  const count =
    typeof data.pagination?.count === "number"
      ? data.pagination.count
      : Array.isArray(data.data)
        ? data.data.length
        : null;
  const totalCount =
    typeof data.pagination?.total_count === "number"
      ? data.pagination.total_count
      : null;

  return { count, totalCount };
}

function formatCount(value: number | null): string {
  return value == null ? "unknown" : String(value);
}

async function main() {
  const startedAt = new Date();
  console.log("Rewardful production smoke");
  console.log(`Started: ${startedAt.toISOString()}`);
  console.log("");

  const apiSecretConfigured = hasEnv("REWARDFUL_API_SECRET");
  const webhookSecretConfigured = hasEnv("REWARDFUL_WEBHOOK_SECRET");
  console.log(
    `REWARDFUL_API_SECRET: ${apiSecretConfigured ? "configured" : "missing"}`,
  );
  console.log(
    `REWARDFUL_WEBHOOK_SECRET: ${
      webhookSecretConfigured ? "configured" : "missing"
    }`,
  );

  if (!apiSecretConfigured || !webhookSecretConfigured) {
    console.error(
      "Missing Rewardful env. Configure both backend secrets before production smoke.",
    );
    process.exit(1);
  }

  console.log("");
  const health = await getRewardfulApiHealth();
  for (const check of health.checks) {
    console.log(
      `${check.resource}: ${check.ok ? "ok" : "failed"} (${check.status})${
        check.error ? ` - ${check.error}` : ""
      }`,
    );
  }

  if (!health.ok) {
    console.error("Rewardful API health failed.");
    process.exit(1);
  }

  console.log("");
  console.log("Recent remote resource visibility:");
  const params = new URLSearchParams({ limit: "3" });
  for (const resource of REWARDFUL_REMOTE_RESOURCES) {
    const result = await listRewardfulRemoteResource(resource, params);
    const summary = summarizeListPayload(result.data);
    console.log(
      `${resource}: status=${result.status}, pageCount=${formatCount(
        summary.count,
      )}, totalCount=${formatCount(summary.totalCount)}`,
    );
  }

  console.log("");
  console.log("Manual production checks still required:");
  console.log("1. Confirm Stripe is connected in the Rewardful dashboard.");
  console.log("2. Visit the deployed frontend with ?via=<real-affiliate-token>.");
  console.log("3. Complete a test checkout in the same Stripe mode Rewardful uses.");
  console.log("4. Confirm referral/conversion/sale in Rewardful.");
  console.log("5. Confirm sale or commission webhook appears in rewardful_webhook_event.");
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Rewardful production smoke failed",
  );
  process.exit(1);
});
