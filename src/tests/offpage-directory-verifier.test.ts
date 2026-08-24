import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const getMock = mock(async (_url: string, _cfg?: unknown) => ({
  status: 200,
  data: "<html><title>Directory</title></html>",
}));

mock.module("axios", () => ({
  default: {
    get: getMock,
  },
  get: getMock,
}));

let checkUrlReachable: typeof import("../utils/directory-verifier").checkUrlReachable;
let findDirectorySubmissionLinks: typeof import("../utils/directory-verifier").findDirectorySubmissionLinks;
let parseDirectorySubmissionLinks: typeof import("../utils/directory-verifier").parseDirectorySubmissionLinks;

beforeAll(async () => {
  ({
    checkUrlReachable,
    findDirectorySubmissionLinks,
    parseDirectorySubmissionLinks,
  } = await import("../utils/directory-verifier"));
});

beforeEach(() => {
  getMock.mockReset();
});

describe("checkUrlReachable", () => {
  it("keeps bot-protected directories instead of treating 403 as dead", async () => {
    getMock.mockImplementation(async () => ({
      status: 403,
      data: "<html><title>Forbidden</title></html>",
    }));

    expect(await checkUrlReachable("https://directory.example")).toBe(true);
  });

  it("keeps rate-limited directories instead of treating 429 as dead", async () => {
    getMock.mockImplementation(async () => ({
      status: 429,
      data: "<html><title>Too Many Requests</title></html>",
    }));

    expect(await checkUrlReachable("https://directory.example")).toBe(true);
  });

  it("drops confirmed hard not-found directory URLs", async () => {
    getMock.mockImplementation(async () => ({
      status: 404,
      data: "<html><title>Not found</title></html>",
    }));

    expect(await checkUrlReachable("https://directory.example/missing")).toBe(false);
  });

  it("drops soft 404 pages from the title", async () => {
    getMock.mockImplementation(async () => ({
      status: 200,
      data: "<html><title>Page not found</title></html>",
    }));

    expect(await checkUrlReachable("https://directory.example/missing")).toBe(false);
  });

  it("drops invalid or missing directory URLs", async () => {
    expect(await checkUrlReachable("")).toBe(false);
    expect(await checkUrlReachable("not-a-url")).toBe(false);
  });
});

describe("parseDirectorySubmissionLinks", () => {
  it("finds direct claim and add-listing links on a directory page", () => {
    const links = parseDirectorySubmissionLinks(
      `
      <a href="/claim-business">Claim this business</a>
      <a href="/add-listing">Add your business for free</a>
      <a href="https://other.example/add-business">Add business elsewhere</a>
      <a href="/category/plumbers">Plumbers</a>
      `,
      "https://directory.example/",
    );

    expect(links.map((link) => link.url)).toEqual([
      "https://directory.example/claim-business",
      "https://directory.example/add-listing",
    ]);
    expect(links[0]?.submissionUrlType).toBe("direct_claim");
    expect(links[1]?.submissionUrlType).toBe("add_business");
    expect(links[1]?.pricingModel).toBe("free");
  });

  it("fetches a directory page and returns discovered submission links", async () => {
    getMock.mockImplementation(async () => ({
      status: 200,
      data: '<html><a href="/business/register">Register your business</a></html>',
    }));

    const links = await findDirectorySubmissionLinks("https://directory.example/");
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("https://directory.example/business/register");
    expect(links[0]?.submissionUrlType).toBe("add_business");
  });
});
