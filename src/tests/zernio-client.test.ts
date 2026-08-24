import { describe, expect, test } from "bun:test";

import {
  UPLIFT_TO_ZERNIO_PLATFORM,
  ZERNIO_TO_UPLIFT_PLATFORM,
  ZernioApiError,
  ZernioClient,
} from "../services/zernio/zernio.client";

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("ZernioClient", () => {
  test("creates a website-scoped profile with a durable idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ profile: { _id: "profile-1" } }, { status: 201 });
      }) as typeof fetch,
    );

    const result = await client.createProfile({
      name: "Acme",
      description: "Acme website",
      idempotencyKey: "uplift-social-profile:business-1",
    });

    expect(result.id).toBe("profile-1");
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test");
    expect(headers.get("idempotency-key")).toBe(
      "uplift-social-profile:business-1",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Acme",
      description: "Acme website",
    });
  });

  test("uses the hosted OAuth flow and keeps the exact callback URL", async () => {
    let requestedUrl = "";
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (url) => {
        requestedUrl = String(url);
        return jsonResponse({ authUrl: "https://zernio.com/connect/session" });
      }) as typeof fetch,
    );

    const authUrl = await client.getConnectUrl({
      platform: "twitter",
      profileId: "profile-1",
      redirectUrl: "https://upliftai.co/dashboard/social/connections?businessId=b1",
    });

    expect(authUrl).toBe("https://zernio.com/connect/session");
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/connect/twitter");
    expect(url.searchParams.get("profileId")).toBe("profile-1");
    expect(url.searchParams.get("headless")).toBe("false");
    expect(url.searchParams.get("redirect_url")).toBe(
      "https://upliftai.co/dashboard/social/connections?businessId=b1",
    );
  });

  test("creates one platform-specific post with direct Bunny media and request idempotency", async () => {
    const calls: RequestInit[] = [];
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (_url, init) => {
        calls.push(init ?? {});
        return jsonResponse(
          { post: { _id: "post-1", status: "scheduled" } },
          { status: 201 },
        );
      }) as typeof fetch,
    );

    const post = await client.createPost(
      {
        title: "Launch",
        content: "A platform-specific caption",
        mediaUrl: "https://uplift-ai-images.b-cdn.net/social/x.png",
        platform: "twitter",
        accountId: "account-x",
        publishNow: false,
        scheduledFor: "2026-08-10T15:00:00.000Z",
        timezone: "America/Toronto",
        metadata: { upliftAttemptId: "attempt-1" },
      },
      "15183849-f701-495c-b3a9-0b327af4f5c4",
    );

    expect(post._id).toBe("post-1");
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("x-request-id")).toBe(
      "15183849-f701-495c-b3a9-0b327af4f5c4",
    );
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.mediaItems).toEqual([
      { type: "image", url: "https://uplift-ai-images.b-cdn.net/social/x.png" },
    ]);
    expect(body.platforms).toEqual([
      {
        platform: "twitter",
        accountId: "account-x",
        customContent: "A platform-specific caption",
      },
    ]);
    expect(body.publishNow).toBe(false);
    expect(body.scheduledFor).toBe("2026-08-10T15:00:00.000Z");
    expect(body.hashtags).toBeUndefined();
  });

  test("sends a text-only Twitter post with an empty media collection", async () => {
    const calls: RequestInit[] = [];
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (_url, init) => {
        calls.push(init ?? {});
        return jsonResponse(
          { post: { _id: "post-text-only", status: "scheduled" } },
          { status: 201 },
        );
      }) as typeof fetch,
    );

    await client.createPost(
      {
        title: "Lunch update",
        content: "A concise text-only X post",
        mediaUrl: null,
        platform: "twitter",
        accountId: "account-x",
        publishNow: false,
        scheduledFor: "2026-08-20T16:00:00.000Z",
        timezone: "America/Toronto",
        metadata: { upliftAttemptId: "attempt-text-only" },
      },
      "25183849-f701-495c-b3a9-0b327af4f5c4",
    );

    const body = JSON.parse(String(calls[0]?.body));
    expect(body.mediaItems).toEqual([]);
    expect(body.platforms).toEqual([
      {
        platform: "twitter",
        accountId: "account-x",
        customContent: "A concise text-only X post",
      },
    ]);
  });

  test("keeps ordered carousel media in one provider post", async () => {
    const calls: RequestInit[] = [];
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (_url, init) => {
        calls.push(init ?? {});
        return jsonResponse(
          { post: { _id: "post-carousel", status: "scheduled" } },
          { status: 201 },
        );
      }) as typeof fetch,
    );

    await client.createPost(
      {
        title: "A practical framework",
        content: "Save this connected five-step guide.",
        mediaUrls: [
          "https://uplift-ai-images.b-cdn.net/social/slide-1.png",
          "https://uplift-ai-images.b-cdn.net/social/slide-2.png",
          "https://uplift-ai-images.b-cdn.net/social/slide-3.png",
          "https://uplift-ai-images.b-cdn.net/social/slide-4.png",
        ],
        platform: "instagram",
        accountId: "account-instagram",
        publishNow: false,
        scheduledFor: "2026-08-25T13:00:00.000Z",
        timezone: "America/Toronto",
        metadata: { upliftAttemptId: "attempt-carousel" },
      },
      "35183849-f701-495c-b3a9-0b327af4f5c4",
    );

    const body = JSON.parse(String(calls[0]?.body));
    expect(body.mediaItems).toEqual(
      [1, 2, 3, 4].map((slide) => ({
        type: "image",
        url: `https://uplift-ai-images.b-cdn.net/social/slide-${slide}.png`,
      })),
    );
    expect(body.platforms).toEqual([
      {
        platform: "instagram",
        accountId: "account-instagram",
        customContent: "Save this connected five-step guide.",
        platformSpecificData: { isAiGenerated: true },
      },
    ]);
  });

  test("adopts Zernio's existing post after provider content deduplication", async () => {
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async () =>
        jsonResponse(
          {
            error: "Duplicate content",
            code: "DUPLICATE_CONTENT",
            existingPostId: "post-existing",
          },
          { status: 409 },
        )) as unknown as typeof fetch,
    );

    const post = await client.createPost(
      {
        title: "Launch",
        content: "Already accepted by the provider",
        mediaUrl: "https://uplift-ai-images.b-cdn.net/social/x.png",
        platform: "twitter",
        accountId: "account-x",
        publishNow: true,
        timezone: "UTC",
        metadata: { upliftAttemptId: "attempt-1" },
      },
      "15183849-f701-495c-b3a9-0b327af4f5c4",
    );

    expect(post._id).toBe("post-existing");
    expect(post.status).toBe("processing");
  });

  test("reconciles a duplicate response by unique Uplift attempt metadata", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return jsonResponse(
            {
              error:
                "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
            },
            { status: 409 },
          );
        }
        return jsonResponse({
          posts: [
            {
              _id: "post-published",
              status: "published",
              platforms: [
                {
                  platform: "instagram",
                  status: "published",
                  platformPostUrl: "https://www.instagram.com/p/post-published/",
                },
              ],
              metadata: { upliftAttemptId: "attempt-1" },
            },
          ],
        });
      }) as typeof fetch,
    );

    const post = await client.createPost(
      {
        title: "Launch",
        content: "Already accepted by the provider",
        mediaUrl: "https://uplift-ai-images.b-cdn.net/social/instagram.png",
        platform: "instagram",
        accountId: "account-instagram",
        publishNow: true,
        timezone: "UTC",
        metadata: { upliftAttemptId: "attempt-1" },
      },
      "15183849-f701-495c-b3a9-0b327af4f5c4",
    );

    expect(post._id).toBe("post-published");
    expect(post.status).toBe("published");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).pathname).toBe("/api/v1/posts");
    expect(calls[1]!.init?.method).toBe("GET");
  });

  test("loads one provider post for active status reconciliation", async () => {
    let requestedUrl = "";
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (url) => {
        requestedUrl = String(url);
        return jsonResponse({
          post: {
            _id: "post-1",
            status: "published",
            platforms: [
              {
                platform: "instagram",
                status: "published",
                platformPostUrl: "https://www.instagram.com/p/post-1/",
              },
            ],
          },
        });
      }) as typeof fetch,
    );

    const post = await client.getPost("post-1");

    expect(new URL(requestedUrl).pathname).toBe("/api/v1/posts/post-1");
    expect(post.status).toBe("published");
  });

  test("updates the matching team-wide webhook without exposing its secret", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ZernioClient(
      "sk_test",
      "https://zernio.com/api/v1",
      (async (url, init) => {
        calls.push({ url: String(url), init });
        if (init?.method === "GET") {
          return jsonResponse({
            webhooks: [
              {
                _id: "webhook-1",
                name: "Uplift AI Social Publishing",
                url: "https://api.upliftai.co/api/v1/social-publishing/webhooks/zernio",
                events: ["post.published"],
                isActive: true,
              },
            ],
          });
        }
        return jsonResponse({
          webhook: {
            _id: "webhook-1",
            name: "Uplift AI Social Publishing",
            url: "https://api.upliftai.co/api/v1/social-publishing/webhooks/zernio",
            events: ["post.published", "post.failed"],
            isActive: true,
          },
        });
      }) as typeof fetch,
    );

    const webhooks = await client.listWebhookSettings();
    expect(webhooks).toHaveLength(1);
    await client.updateWebhookSetting({
      id: webhooks[0]!._id,
      name: webhooks[0]!.name,
      url: webhooks[0]!.url,
      secret: "a".repeat(64),
      events: ["post.published", "post.failed"],
    });

    expect(calls[0]?.url).toBe("https://zernio.com/api/v1/webhooks/settings");
    expect(calls[1]?.init?.method).toBe("PUT");
    const body = JSON.parse(String(calls[1]?.init?.body));
    expect(body._id).toBe("webhook-1");
    expect(body.secret).toBe("a".repeat(64));
  });

  test("normalizes retryable provider failures without leaking credentials", async () => {
    const client = new ZernioClient(
      "sk_secret",
      "https://zernio.com/api/v1",
      (async () =>
        jsonResponse(
          { error: "Provider is busy", code: "RATE_LIMITED" },
          { status: 429 },
        )) as unknown as typeof fetch,
    );

    try {
      await client.listAccounts("profile-1");
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ZernioApiError);
      expect((error as ZernioApiError).code).toBe("RATE_LIMITED");
      expect((error as ZernioApiError).retryable).toBe(true);
      expect((error as Error).message.includes("sk_secret")).toBe(false);
    }
  });

  test("maps Uplift X to Zernio twitter and back", () => {
    expect(UPLIFT_TO_ZERNIO_PLATFORM.x).toBe("twitter");
    expect(ZERNIO_TO_UPLIFT_PLATFORM.twitter).toBe("x");
  });
});
