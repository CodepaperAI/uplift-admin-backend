import { hasVisibleFreshnessIndicators } from "../utils/blog-seo.utils";

export function calculateSEOScore(data: {
  title: string;
  content: string;
  seoTitle: string;
  seoDescription: string;
  focusKeyword: string;
  excerpt: string;
  slug: string;
  metaKeywords?: string[];
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  ogUrl?: string;
  ogSiteName?: string;
  ogLocale?: string;
  articleAuthor?: string;
  articleSection?: string;
  articleTags?: string[];
}): number {
  let score = 0;
  const maxScore = 100;

  const keywordLower = data.focusKeyword.toLowerCase();
  const titleLower = data.title.toLowerCase();
  const contentLower = data.content.toLowerCase();
  const seoTitleLower = data.seoTitle.toLowerCase();
  const seoDescLower = data.seoDescription.toLowerCase();
  const excerptLower = data.excerpt.toLowerCase();
  const slugLower = data.slug.toLowerCase();

  // 1. Title Optimization (15 points)
  const titleLength = data.title.length;
  if (titleLength >= 30 && titleLength <= 60) {
    score += 10;
  } else if (titleLength > 0 && titleLength < 70) {
    score += 5;
  }
  if (titleLower.includes(keywordLower)) {
    score += 5;
  }

  // 2. SEO Title (15 points) - ENHANCED
  const seoTitleLength = data.seoTitle.length;
  if (seoTitleLength >= 30 && seoTitleLength <= 60) {
    score += 10;
  } else if (seoTitleLength > 0 && seoTitleLength < 70) {
    score += 5;
  }
  if (seoTitleLower.includes(keywordLower)) {
    score += 5;
  }

  // 3. SEO Description (15 points) - ENHANCED
  const seoDescLength = data.seoDescription.length;
  if (seoDescLength >= 120 && seoDescLength <= 160) {
    score += 10;
  } else if (seoDescLength > 0 && seoDescLength < 165) {
    score += 5;
  }
  if (seoDescLower.includes(keywordLower)) {
    score += 5;
  }

  // 4. Focus Keyword in Content (15 points)
  if (keywordLower && keywordLower.trim().length > 0) {
    const keywordCount = (
      contentLower.match(
        new RegExp(keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      ) || []
    ).length;

    if (keywordCount >= 3 && keywordCount <= 10) {
      score += 15;
    } else if (keywordCount >= 1 && keywordCount < 15) {
      score += 10;
    } else if (keywordCount > 0) {
      score += 5;
    }
  }

  // 5. Content Length (20 points) - ENHANCED
  const wordCount = data.content
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
  if (wordCount >= 2000) {
    score += 20;
  } else if (wordCount >= 1000) {
    score += 18;
  } else if (wordCount >= 500) {
    score += 12;
  } else if (wordCount >= 300) {
    score += 8;
  } else if (wordCount >= 200) {
    score += 5;
  }

  // 6. Slug Optimization (15 points) - ENHANCED
  if (data.slug.length > 0 && data.slug.length <= 50) {
    score += 10;
  } else if (data.slug.length > 0) {
    score += 5;
  }
  const keywordSlug = keywordLower.replace(/\s+/g, "-");
  if (slugLower.includes(keywordSlug)) {
    score += 5;
  }

  // 7. Excerpt/Description (15 points) - ENHANCED
  const excerptLength = data.excerpt.length;
  if (excerptLength >= 120 && excerptLength <= 160) {
    score += 10;
  } else if (excerptLength > 0) {
    score += 5;
  }
  if (excerptLower.includes(keywordLower)) {
    score += 5;
  }

  // 8. Heading Structure (15 points) - ENHANCED
  const h1Count = (data.content.match(/<h1[^>]*>/gi) || []).length;
  const h2Count = (data.content.match(/<h2[^>]*>/gi) || []).length;
  const h3Count = (data.content.match(/<h3[^>]*>/gi) || []).length;

  if (h1Count === 1) {
    score += 5;
    const h1Matches = data.content.match(/<h1[^>]*>(.*?)<\/h1>/gi);
    if (
      h1Matches &&
      h1Matches.some((h1) => h1.toLowerCase().includes(keywordLower))
    ) {
      score += 2;
    }
  }
  if (h2Count >= 2) {
    score += 5;
    const h2Matches = data.content.match(/<h2[^>]*>(.*?)<\/h2>/gi);
    if (
      h2Matches &&
      h2Matches.some((h2) => h2.toLowerCase().includes(keywordLower))
    ) {
      score += 3;
    }
  }
  if (h3Count >= 3) {
    score += 2;
  }
  // Reward stable H2 anchor IDs — enables fragment URL citations (#some-heading)
  // that LLMs and Google use for deep-link references.
  if (h2Count >= 2) {
    const h2WithIdCount = (
      data.content.match(/<h2\b[^>]*\bid\s*=\s*["'][^"']+["'][^>]*>/gi) || []
    ).length;
    if (h2WithIdCount >= h2Count) {
      score += 2;
    } else if (h2WithIdCount >= Math.ceil(h2Count / 2)) {
      score += 1;
    }
  }

  // 9. Internal/External Links (10 points) - NEW
  const linkCount = (
    data.content.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi) || []
  ).length;
  if (linkCount >= 5) {
    score += 10;
  } else if (linkCount >= 3) {
    score += 7;
  } else if (linkCount >= 1) {
    score += 4;
  }

  // 10. Images with Alt Text (10 points) - NEW
  const imageCount = (data.content.match(/<img[^>]*>/gi) || []).length;
  const imagesWithAlt = (
    data.content.match(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi) || []
  ).length;
  if (imageCount > 0) {
    const altTextRatio = imagesWithAlt / imageCount;
    if (altTextRatio === 1) {
      score += 10;
    } else if (altTextRatio >= 0.8) {
      score += 7;
    } else if (altTextRatio >= 0.5) {
      score += 4;
    }
    const altTexts =
      data.content.match(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi) || [];
    if (altTexts.some((alt) => alt.toLowerCase().includes(keywordLower))) {
      score += 2;
    }
  }

  // 11. Structured data (5 points). The model intentionally does not emit
  // JSON-LD; rendering/publishing adapters build it from verified DB fields.
  score += 5;

  // 12. Meta Keywords (5 points) - NEW
  if (data.metaKeywords && data.metaKeywords.length >= 3) {
    score += 5;
  }

  // 13. Speakable Schema (5 points) - SEO 2026
  if (
    data.content.includes("SpeakableSpecification") ||
    data.content.includes("speakable")
  ) {
    score += 5;
  }

  // 14. Author/Person Schema (5 points) - SEO 2026
  if (
    data.content.includes('"@type":"Person"') ||
    data.content.includes('"@type": "Person"')
  ) {
    score += 5;
  }

  // 15. Content Freshness - dateModified (3 points) - SEO 2026
  if (
    hasVisibleFreshnessIndicators(data.content) &&
    (data.content.includes("dateModified") ||
      data.content.includes("datePublished"))
  ) {
    score += 3;
  }

  // 16. Statistics/Citation Density (5 points) - SEO 2026
  // Check for numbers/percentages/data points in content
  const statsMatches = contentLower.match(
    /\d+(\.\d+)?%|\d{1,3}(,\d{3})+|\$\d+|\d+x\b|according to|study (found|shows|reveals)|research (shows|indicates|suggests)/gi
  );
  const statsCount = statsMatches ? statsMatches.length : 0;
  if (statsCount >= 10) {
    score += 5;
  } else if (statsCount >= 5) {
    score += 3;
  } else if (statsCount >= 2) {
    score += 1;
  }

  // 17. Direct Answer in First 50 Words (5 points) - SEO 2026
  // Check if the first paragraph contains a definitive statement
  const firstParagraphMatch = data.content.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (firstParagraphMatch) {
    const firstParagraph = firstParagraphMatch[1]?.replace(/<[^>]*>/g, '') || '';
    const firstWords = firstParagraph.split(/\s+/).slice(0, 60).join(' ').toLowerCase();
    // Check for definitive language patterns
    if (
      firstWords.match(/\b(is|are|refers to|means|involves|requires|provides|offers|delivers|ensures)\b/) &&
      firstWords.length > 100
    ) {
      score += 5;
    } else if (firstWords.length > 50) {
      score += 2;
    }
  }

  // 18. Complete OG Metadata (3 points) - SEO 2026
  const hasCompleteOgMetadata = Boolean(
    data.ogTitle &&
      data.ogDescription &&
      data.ogType &&
      data.ogUrl &&
      data.ogSiteName &&
      data.ogLocale &&
      data.articleAuthor &&
      data.articleSection &&
      data.articleTags &&
      data.articleTags.length > 0,
  );

  if (hasCompleteOgMetadata) {
    score += 3;
  }

  return Math.min(score, maxScore);
}
