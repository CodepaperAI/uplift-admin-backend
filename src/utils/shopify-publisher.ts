import axios from "axios";
import type { PublishResult, BlogPublishData } from "../types/publishing.types";

// ============================================
// GraphQL Queries and Mutations
// ============================================

const GET_BLOGS_QUERY = `
  query GetBlogs($first: Int!) {
    blogs(first: $first) {
      nodes {
        id
        title
        handle
      }
    }
  }
`;

const GET_BLOG_ARTICLES_QUERY = `
  query GetBlogArticles($blogId: ID!, $first: Int!) {
    blog(id: $blogId) {
      handle
      articles(first: $first, sortKey: PUBLISHED_AT, reverse: true) {
        nodes {
          id
          title
          handle
          publishedAt
          isPublished
          tags
          author {
            name
          }
          image {
            originalSrc
            altText
          }
        }
      }
    }
  }
`;

const GET_ARTICLE_BY_ID_QUERY = `
  query GetArticle($id: ID!) {
    article(id: $id) {
      id
      title
      handle
      body
      summary
      tags
      publishedAt
      isPublished
      author {
        name
      }
      blog {
        id
        title
        handle
      }
      image {
        originalSrc
        altText
      }
      metafields(first: 10) {
        nodes {
          id
          namespace
          key
          value
          type
        }
      }
    }
  }
`;

const CREATE_ARTICLE_MUTATION = `
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        title
        author {
          name
        }
        handle
        body
        summary
        tags
        blog {
          id
          handle
          title
        }
        isPublished
        publishedAt
        image {
          originalSrc
          altText
        }
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const UPDATE_ARTICLE_MUTATION = `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        title
        author {
          name
        }
        handle
        body
        summary
        tags
        blog {
          id
          handle
          title
        }
        isPublished
        publishedAt
        image {
          originalSrc
          altText
        }
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const DELETE_ARTICLE_MUTATION = `
  mutation ArticleDelete($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors {
        field
        message
      }
    }
  }
`;

const TEST_CONNECTION_QUERY = `
  query {
    shop {
      id
      name
      email
    }
  }
`;

// ============================================
// GraphQL Executor
// ============================================

async function executeGraphQL(
  shopDomain: string,
  accessToken: string,
  apiVersion: string,
  query: string,
  variables?: any
): Promise<any> {
  const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  const response = await axios.post(
    graphqlUrl,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data.data;
}

// ============================================
// Types
// ============================================

export interface ShopifyCredentials {
  shopDomain: string;
  accessToken?: string;
  oauthAccessToken?: string;
  connectionMethod?: "API_KEY" | "OAUTH" | "CUSTOM_APP";
  apiVersion: string;
  blogId?: string | null;
  apiMethod?: "REST" | "GRAPHQL";
}

// ============================================
// Helper: resolve access token from credentials
// ============================================

function resolveAccessToken(credentials: ShopifyCredentials): string {
  const token =
    credentials.connectionMethod === "OAUTH" && credentials.oauthAccessToken
      ? credentials.oauthAccessToken
      : credentials.accessToken;

  if (!token) {
    throw new Error("Shopify access token is required");
  }
  return token;
}

function normalizeShopDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function toBlogGid(blogId: string): string {
  if (blogId.startsWith("gid://")) return blogId;
  return `gid://shopify/Blog/${blogId}`;
}

function toArticleGid(articleId: string): string {
  if (articleId.startsWith("gid://")) return articleId;
  return `gid://shopify/Article/${articleId}`;
}

function extractNumericId(gid: string): string {
  const match = gid.match(/\/(\d+)$/);
  return match?.[1] ?? gid;
}

function buildShopifyArticleUrl(
  shopDomain: string,
  blogHandle?: string | null,
  articleHandle?: string | null
): string | undefined {
  if (!blogHandle || !articleHandle) {
    return undefined;
  }

  return `https://${normalizeShopDomain(shopDomain)}/blogs/${blogHandle}/${articleHandle}`;
}

// ============================================
// GraphQL: Build SEO metafields
// ============================================

function buildSeoMetafields(blog: BlogPublishData): any[] {
  const metafields: any[] = [];

  if (blog.meta?.seo_title) {
    metafields.push({
      namespace: "global",
      key: "title_tag",
      value: blog.meta.seo_title,
      type: "single_line_text_field",
    });
  }

  if (blog.meta?.seo_description) {
    metafields.push({
      namespace: "global",
      key: "description_tag",
      value: blog.meta.seo_description,
      type: "single_line_text_field",
    });
  }

  return metafields;
}

// ============================================
// GraphQL: Resolve blog GID
// ============================================

async function resolveBlogGid(
  shopDomain: string,
  accessToken: string,
  apiVersion: string,
  blogId?: string | null
): Promise<string> {
  if (blogId) {
    return toBlogGid(blogId);
  }

  const blogsData = await executeGraphQL(
    shopDomain,
    accessToken,
    apiVersion,
    GET_BLOGS_QUERY,
    { first: 10 }
  );

  if (!blogsData.blogs?.nodes || blogsData.blogs.nodes.length === 0) {
    throw new Error("No blog found. Please create a blog in Shopify first.");
  }

  const gid = blogsData.blogs.nodes[0].id;
  console.log(`[Shopify GraphQL] Using blog: ${gid}`);
  return gid;
}

// ============================================
// GraphQL: Create Article
// ============================================

async function publishToShopifyGraphQL(
  blog: BlogPublishData,
  credentials: ShopifyCredentials
): Promise<PublishResult> {
  try {
    const shopDomain = normalizeShopDomain(credentials.shopDomain);
    const accessToken = resolveAccessToken(credentials);

    // If we have an existing external post ID, update instead of create
    if (blog.externalPostId) {
      return await updateShopifyArticleGraphQL(blog, credentials);
    }

    const blogGid = await resolveBlogGid(
      shopDomain,
      accessToken,
      credentials.apiVersion,
      credentials.blogId
    );

    // Build article input
    const articleInput: any = {
      title: blog.title,
      body: blog.content,
      summary: blog.excerpt || undefined,
      handle: blog.slug,
      isPublished: blog.status === "publish",
      blogId: blogGid,
      author: {
        name: blog.meta?.article_author?.trim() || "Uplift AI",
      },
    };

    // Add tags
    if (blog.tags && blog.tags.length > 0) {
      articleInput.tags = blog.tags;
    }

    // Add author
    if (blog.meta?.focus_keyword) {
      // Use focus keyword context — author comes from blog data if available
    }

    // Add featured image
    if (blog.featured_media) {
      articleInput.image = {
        url: blog.featured_media,
        altText: blog.meta?.seo_title || blog.title,
      };
    }

    // Add SEO metafields
    const seoMetafields = buildSeoMetafields(blog);
    if (seoMetafields.length > 0) {
      articleInput.metafields = seoMetafields;
    }

    console.log(`[Shopify GraphQL] Creating article in blog ${blogGid}...`);

    const result = await executeGraphQL(
      shopDomain,
      accessToken,
      credentials.apiVersion,
      CREATE_ARTICLE_MUTATION,
      { article: articleInput }
    );

    if (result.articleCreate?.userErrors?.length > 0) {
      throw new Error(JSON.stringify(result.articleCreate.userErrors));
    }

    const article = result.articleCreate.article;
    const postId = extractNumericId(article.id);
    const postUrl = buildShopifyArticleUrl(
      shopDomain,
      article.blog?.handle,
      article.handle
    );

    console.log(`[Shopify GraphQL] Article created: ${article.id} — ${postUrl ?? "draft"}`);

    return {
      success: true,
      postId,
      postUrl,
      status: article.isPublished ? "published" : "draft",
      platformResponse: article,
    };
  } catch (error: any) {
    console.error("[Shopify GraphQL] Error creating article:", error.message);
    throw new Error(`Failed to create Shopify article via GraphQL: ${error.message}`);
  }
}

// ============================================
// GraphQL: Update Article
// ============================================

async function updateShopifyArticleGraphQL(
  blog: BlogPublishData,
  credentials: ShopifyCredentials
): Promise<PublishResult> {
  try {
    const shopDomain = normalizeShopDomain(credentials.shopDomain);
    const accessToken = resolveAccessToken(credentials);
    const articleGid = toArticleGid(blog.externalPostId!);

    const articleInput: any = {
      title: blog.title,
      body: blog.content,
      summary: blog.excerpt || undefined,
      handle: blog.slug,
      isPublished: blog.status === "publish",
    };

    // Add tags
    if (blog.tags && blog.tags.length > 0) {
      articleInput.tags = blog.tags;
    }

    // Add featured image
    if (blog.featured_media) {
      articleInput.image = {
        url: blog.featured_media,
        altText: blog.meta?.seo_title || blog.title,
      };
    }

    if (blog.meta?.article_author?.trim()) {
      articleInput.author = {
        name: blog.meta.article_author.trim(),
      };
    }

    // Add SEO metafields
    const seoMetafields = buildSeoMetafields(blog);
    if (seoMetafields.length > 0) {
      articleInput.metafields = seoMetafields;
    }

    console.log(`[Shopify GraphQL] Updating article ${articleGid}...`);

    const result = await executeGraphQL(
      shopDomain,
      accessToken,
      credentials.apiVersion,
      UPDATE_ARTICLE_MUTATION,
      { id: articleGid, article: articleInput }
    );

    if (result.articleUpdate?.userErrors?.length > 0) {
      throw new Error(JSON.stringify(result.articleUpdate.userErrors));
    }

    const article = result.articleUpdate.article;
    const postId = extractNumericId(article.id);
    const postUrl = buildShopifyArticleUrl(
      shopDomain,
      article.blog?.handle,
      article.handle
    );

    console.log(`[Shopify GraphQL] Article updated: ${article.id} — ${postUrl ?? "draft"}`);

    return {
      success: true,
      postId,
      postUrl,
      status: article.isPublished ? "published" : "draft",
      platformResponse: article,
    };
  } catch (error: any) {
    console.error("[Shopify GraphQL] Error updating article:", error.message);
    throw new Error(`Failed to update Shopify article via GraphQL: ${error.message}`);
  }
}

// ============================================
// REST: Create Article (legacy fallback)
// ============================================

async function publishToShopifyREST(
  blog: BlogPublishData,
  credentials: ShopifyCredentials
): Promise<PublishResult> {
  try {
    const shopDomain = normalizeShopDomain(credentials.shopDomain);
    const accessToken = resolveAccessToken(credentials);
    const baseUrl = `https://${shopDomain}/admin/api/${credentials.apiVersion}`;

    const headers = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    };

    let blogId = credentials.blogId;

    if (!blogId) {
      const blogsResponse = await axios.get(`${baseUrl}/blogs.json`, { headers });
      if (blogsResponse.data.blogs && blogsResponse.data.blogs.length > 0) {
        blogId = blogsResponse.data.blogs[0].id.toString();
      } else {
        throw new Error("No blog found. Please create a blog in Shopify first.");
      }
    }

    const articleData = {
      article: {
        title: blog.title,
        body_html: blog.content,
        summary: blog.excerpt,
        handle: blog.slug,
        published: blog.status === "publish",
        ...(blog.featured_media && { image: { src: blog.featured_media } }),
        ...(blog.tags && blog.tags.length > 0 && { tags: blog.tags.join(",") }),
      },
    };

    const response = await axios.post(
      `${baseUrl}/blogs/${blogId}/articles.json`,
      articleData,
      { headers }
    );

    const article = response.data.article;

    return {
      success: true,
      postId: String(article.id),
      postUrl: article.url,
      status: article.published ? "published" : "draft",
      platformResponse: article,
    };
  } catch (error: any) {
    throw new Error(
      error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : `Failed to create Shopify article: ${error.message}`
    );
  }
}

// ============================================
// Exported: Publish (routes to GraphQL or REST)
// ============================================

export async function publishToShopify(
  blog: BlogPublishData,
  credentials: ShopifyCredentials
): Promise<PublishResult> {
  const apiMethod = credentials.apiMethod || "GRAPHQL";

  if (apiMethod === "GRAPHQL") {
    return await publishToShopifyGraphQL(blog, credentials);
  } else {
    return await publishToShopifyREST(blog, credentials);
  }
}

// ============================================
// Exported: Update Article
// ============================================

export async function updateShopifyArticle(
  blog: BlogPublishData,
  credentials: ShopifyCredentials
): Promise<PublishResult> {
  return await updateShopifyArticleGraphQL(blog, credentials);
}

// ============================================
// Exported: Delete Article
// ============================================

export async function deleteShopifyArticle(
  articleId: string,
  credentials: ShopifyCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const shopDomain = normalizeShopDomain(credentials.shopDomain);
    const accessToken = resolveAccessToken(credentials);
    const articleGid = toArticleGid(articleId);

    const result = await executeGraphQL(
      shopDomain,
      accessToken,
      credentials.apiVersion,
      DELETE_ARTICLE_MUTATION,
      { id: articleGid }
    );

    if (result.articleDelete?.userErrors?.length > 0) {
      throw new Error(JSON.stringify(result.articleDelete.userErrors));
    }

    console.log(`[Shopify GraphQL] Article deleted: ${articleGid}`);
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to delete article",
    };
  }
}

// ============================================
// Exported: Get Article by ID
// ============================================

export async function getShopifyArticle(
  articleId: string,
  credentials: ShopifyCredentials
): Promise<any> {
  const shopDomain = normalizeShopDomain(credentials.shopDomain);
  const accessToken = resolveAccessToken(credentials);
  const articleGid = toArticleGid(articleId);

  const result = await executeGraphQL(
    shopDomain,
    accessToken,
    credentials.apiVersion,
    GET_ARTICLE_BY_ID_QUERY,
    { id: articleGid }
  );

  return result.article;
}

// ============================================
// Exported: List Blogs
// ============================================

export async function listShopifyBlogs(
  credentials: ShopifyCredentials
): Promise<{ id: string; title: string; handle: string }[]> {
  const shopDomain = normalizeShopDomain(credentials.shopDomain);
  const accessToken = resolveAccessToken(credentials);

  const result = await executeGraphQL(
    shopDomain,
    accessToken,
    credentials.apiVersion,
    GET_BLOGS_QUERY,
    { first: 50 }
  );

  return result.blogs?.nodes || [];
}

// ============================================
// Exported: List Blog Articles
// ============================================

export async function listShopifyBlogArticles(
  blogId: string,
  credentials: ShopifyCredentials,
  first: number = 50
): Promise<any[]> {
  const shopDomain = normalizeShopDomain(credentials.shopDomain);
  const accessToken = resolveAccessToken(credentials);
  const blogGid = toBlogGid(blogId);

  const result = await executeGraphQL(
    shopDomain,
    accessToken,
    credentials.apiVersion,
    GET_BLOG_ARTICLES_QUERY,
    { blogId: blogGid, first }
  );

  return result.blog?.articles?.nodes || [];
}

// ============================================
// Exported: Test Connection
// ============================================

export async function testShopifyConnection(
  credentials: ShopifyCredentials
): Promise<{ success: boolean; error?: string }> {
  const apiMethod = credentials.apiMethod || "GRAPHQL";

  if (apiMethod === "GRAPHQL") {
    try {
      const shopDomain = normalizeShopDomain(credentials.shopDomain);
      const accessToken = resolveAccessToken(credentials);

      const result = await executeGraphQL(
        shopDomain,
        accessToken,
        credentials.apiVersion,
        TEST_CONNECTION_QUERY
      );

      if (result.shop) {
        return { success: true };
      }

      return { success: false, error: "Invalid response from Shopify" };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Shopify via GraphQL",
      };
    }
  } else {
    // REST fallback for legacy integrations
    try {
      const shopDomain = normalizeShopDomain(credentials.shopDomain);
      const accessToken = resolveAccessToken(credentials);
      const baseUrl = `https://${shopDomain}/admin/api/${credentials.apiVersion}`;

      const response = await axios.get(`${baseUrl}/shop.json`, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });

      if (response.status === 200 && response.data.shop) {
        return { success: true };
      }

      return { success: false, error: "Invalid response from Shopify" };
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message || "Failed to connect to Shopify",
      };
    }
  }
}
