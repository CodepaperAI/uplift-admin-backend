import { describe, expect, it } from "bun:test";
import {
  parseGoogleRedditThreads,
  parseRedditThreads,
  parseRedditThreadDetail,
} from "../utils/reddit-thread-finder";

/**
 * Fixture mimicking a real old.reddit search page for r/toronto: the restricted
 * results PLUS an appended "more results from across Reddit" group (r/askTO) that
 * appears FIRST in the DOM, plus an off-topic in-subreddit thread. This is the
 * exact shape that produced the bath-towels bug.
 */
const SEARCH_HTML = `
<div class="search-result-group">
  <a class="search-title may-blank" href="https://www.reddit.com/r/askTO/comments/1u9ztyu/where_are_you_buying_quality_bath_towels_now_that/">Where are you buying quality bath towels now that the Bay is gone?</a>
  <a class="search-title may-blank" href="https://www.reddit.com/r/askTO/comments/1u9nnhq/why_are_there_no_arbys_in_toronto/">Why are there no Arbys in Toronto</a>
</div>
<div class="search-result-group">
  <a class="search-title may-blank" href="https://www.reddit.com/r/toronto/comments/8u0s8j/the_contrasting_colours_in_the_sky_this_past/">The contrasting colours in the sky this past evening</a>
  <a class="search-title may-blank" href="https://www.reddit.com/r/toronto/comments/abc123/best_shawarma_in_downtown_toronto_recommendations/">Best shawarma in downtown Toronto recommendations?</a>
</div>
`;

describe("parseRedditThreads", () => {
  it("drops cross-subreddit results and keeps only the on-topic same-sub thread", () => {
    const threads = parseRedditThreads(SEARCH_HTML, "toronto", ["shawarma"]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.url).toBe(
      "https://www.reddit.com/r/toronto/comments/abc123/best_shawarma_in_downtown_toronto_recommendations",
    );
    // title derived from the slug, never empty
    expect(threads[0]?.title.toLowerCase()).toContain("shawarma");
  });

  it("never returns a thread from a different subreddit (scope guard)", () => {
    const threads = parseRedditThreads(SEARCH_HTML, "toronto", ["shawarma"]);
    expect(threads.every((t) => t.url.includes("/r/toronto/"))).toBe(true);
    expect(threads.some((t) => t.url.includes("/r/askTO/"))).toBe(false);
  });

  it("drops off-topic in-subreddit threads (relevance guard)", () => {
    // The sky-colours thread is r/toronto but irrelevant → must not be returned.
    const threads = parseRedditThreads(SEARCH_HTML, "toronto", ["shawarma"]);
    expect(threads.some((t) => t.url.includes("8u0s8j"))).toBe(false);
  });

  it("handles the askTO subreddit + relevant term ('arbys' is off-topic for shawarma)", () => {
    const threads = parseRedditThreads(SEARCH_HTML, "askTO", ["shawarma"]);
    // askTO has no shawarma thread in the fixture → nothing relevant
    expect(threads).toHaveLength(0);
  });

  it("derives a readable title from the slug and emits www.reddit.com URLs", () => {
    const threads = parseRedditThreads(SEARCH_HTML, "toronto", ["shawarma"]);
    expect(threads[0]?.title).toBe(
      "Best shawarma in downtown toronto recommendations",
    );
    expect(threads[0]?.url.startsWith("https://www.reddit.com/")).toBe(true);
  });

  it("with no core terms, returns same-sub threads without relevance filtering", () => {
    const threads = parseRedditThreads(SEARCH_HTML, "toronto", []);
    expect(threads.length).toBe(2); // both r/toronto, neither askTO
    expect(threads.every((t) => t.url.includes("/r/toronto/"))).toBe(true);
  });
});

describe("parseGoogleRedditThreads", () => {
  it("keeps only same-subreddit, on-topic Google fallback results", () => {
    const threads = parseGoogleRedditThreads(
      [
        {
          link: "https://www.reddit.com/r/askTO/comments/aaa111/best_shawarma_in_toronto/",
          title: "Best shawarma in Toronto : r/askTO",
        },
        {
          link: "https://www.reddit.com/r/toronto/comments/bbb222/best_shawarma_in_downtown_toronto/",
          title: "Best shawarma in downtown Toronto - Reddit",
        },
        {
          link: "https://www.reddit.com/r/toronto/comments/ccc333/the_contrasting_colours_in_the_sky/",
          title: "The contrasting colours in the sky - Reddit",
        },
      ],
      "toronto",
      ["shawarma"],
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.url).toBe(
      "https://www.reddit.com/r/toronto/comments/bbb222/best_shawarma_in_downtown_toronto",
    );
    expect(threads[0]?.title).toBe("Best shawarma in downtown Toronto");
  });

  it("deduplicates Google fallback results by Reddit comment id", () => {
    const threads = parseGoogleRedditThreads(
      [
        {
          link: "https://www.reddit.com/r/toronto/comments/bbb222/best_shawarma_in_downtown_toronto/",
          title: "Best shawarma in downtown Toronto - Reddit",
        },
        {
          link: "https://old.reddit.com/r/toronto/comments/bbb222/best_shawarma_in_downtown_toronto/",
          title: "Best shawarma in downtown Toronto : r/toronto",
        },
      ],
      "toronto",
      ["shawarma"],
    );

    expect(threads).toHaveLength(1);
  });
});

describe("parseRedditThreadDetail", () => {
  it("extracts detail-page freshness and activity metadata", () => {
    const detail = parseRedditThreadDetail(`
      <html>
        <body>
          <div class="thing">
            <time datetime="2026-06-20T12:00:00+00:00">Jun 20, 2026</time>
            <a class="comments">17 comments</a>
          </div>
        </body>
      </html>
    `);

    expect(detail.createdAt).toBe("2026-06-20T12:00:00.000Z");
    expect(detail.commentCount).toBe(17);
    expect(detail.locked).toBe(false);
    expect(detail.archived).toBe(false);
    expect(detail.deleted).toBe(false);
    expect(detail.unavailable).toBe(false);
  });

  it("detects deleted, locked, archived and unavailable thread pages", () => {
    const detail = parseRedditThreadDetail(`
      <html>
        <head><title>Page not found</title></head>
        <body>
          <div class="thing locked">[deleted]</div>
          <p>This post has been removed by moderators.</p>
          <p>This thread is archived. New comments cannot be posted.</p>
          <p>comments locked</p>
        </body>
      </html>
    `);

    expect(detail.deleted).toBe(true);
    expect(detail.locked).toBe(true);
    expect(detail.archived).toBe(true);
    expect(detail.unavailable).toBe(true);
  });
});
