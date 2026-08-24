# Uplift AI Admin API

Standalone Bun/Express backend for the internal Uplift AI admin portal. It is a
separate deployment and repository; the production `seo-be` service remains
unchanged and continues to own all public/customer APIs, webhooks, Inngest
workers, and database migrations.

## Public runtime surface

- `/api/v1/auth/admin/*` — isolated Better Auth admin session surface
- `/api/v1/command/*` — internal Command Center APIs
- `/api/v1/superadmin/agencies/*` — superadmin metrics, billing, agencies, and audit APIs
- `/health/live` and `/health/ready` — non-sensitive health checks

Everything else returns `404`. The service does not expose `/api/inngest`,
customer APIs, public APIs, dashboard auth, sales auth, or provider webhooks.
Admin-triggered background actions emit events to the existing Inngest service;
they do not execute jobs in this process. The Inngest metrics view temporarily
relays to the canonical backend because the self-hosted management API is kept
behind a separate operator authentication boundary.

Provider worker credentials (GHL, Meta, Anthropic, Fathom, and Fireflies) stay
with the existing worker runtime. This service receives non-secret readiness
booleans for those integrations, avoiding unnecessary secret duplication.

## Local development

```bash
cp .env.example .env.local
bun install --frozen-lockfile
bunx prisma generate
bun run check
bun run dev
```

## Database ownership

This service reads and writes the existing production database for admin-domain
operations, but never applies schema migrations. `seo-be/prisma` is canonical.
See `UPSTREAM_SOURCE.md` for the pinned source and schema snapshot.

## Deployment

The AWS stack creates a dedicated ECR repository, EC2 instance, security group,
runtime secret, IAM role, CloudWatch logs/alarms, and GitHub OIDC deployment
role. Deployments use immutable image tags and Systems Manager; no SSH or
long-lived AWS keys are required.

The EC2 instance has its own security group. Existing RDS and Valkey groups
receive only source-group rules for ports 5432 and 6379 respectively; the admin
host is not attached to the broader application compute security group.
PostgreSQL uses certificate-verified TLS with the AWS RDS global CA bundle
included in the immutable application image. Valkey uses its TLS endpoint.
