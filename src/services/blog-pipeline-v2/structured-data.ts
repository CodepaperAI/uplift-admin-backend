import { load } from "cheerio";

import { buildBlogCanonicalUrl } from "../../utils/blog-seo.utils";

export type ProductionBlogStructuredData = Record<string, unknown>;

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildProductionBlogStructuredData(input: {
  title: string;
  excerpt: string;
  slug: string;
  keyword: string;
  locale: string;
  images: string[];
  authorName: string;
  businessName: string;
  businessWebsiteUrl: string;
  publishDate: string;
  modifiedDate?: string;
  categories?: string[];
  tags?: string[];
}): ProductionBlogStructuredData[] {
  const canonicalUrl = buildBlogCanonicalUrl({
    websiteUrl: input.businessWebsiteUrl,
    slug: input.slug,
  });
  const websiteUrl = new URL(input.businessWebsiteUrl).toString();
  const blogIndexUrl = new URL("blog", websiteUrl.endsWith("/") ? websiteUrl : `${websiteUrl}/`).toString();
  const keywords = [input.keyword, ...(input.tags ?? [])]
    .map(normalizedText)
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);

  return [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "@id": `${canonicalUrl}#blogposting`,
      url: canonicalUrl,
      mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
      headline: input.title,
      description: input.excerpt,
      ...(input.images.length > 0 ? { image: input.images } : {}),
      datePublished: input.publishDate,
      dateModified: input.modifiedDate ?? input.publishDate,
      inLanguage: input.locale,
      keywords: keywords.join(", "),
      articleSection: input.categories?.[0] ?? "Blog",
      author: { "@type": "Person", name: input.authorName },
      publisher: {
        "@type": "Organization",
        name: input.businessName,
        url: websiteUrl,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "@id": `${canonicalUrl}#breadcrumb`,
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: websiteUrl,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Blog",
          item: blogIndexUrl,
        },
        {
          "@type": "ListItem",
          position: 3,
          name: input.title,
          item: canonicalUrl,
        },
      ],
    },
  ];
}

export function appendProductionBlogStructuredData(
  html: string,
  structuredData: ProductionBlogStructuredData[],
): string {
  const $ = load(html, null, false);
  $('script[type="application/ld+json"][data-uplift-schema]').remove();
  const articleHtml = $.html().trim();
  const scripts = structuredData.map((schema) => {
    const type = String(schema["@type"] ?? "StructuredData")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const serialized = JSON.stringify(schema).replace(/<\//g, "<\\/");
    return `<script type="application/ld+json" data-uplift-schema="${type}">${serialized}</script>`;
  });
  return [articleHtml, ...scripts].join("\n");
}
