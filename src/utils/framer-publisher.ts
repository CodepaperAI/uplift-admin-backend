import { connect } from "framer-api";
import type { PublishResult, BlogPublishData } from "../types/publishing.types";

interface FramerCredentials {
  projectId: string;
  apiKey: string;
  collectionName?: string | null;
}

interface FieldMapping {
  titleFieldId?: string;
  contentFieldId?: string;
  excerptFieldId?: string;
  imageFieldId?: string;
  tagsFieldId?: string;
}

async function createFramerConnection(credentials: FramerCredentials) {
  const projectUrl = `https://framer.com/projects/${credentials.projectId}`;
  return await connect(projectUrl, credentials.apiKey);
}

async function resolveCollection(framer: any, collectionNameOrId: string) {
  const collectionRef = collectionNameOrId.trim();

  const collectionById = await framer
    .getCollection(collectionRef)
    .catch(() => null);
  if (collectionById) {
    return collectionById;
  }

  const collections = await framer.getCollections();
  const normalizedRef = collectionRef.toLowerCase();
  const collectionByName = collections.find(
    (collection: { id: string; name: string }) =>
      collection.id === collectionRef ||
      collection.name.toLowerCase().trim() === normalizedRef,
  );

  if (!collectionByName) {
    const available = collections
      .map((collection: { name: string }) => collection.name)
      .filter(Boolean)
      .slice(0, 10)
      .join(", ");
    throw new Error(
      `Could not find Framer CMS collection "${collectionRef}".` +
        (available ? ` Available collections: ${available}` : ""),
    );
  }

  return collectionByName;
}

async function discoverFieldMapping(collection: any): Promise<FieldMapping> {
  const fields = await collection.getFields();
  const mapping: FieldMapping = {};

  for (const field of fields) {
    const name = field.name.toLowerCase().trim();

    if (
      !mapping.titleFieldId &&
      ["title", "name", "post title", "post-title", "blog title"].includes(name)
    ) {
      mapping.titleFieldId = field.id;
    }
    if (
      !mapping.contentFieldId &&
      ["content", "body", "post body", "post-body", "article", "blog content"].includes(name)
    ) {
      mapping.contentFieldId = field.id;
    }
    if (
      !mapping.excerptFieldId &&
      ["excerpt", "summary", "description", "short description"].includes(name)
    ) {
      mapping.excerptFieldId = field.id;
    }
    if (
      !mapping.imageFieldId &&
      [
        "featured image",
        "cover",
        "thumbnail",
        "image",
        "hero image",
        "featured-image",
        "cover image",
        "hero",
      ].includes(name)
    ) {
      mapping.imageFieldId = field.id;
    }
    if (
      !mapping.tagsFieldId &&
      ["tags", "categories", "labels", "topic", "topics"].includes(name)
    ) {
      mapping.tagsFieldId = field.id;
    }
  }

  return mapping;
}

export async function publishToFramer(
  blog: BlogPublishData,
  credentials: FramerCredentials
): Promise<PublishResult> {
  if (!credentials.collectionName) {
    throw new Error(
      "Collection name is required. Please provide a Framer CMS collection name."
    );
  }

  let framer: any = null;

  try {
    framer = await createFramerConnection(credentials);

    const collection = await resolveCollection(framer, credentials.collectionName);
    const mapping = await discoverFieldMapping(collection);

    if (!mapping.titleFieldId) {
      throw new Error(
        `Could not find a "Title" field in the "${credentials.collectionName}" collection. ` +
          `Please ensure your collection has a field named "Title", "Name", or "Post Title".`
      );
    }

    const fieldData: Record<string, any> = {};

    if (mapping.titleFieldId) {
      fieldData[mapping.titleFieldId] = { type: "string", value: blog.title };
    }
    if (mapping.contentFieldId) {
      fieldData[mapping.contentFieldId] = {
        type: "formattedText",
        value: blog.content,
        contentType: "html",
      };
    }
    if (mapping.excerptFieldId) {
      fieldData[mapping.excerptFieldId] = {
        type: "string",
        value: blog.excerpt,
      };
    }
    if (mapping.imageFieldId && blog.featured_media) {
      fieldData[mapping.imageFieldId] = {
        type: "image",
        value: blog.featured_media,
        alt: blog.title,
      };
    }
    if (mapping.tagsFieldId && blog.tags && blog.tags.length > 0) {
      fieldData[mapping.tagsFieldId] = {
        type: "string",
        value: blog.tags.join(", "),
      };
    }

    const itemId = blog.id;

    await collection.addItems([
      {
        id: itemId,
        slug: blog.slug,
        draft: blog.status !== "publish",
        fieldData,
      },
    ]);

    console.log(`[Framer] CMS entry created/updated: ${itemId}`);

    return {
      success: true,
      postId: itemId,
      postUrl: blog.slug,
      status: blog.status === "publish" ? "published" : "draft",
      platformResponse: { itemId, slug: blog.slug, fieldMapping: mapping },
    };
  } catch (error: any) {
    console.error("[Framer] Error creating CMS entry:", error.message);
    throw new Error(
      error.message || `Failed to create Framer entry: ${error.message}`
    );
  } finally {
    if (framer) {
      try {
        await framer.disconnect();
      } catch (disconnectError) {
        console.warn(
          "[Framer] Warning: failed to disconnect cleanly:",
          disconnectError
        );
      }
    }
  }
}

export async function testFramerConnection(
  credentials: FramerCredentials
): Promise<{ success: boolean; error?: string }> {
  let framer: any = null;

  try {
    framer = await createFramerConnection(credentials);

    if (credentials.collectionName) {
      const collection = await resolveCollection(framer, credentials.collectionName);
      const fields = await collection.getFields();
      console.log(
        `[Framer] Test: Found collection "${credentials.collectionName}" with ${fields.length} fields`
      );
    }

    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to connect to Framer",
    };
  } finally {
    if (framer) {
      try {
        await framer.disconnect();
      } catch {
        // Ignore disconnect errors during test
      }
    }
  }
}
