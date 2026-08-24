#!/usr/bin/env bash
set -euo pipefail

aws_profile="${AWS_PROFILE:-uplift-dev}"
aws_region="${AWS_REGION:-us-east-1}"
source_secret="${SOURCE_SECRET_ID:-uplift-ai/production/runtime}"
target_secret="${TARGET_SECRET_ID:-uplift-ai/production/admin-api-runtime}"
infrastructure_secret="${INFRASTRUCTURE_SECRET_ID:-uplift-ai/production/infrastructure}"

source_json="$(aws secretsmanager get-secret-value \
  --profile "${aws_profile}" --region "${aws_region}" \
  --secret-id "${source_secret}" --query SecretString --output text)"

infrastructure_json="$(aws secretsmanager get-secret-value \
  --profile "${aws_profile}" --region "${aws_region}" \
  --secret-id "${infrastructure_secret}" --query SecretString --output text)"
rds_endpoint="$(aws rds describe-db-instances \
  --profile "${aws_profile}" --region "${aws_region}" \
  --db-instance-identifier uplift-production \
  --query 'DBInstances[0].Endpoint.Address' --output text)"
valkey_endpoint="$(aws elasticache describe-replication-groups \
  --profile "${aws_profile}" --region "${aws_region}" \
  --replication-group-id uplift-production \
  --query 'ReplicationGroups[0].NodeGroups[0].PrimaryEndpoint.Address' --output text)"
application_password="$(jq -er '.application_database_password' <<<"${infrastructure_json}")"
valkey_auth_token="$(jq -er '.valkey_auth_token' <<<"${infrastructure_json}")"
database_url="postgresql://uplift_app:${application_password}@${rds_endpoint}:5432/uplift"
redis_url="rediss://default:${valkey_auth_token}@${valkey_endpoint}:6379/0"

target_json="$(jq -c '
  with_entries(select(.key as $key | [
    "DATABASE_URL",
    "DATABASE_CA_CERT_PATH",
    "REDIS_URL",
    "BETTER_AUTH_SECRET",
    "STRIPE_SECRET_KEY",
    "UPLIFT_PLAN_PRICE_ID",
    "UPLIFT_YEARLY_PRICE_ID",
    "UPLIFT_SEO_SOCIAL_PRICE_ID",
    "UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID",
    "WEBSITE_PRICE_ID",
    "WEBSITE_YEARLY_PRICE_ID",
    "REWARDFUL_API_SECRET",
    "INNGEST_EVENT_KEY",
    "INNGEST_BASE_URL",
    "GHL_COMMAND_READ_TOKEN",
    "GHL_COMMAND_LOCATION_ID",
    "GHL_COMMAND_CONTACTS_VERSION",
    "GHL_COMMAND_OPPORTUNITIES_VERSION",
    "GHL_COMMAND_PAYMENTS_VERSION",
    "GHL_COMMAND_CONVERSATIONS_VERSION",
    "GHL_COMMAND_CALENDARS_VERSION",
    "COMMAND_GHL_SYNC_ENABLED",
    "COMMAND_COACHING_MODEL",
    "COMMAND_GHL_PAYMENTS_SYNC_ENABLED",
    "COMMAND_GHL_ACTIVITY_SYNC_ENABLED",
    "COMMAND_META_ADS_SYNC_ENABLED",
    "COMMAND_REQUIRE_SUPERADMIN_MFA",
    "COMMAND_MFA_ASSURANCE_MAX_AGE_SECONDS"
  ] | index($key)))
  + {
    NODE_ENV: "production",
    APP_ENV: "production",
    DEPLOY_ENV: "production",
    PORT: "3000",
    BACKEND_URL: "https://admin-api.upliftai.co",
    CORE_BACKEND_URL: "https://api.upliftai.co",
    ADMIN_FRONTEND_URL: "https://admin.upliftai.co",
    COMMAND_FRONTEND_URL: "https://admin.upliftai.co",
    CORS_ALLOWED_ORIGINS: "https://admin.upliftai.co",
    PRISMA_POOL_MAX: "5",
    PRISMA_QUERY_LOGGING: "false",
    PRISMA_QUERY_LOG: "false",
    COMMAND_GHL_CONFIGURED: (
      ((.GHL_COMMAND_READ_TOKEN // "") | length) > 0 and
      ((.GHL_COMMAND_LOCATION_ID // "") | length) > 0
    | tostring),
    COMMAND_META_ADS_CONFIGURED: (
      ((.META_ADS_ACCESS_TOKEN // "") | length) > 0 and
      ((.META_AD_ACCOUNT_ID // "") | length) > 0 and
      ((.META_GRAPH_API_VERSION // "") | length) > 0
    | tostring),
    COMMAND_COACHING_AI_CONFIGURED: (
      ((.ANTHROPIC_API_KEY // "") | length) > 0 | tostring
    ),
    COMMAND_FATHOM_CONFIGURED: (
      ((.FATHOM_API_KEY // "") | length) > 0 and
      ((.FATHOM_WEBHOOK_SECRET // "") | length) > 0
    | tostring),
    COMMAND_FIREFLIES_CONFIGURED: (
      ((.FIREFLIES_API_KEY // "") | length) > 0 and
      ((.FIREFLIES_WEBHOOK_SECRET // "") | length) > 0
    | tostring)
  }
' <<<"${source_json}")"

target_json="$(jq -c \
  --arg databaseUrl "${database_url}" \
  --arg redisUrl "${redis_url}" \
  --arg inngestBaseUrl "https://inngest.upliftai.co" \
  '. + {
    DATABASE_URL: $databaseUrl,
    DATABASE_CA_CERT_PATH: "/app/certs/aws-rds-global-bundle.pem",
    REDIS_URL: $redisUrl,
    INNGEST_BASE_URL: $inngestBaseUrl
  }' <<<"${target_json}")"

for required_key in DATABASE_URL REDIS_URL BETTER_AUTH_SECRET STRIPE_SECRET_KEY INNGEST_EVENT_KEY; do
  jq -e --arg key "${required_key}" '.[$key] | type == "string" and length > 0' \
    <<<"${target_json}" >/dev/null
done

aws secretsmanager put-secret-value \
  --profile "${aws_profile}" --region "${aws_region}" \
  --secret-id "${target_secret}" \
  --secret-string "${target_json}" >/dev/null

echo "Updated ${target_secret} with an allowlisted runtime projection; no values were printed."
