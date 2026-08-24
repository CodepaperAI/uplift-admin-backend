# Upstream source provenance

This service was initialized as a blank Bun application and received a pinned,
one-time source snapshot from the production backend so the existing backend
repository did not need to be modified.

- Canonical backend repository: `vsandhu-developer/seo-be`
- Production source commit: `a31fef7402956d5f04842c176d6e21387ff94621`
- Snapshot date: `2026-08-24`
- Prisma schema SHA-256: `b9482f66fd73d678fa61456bda78d51c47980c992d44d6ac20f70a9d59fa2191`

`seo-be/prisma` remains the sole owner of schema changes and migrations. This
repository keeps only a client-generation snapshot and deliberately has no
migration command or migration directory. Refresh the snapshot from an approved
`seo-be` commit whenever an admin-domain query needs a newer schema.
