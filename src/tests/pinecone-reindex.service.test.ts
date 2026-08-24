import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- Prisma mock ----
// We mock the specific calls the service uses: blog.findMany + blog.update.
const blogFindManyMock = mock(async (_args: unknown): Promise<any[]> => []);
const blogUpdateMock = mock(async (_args: unknown) => ({}));

mock.module("../config/db.config", () => ({
  prisma: {
    blog: {
      findMany: blogFindManyMock,
      update: blogUpdateMock,
      // Column-reference used in the OR clause (see service implementation).
      fields: { pineconeIndexedAt: "__fields.pineconeIndexedAt__" },
    },
  },
}));

// ---- Pinecone config mock ----
// Replace all the exported helpers the service calls with controllable mocks.
const upsertSitemapUrlsMock = mock(async (..._args: unknown[]) => undefined);
const deleteSitemapVectorsMock = mock(async (_ids: string[]) => undefined);
const listSitemapVectorIdsForBusinessMock = mock(
  async (_businessId: string): Promise<string[]> => [],
);
const upsertBlogMock = mock(async (..._args: unknown[]) => undefined);

mock.module("../config/pinecone.config", () => ({
  buildSitemapVectorId: (businessId: string, url: string) =>
    `sitemap-${businessId}-${Buffer.from(url).toString("base64")}`,
  listSitemapVectorIdsForBusiness: listSitemapVectorIdsForBusinessMock,
  deleteSitemapVectors: deleteSitemapVectorsMock,
  upsertSitemapUrls: upsertSitemapUrlsMock,
  upsertBlog: upsertBlogMock,
}));

// ---- Sitemap utility mock ----
const discoverSitemapUrlMock = mock(
  async (_url: string): Promise<string | null> => null,
);
const fetchSitemapUrlsMock = mock(
  async (_url: string): Promise<string[]> => [],
);

mock.module("../utils/tools.utils", () => ({
  discoverSitemapUrl: discoverSitemapUrlMock,
  fetchSitemapUrls: fetchSitemapUrlsMock,
}));

// ---- Link validator mock ----
// By default, every URL passes validation (pre-validation gap tests can
// override to simulate dead URLs).
const filterAliveUrlsMock = mock(
  async <T extends { url: string }>(items: T[]): Promise<T[]> => items,
);

mock.module("../utils/link-validator", () => ({
  filterAliveUrls: filterAliveUrlsMock,
}));

// ---- Prisma enum stub (only STATUS.PUBLISH used) ----
mock.module("@prisma/client", () => ({
  STATUS: { DRAFT: "DRAFT", PUBLISH: "PUBLISH" },
}));

let PineconeReindexService: typeof import("../services/pinecone-reindex.service").PineconeReindexService;

beforeAll(async () => {
  ({ PineconeReindexService } = await import(
    "../services/pinecone-reindex.service"
  ));
});

beforeEach(() => {
  blogFindManyMock.mockReset();
  blogUpdateMock.mockReset();
  upsertSitemapUrlsMock.mockReset();
  deleteSitemapVectorsMock.mockReset();
  listSitemapVectorIdsForBusinessMock.mockReset();
  upsertBlogMock.mockReset();
  discoverSitemapUrlMock.mockReset();
  fetchSitemapUrlsMock.mockReset();
  filterAliveUrlsMock.mockReset();

  // Sensible defaults — individual tests override as needed.
  blogFindManyMock.mockImplementation(async () => []);
  blogUpdateMock.mockImplementation(async () => ({}));
  upsertSitemapUrlsMock.mockImplementation(async () => undefined);
  deleteSitemapVectorsMock.mockImplementation(async () => undefined);
  listSitemapVectorIdsForBusinessMock.mockImplementation(async () => []);
  upsertBlogMock.mockImplementation(async () => undefined);
  discoverSitemapUrlMock.mockImplementation(async () => null);
  fetchSitemapUrlsMock.mockImplementation(async () => []);
  // Default: every crawled URL passes validation.
  filterAliveUrlsMock.mockImplementation(async (items: any) => items);
});

const svc = () => new PineconeReindexService();

const BIZ = "biz-1";
const USER = "user-1";
const SITE = "https://example.com";

// Helper: compute the deterministic vector ID the service uses.
const vid = (url: string) =>
  `sitemap-${BIZ}-${Buffer.from(url).toString("base64")}`;

describe("PineconeReindexService.reindexSitemapForBusiness", () => {
  it("skips when website URL is missing", async () => {
    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: null,
      userId: USER,
    });
    expect(r).toEqual({ ran: false, skippedReason: "no_website_url" });
    expect(discoverSitemapUrlMock).not.toHaveBeenCalled();
  });

  it("skips when sitemap cannot be discovered", async () => {
    discoverSitemapUrlMock.mockImplementation(async () => null);

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe("sitemap_not_found");
  });

  it("skips when sitemap is empty", async () => {
    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    fetchSitemapUrlsMock.mockImplementation(async () => []);

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe("empty_sitemap");
    expect(upsertSitemapUrlsMock).not.toHaveBeenCalled();
    expect(deleteSitemapVectorsMock).not.toHaveBeenCalled();
  });

  it("upserts new URLs and deletes removed URLs (happy diff)", async () => {
    const liveUrls = [
      `${SITE}/page-a`,
      `${SITE}/page-b`,
      `${SITE}/page-c-new`,
    ];
    // In Pinecone already: a, b, AND a stale one (`page-old`) that's no longer live.
    const existingIds = [
      vid(`${SITE}/page-a`),
      vid(`${SITE}/page-b`),
      vid(`${SITE}/page-old`),
    ];

    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    fetchSitemapUrlsMock.mockImplementation(async () => liveUrls);
    listSitemapVectorIdsForBusinessMock.mockImplementation(
      async () => existingIds,
    );

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.ran).toBe(true);
    expect(r.liveUrls).toBe(3);
    expect(r.upserted).toBe(1);
    expect(r.deleted).toBe(1);

    // Upsert is called with only the new URL.
    expect(upsertSitemapUrlsMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertSitemapUrlsMock.mock.calls[0]!;
    expect(upsertArgs[0]).toBe(BIZ);
    expect(upsertArgs[1]).toBe(USER);
    expect(upsertArgs[2]).toEqual([`${SITE}/page-c-new`]);

    // Delete is called with the stale vector ID.
    expect(deleteSitemapVectorsMock).toHaveBeenCalledTimes(1);
    expect(deleteSitemapVectorsMock.mock.calls[0]![0]).toEqual([
      vid(`${SITE}/page-old`),
    ]);
  });

  it("no-op when live URLs exactly match what's already in Pinecone", async () => {
    const urls = [`${SITE}/a`, `${SITE}/b`];
    const existing = urls.map(vid);

    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    fetchSitemapUrlsMock.mockImplementation(async () => urls);
    listSitemapVectorIdsForBusinessMock.mockImplementation(
      async () => existing,
    );

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.ran).toBe(true);
    expect(r.upserted).toBe(0);
    expect(r.deleted).toBe(0);
    expect(upsertSitemapUrlsMock).not.toHaveBeenCalled();
    expect(deleteSitemapVectorsMock).not.toHaveBeenCalled();
  });

  // ---- Pre-upsert URL validation ----

  it("runs crawled URLs through filterAliveUrls before upserting", async () => {
    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    fetchSitemapUrlsMock.mockImplementation(async () => [
      `${SITE}/ok`,
      `${SITE}/dead`,
    ]);
    // Validator drops the "dead" one.
    filterAliveUrlsMock.mockImplementation(async (items: any) =>
      items.filter((i: any) => !i.url.includes("/dead")),
    );
    listSitemapVectorIdsForBusinessMock.mockImplementation(async () => []);

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.ran).toBe(true);
    expect(r.liveUrls).toBe(2);
    expect(r.aliveUrls).toBe(1);
    expect(r.droppedDeadUrls).toBe(1);

    // Only the alive URL was upserted.
    expect(upsertSitemapUrlsMock).toHaveBeenCalledTimes(1);
    const args: any[] = upsertSitemapUrlsMock.mock.calls[0]!;
    expect(args[2]).toEqual([`${SITE}/ok`]);
  });

  it("skips upsert AND delete when every URL fails validation (transient-outage guard)", async () => {
    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    fetchSitemapUrlsMock.mockImplementation(async () => [
      `${SITE}/x`,
      `${SITE}/y`,
    ]);
    filterAliveUrlsMock.mockImplementation(async () => []); // all dead
    listSitemapVectorIdsForBusinessMock.mockImplementation(async () => [
      vid(`${SITE}/legacy`),
    ]);

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe("all_sitemap_urls_unreachable");
    expect(r.droppedDeadUrls).toBe(2);

    // CRITICAL: we must not delete the existing vectors on a transient
    // all-URLs-unreachable outage.
    expect(upsertSitemapUrlsMock).not.toHaveBeenCalled();
    expect(deleteSitemapVectorsMock).not.toHaveBeenCalled();
  });

  it("dead URL in crawl is also treated as removed (pruned from Pinecone)", async () => {
    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    // Crawl returns [ok, dead]. Pinecone already has both.
    fetchSitemapUrlsMock.mockImplementation(async () => [
      `${SITE}/ok`,
      `${SITE}/dead`,
    ]);
    filterAliveUrlsMock.mockImplementation(async (items: any) =>
      items.filter((i: any) => !i.url.includes("/dead")),
    );
    listSitemapVectorIdsForBusinessMock.mockImplementation(async () => [
      vid(`${SITE}/ok`),
      vid(`${SITE}/dead`),
    ]);

    const r = await svc().reindexSitemapForBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.ran).toBe(true);
    // /ok already in Pinecone → no upsert needed.
    expect(r.upserted).toBe(0);
    // /dead should be pruned because it's in Pinecone but not in the
    // validated-alive set.
    expect(r.deleted).toBe(1);
    const deleteArgs: any[] = deleteSitemapVectorsMock.mock.calls[0]!;
    expect(deleteArgs[0]).toEqual([vid(`${SITE}/dead`)]);
  });
});

describe("PineconeReindexService.reindexChangedBlogsForBusiness", () => {
  const blog = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: `Blog ${id}`,
    content: `Content ${id}`,
    tags: [],
    categories: [],
    userId: USER,
    businessId: BIZ,
    meta: { seo_description: `desc ${id}` },
    publishedBlogs: [{ externalPostUrl: `https://example.com/p/${id}` }],
    ...overrides,
  });

  it("reindexes candidates and stamps pineconeIndexedAt", async () => {
    blogFindManyMock.mockImplementation(async () => [blog("b1"), blog("b2")]);

    const r = await svc().reindexChangedBlogsForBusiness({
      businessId: BIZ,
      maxBlogs: 10,
    });

    expect(r.ran).toBe(true);
    expect(r.candidates).toBe(2);
    expect(r.reindexed).toBe(2);
    expect(r.failed).toBe(0);
    expect(upsertBlogMock).toHaveBeenCalledTimes(2);
    expect(blogUpdateMock).toHaveBeenCalledTimes(2);

    // Each update should stamp pineconeIndexedAt with a Date.
    const firstUpdateArgs: any = blogUpdateMock.mock.calls[0]![0];
    expect(firstUpdateArgs.data.pineconeIndexedAt).toBeInstanceOf(Date);
  });

  it("returns early with cap_is_zero when maxBlogs <= 0", async () => {
    const r = await svc().reindexChangedBlogsForBusiness({
      businessId: BIZ,
      maxBlogs: 0,
    });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe("cap_is_zero");
    expect(blogFindManyMock).not.toHaveBeenCalled();
  });

  it("no candidates => ran=true with zero counts", async () => {
    blogFindManyMock.mockImplementation(async () => []);

    const r = await svc().reindexChangedBlogsForBusiness({
      businessId: BIZ,
      maxBlogs: 10,
    });

    expect(r.ran).toBe(true);
    expect(r.candidates).toBe(0);
    expect(r.reindexed).toBe(0);
    expect(upsertBlogMock).not.toHaveBeenCalled();
  });

  it("counts individual blog failures without aborting the batch", async () => {
    blogFindManyMock.mockImplementation(async () => [
      blog("ok1"),
      blog("fail"),
      blog("ok2"),
    ]);

    upsertBlogMock.mockImplementation(async (...args: unknown[]) => {
      const [id] = args as [string];
      if (id === "fail") throw new Error("embedding failed");
      return undefined;
    });

    const r = await svc().reindexChangedBlogsForBusiness({
      businessId: BIZ,
      maxBlogs: 10,
    });

    expect(r.candidates).toBe(3);
    expect(r.reindexed).toBe(2);
    expect(r.failed).toBe(1);
    // Only the two successful updates write the timestamp.
    expect(blogUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("reports cappedAt when candidates equal the cap", async () => {
    const three = [blog("b1"), blog("b2"), blog("b3")];
    blogFindManyMock.mockImplementation(async () => three);

    const r = await svc().reindexChangedBlogsForBusiness({
      businessId: BIZ,
      maxBlogs: 3,
    });

    expect(r.cappedAt).toBe(3);
  });

  it("queries only published blogs with staleness conditions", async () => {
    blogFindManyMock.mockImplementation(async () => []);

    await svc().reindexChangedBlogsForBusiness({
      businessId: BIZ,
      maxBlogs: 10,
    });

    expect(blogFindManyMock).toHaveBeenCalledTimes(1);
    const args: any = blogFindManyMock.mock.calls[0]![0];
    expect(args.where.businessId).toBe(BIZ);
    expect(args.where.status).toBe("PUBLISH");
    // OR clause: never indexed OR updated-after-indexed.
    expect(Array.isArray(args.where.OR)).toBe(true);
    expect(args.where.OR.length).toBe(2);
    expect(args.where.OR[0]).toEqual({ pineconeIndexedAt: null });
    expect(args.take).toBe(10);
  });
});

describe("PineconeReindexService.reindexBusiness (orchestrator)", () => {
  it("sitemap phase failure does not abort blog phase", async () => {
    discoverSitemapUrlMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    blogFindManyMock.mockImplementation(async () => [
      {
        id: "b1",
        title: "t",
        content: "c",
        tags: [],
        categories: [],
        userId: USER,
        businessId: BIZ,
        meta: { seo_description: "" },
        publishedBlogs: [],
      },
    ]);

    const r = await svc().reindexBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.sitemap.ran).toBe(false);
    expect(r.sitemap.error).toBeDefined();
    expect(r.blogs.ran).toBe(true);
    expect(r.blogs.reindexed).toBe(1);
  });

  it("blog phase failure does not affect sitemap phase result", async () => {
    discoverSitemapUrlMock.mockImplementation(
      async () => `${SITE}/sitemap.xml`,
    );
    fetchSitemapUrlsMock.mockImplementation(async () => [`${SITE}/x`]);
    listSitemapVectorIdsForBusinessMock.mockImplementation(async () => []);

    blogFindManyMock.mockImplementation(async () => {
      throw new Error("DB down");
    });

    const r = await svc().reindexBusiness({
      businessId: BIZ,
      businessWebsiteUrl: SITE,
      userId: USER,
    });

    expect(r.sitemap.ran).toBe(true);
    expect(r.sitemap.upserted).toBe(1);
    expect(r.blogs.ran).toBe(false);
    expect(r.blogs.error).toBeDefined();
  });
});
