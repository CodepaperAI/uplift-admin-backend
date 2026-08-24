import {
  buildGhlSignupPayloadPreview,
  isGhlSignupSyncConfigured,
} from "../services/ghl-signup-sync.service";

function readEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

const previewUser = {
  id: readEnv("GHL_PREVIEW_USER_ID", "preview-user-123"),
  email: readEnv("GHL_PREVIEW_EMAIL", "preview@upliftai.co"),
  name: readEnv("GHL_PREVIEW_NAME", "Preview User"),
  createdAt: readEnv(
    "GHL_PREVIEW_CREATED_AT",
    new Date().toISOString(),
  ),
};

const preview = buildGhlSignupPayloadPreview(previewUser);

console.log(
  JSON.stringify(
    {
      syncConfigured: isGhlSignupSyncConfigured(),
      note:
        "Preview only. This command does not call GHL and never prints the API token.",
      previewUser,
      preview,
    },
    null,
    2,
  ),
);

if (preview.status !== "ready") {
  process.exitCode = 1;
}
