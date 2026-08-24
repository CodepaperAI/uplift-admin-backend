// Review-request campaign sender: verifies the bookkeeping bits in
// isolation (imports, opt-out, status transitions). Resend / email
// dispatch is not exercised here — see gmb-review-campaign-dispatch
// integration tests for that path.

import { beforeEach, describe, expect, it, mock } from "bun:test";

type ContactRow = {
  id: string;
  businessId: string;
  campaignId: string;
  email: string;
  name: string | null;
  status: string;
  source: string;
  unsubscribeToken: string;
  addedAt: Date;
  lastEmailedAt: Date | null;
  optedOutAt: Date | null;
  bouncedAt: Date | null;
  emailError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CampaignRow = {
  id: string;
  businessId: string;
  status: string;
};

const campaigns = new Map<string, CampaignRow>();
const contacts: ContactRow[] = [];

function findContactByCampaignEmail(campaignId: string, email: string) {
  return (
    contacts.find(
      (c) => c.campaignId === campaignId && c.email === email,
    ) ?? null
  );
}

function findContactByToken(token: string) {
  return contacts.find((c) => c.unsubscribeToken === token) ?? null;
}

mock.module("../config/db.config", () => ({
  prisma: {
    gMBReviewCampaign: {
      findUnique: async ({ where, select: _select }: any) =>
        campaigns.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const c = campaigns.get(where.id);
        if (!c) throw new Error("campaign not found");
        if (data.status) c.status = data.status;
        return c;
      },
      findMany: async ({ where }: any) =>
        Array.from(campaigns.values()).filter(
          (c) => c.status === where.status,
        ),
    },
    gMBReviewContact: {
      findUnique: async ({ where }: any) => {
        if (where.campaignId_email) {
          return findContactByCampaignEmail(
            where.campaignId_email.campaignId,
            where.campaignId_email.email,
          );
        }
        if (where.unsubscribeToken) {
          return findContactByToken(where.unsubscribeToken);
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        return contacts.filter(
          (c) =>
            (!where.campaignId || c.campaignId === where.campaignId) &&
            (!where.status || c.status === where.status),
        );
      },
      create: async ({ data }: any) => {
        const row: ContactRow = {
          id: `contact-${contacts.length + 1}`,
          businessId: data.businessId,
          campaignId: data.campaignId,
          email: data.email,
          name: data.name ?? null,
          status: data.status ?? "PENDING",
          source: data.source ?? "manual",
          unsubscribeToken: data.unsubscribeToken,
          addedAt: new Date(),
          lastEmailedAt: null,
          optedOutAt: null,
          bouncedAt: null,
          emailError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        contacts.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = contacts.find((c) => c.id === where.id);
        if (!row) throw new Error("contact not found");
        if (data.name !== undefined) row.name = data.name;
        if (data.status) row.status = data.status;
        if (data.optedOutAt) row.optedOutAt = data.optedOutAt;
        if (data.lastEmailedAt) row.lastEmailedAt = data.lastEmailedAt;
        return row;
      },
    },
  },
}));

import {
  importReviewContacts,
  activateCampaign,
  pauseCampaign,
  optOutByToken,
} from "../services/gmb-review-campaign.service";

beforeEach(() => {
  campaigns.clear();
  contacts.length = 0;
  campaigns.set("camp-1", {
    id: "camp-1",
    businessId: "biz-1",
    status: "DRAFT",
  });
});

describe("importReviewContacts", () => {
  it("adds new contacts and skips invalid emails", async () => {
    const result = await importReviewContacts({
      campaignId: "camp-1",
      contacts: [
        { email: "Alice@Example.com", name: " Alice " },
        { email: "bob@example.com" },
        { email: "not-an-email" },
        { email: "" },
      ],
    });

    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);
    expect(contacts.map((c) => c.email).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    // Alice's name should be trimmed; email lowercased.
    const alice = contacts.find((c) => c.email === "alice@example.com");
    expect(alice?.name).toBe("Alice");
    // Tokens should be unique and reasonably long.
    expect(new Set(contacts.map((c) => c.unsubscribeToken)).size).toBe(
      contacts.length,
    );
    expect(alice?.unsubscribeToken.length).toBeGreaterThanOrEqual(32);
  });

  it("does not resurrect OPTED_OUT contacts on re-import", async () => {
    await importReviewContacts({
      campaignId: "camp-1",
      contacts: [{ email: "ghost@example.com" }],
    });
    const ghost = contacts[0]!;
    ghost.status = "OPTED_OUT";

    const result = await importReviewContacts({
      campaignId: "camp-1",
      contacts: [{ email: "ghost@example.com" }],
    });
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(ghost.status).toBe("OPTED_OUT");
  });

  it("updates name on a PENDING contact when re-imported with a name", async () => {
    await importReviewContacts({
      campaignId: "camp-1",
      contacts: [{ email: "carla@example.com" }],
    });
    const result = await importReviewContacts({
      campaignId: "camp-1",
      contacts: [{ email: "carla@example.com", name: "Carla Lopez" }],
    });
    expect(result.updated).toBe(1);
    expect(contacts[0]!.name).toBe("Carla Lopez");
  });
});

describe("campaign activation", () => {
  it("flips DRAFT -> ACTIVE on activate, ACTIVE -> PAUSED on pause", async () => {
    await activateCampaign("camp-1");
    expect(campaigns.get("camp-1")!.status).toBe("ACTIVE");
    await pauseCampaign("camp-1");
    expect(campaigns.get("camp-1")!.status).toBe("PAUSED");
  });
});

describe("optOutByToken", () => {
  it("flips PENDING contact to OPTED_OUT and is idempotent", async () => {
    await importReviewContacts({
      campaignId: "camp-1",
      contacts: [{ email: "dora@example.com" }],
    });
    const token = contacts[0]!.unsubscribeToken;

    expect(await optOutByToken(token)).toBe(true);
    expect(contacts[0]!.status).toBe("OPTED_OUT");
    expect(contacts[0]!.optedOutAt).toBeInstanceOf(Date);

    // Re-clicking the same link is a no-op success, not an error.
    expect(await optOutByToken(token)).toBe(true);
    expect(contacts[0]!.status).toBe("OPTED_OUT");
  });

  it("returns false for an unknown token", async () => {
    expect(await optOutByToken("does-not-exist-token-bytes")).toBe(false);
  });
});
