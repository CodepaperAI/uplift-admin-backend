"use node";

import { GoogleGenAI } from "@google/genai";

interface ImageGenerationResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

interface GenerateImageOptions {
  prompt: string;
}

interface GMBImageContext {
  businessName: string;
  businessType?: string;
  postTitle: string;
  postType: string;
  postSummary?: string;
}

class ImageGenerationService {
  private genAI: GoogleGenAI;

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.GOOGLE_API_KEY!,
    });
  }

  async generateImage(options: GenerateImageOptions): Promise<ImageGenerationResult> {
    const { prompt } = options;

    try {
      const response = await this.genAI.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: this.sanitizePrompt(prompt),
      });

      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts) {
        return { success: false, error: "No image generated" };
      }

      for (const part of candidate.content.parts) {
        if ((part as { inlineData?: { data: string; mimeType: string } }).inlineData) {
          const { data, mimeType } = (part as { inlineData: { data: string; mimeType: string } }).inlineData;
          const base64Uri = `data:${mimeType};base64,${data}`;

          const { uploadBase64Image } = await import("../lib/image-storage");
          const imageUrl = await uploadBase64Image(base64Uri);

          return { success: true, imageUrl };
        }
      }

      return { success: false, error: "No image in response" };
    } catch (error) {
      console.error("Image generation failed:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: errorMessage };
    }
  }

  async generateGMBPostImage(
    businessName: string,
    postTitle: string,
    postType: string,
    businessType?: string,
    postSummary?: string
  ): Promise<ImageGenerationResult> {
    const context: GMBImageContext = {
      businessName,
      businessType,
      postTitle,
      postType,
      postSummary,
    };

    let imagePrompt: string;
    try {
      imagePrompt = await this.craftVisualPrompt(context);
    } catch (error) {
      console.warn(
        "[Image Gen] Visual prompt generation failed, using fallback:",
        error
      );
      imagePrompt = this.buildFallbackImagePrompt(context);
    }

    return this.generateImage({ prompt: imagePrompt });
  }

  private async craftVisualPrompt(context: GMBImageContext): Promise<string> {
    const instructions = this.buildVisualPromptInstructions(context);

    const response = await this.genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: instructions,
    });

    const text = response.candidates?.[0]?.content?.parts
      ?.map((p) => (p as { text?: string }).text || "")
      .join("")
      .trim();

    if (!text) {
      throw new Error("Empty visual prompt response");
    }

    return text;
  }

  private buildVisualPromptInstructions(context: GMBImageContext): string {
    const {
      businessName,
      businessType,
      postTitle,
      postType,
      postSummary,
    } = context;

    return `You are writing an image-generation prompt for a Google My Business social post.

BUSINESS NAME: ${businessName}
BUSINESS CATEGORY: ${businessType || "(not provided)"}
POST TYPE: ${postType}
POST TITLE: ${postTitle}
POST CONTENT: ${postSummary || "(not provided)"}

Write a single concise paragraph (max 120 words) describing a photograph for this post. The description must:

- Depict a scene that is unmistakably specific to this exact BUSINESS CATEGORY. Read the category literally — for example "Mobile phone repair shop" means smartphones and repair tools, NOT cars or a mechanic's garage; "Pet groomer" means dogs/cats and grooming tools, NOT a veterinary clinic.
- Show real-world environments, tools, products, or activities a customer would actually recognize at this business.
- Reflect the post topic from the title and content (e.g. if the post is about iPhone screen repair, show a technician working on a phone screen).
- Match the mood for the post type: OFFER = energetic and value-driven, EVENT = community and celebration, PRODUCT = clean and appealing, UPDATE = welcoming and professional.
- Use natural lighting, authentic colors, and modern photography style.
- Contain NO text, logos, watermarks, or readable signage of any kind.

Output only the prompt paragraph itself — no preamble, no headings, no quotation marks.`;
  }

  private buildFallbackImagePrompt(context: GMBImageContext): string {
    const {
      businessName,
      businessType,
      postTitle,
      postType,
      postSummary,
    } = context;

    const typeContext = this.getPostTypeContext(postType);
    const businessLabel = businessType
      ? `a "${businessType}" business`
      : "a local business";
    const summaryLine = postSummary
      ? `\nPOST CONTENT: "${postSummary}"`
      : "";

    return `Create a professional, authentic photograph for ${businessLabel} named "${businessName}".

SUBJECT: Visually represent "${postTitle}" in a way that is unmistakably specific to ${businessLabel}.${summaryLine}

${typeContext}

REQUIREMENTS:
- The scene must be specific to ${businessLabel} — read the business category literally and depict its actual environment, tools, products, or activities.
- Do NOT depict a different industry, even if it sounds related.
- Do NOT include any text, logos, watermarks, or readable signage.
- Use natural lighting and authentic colors appropriate for this industry.
- The composition should feel like a real photograph taken at the business location.

STYLE: Modern, clean, inviting, professional quality.
MOOD: Welcoming and trustworthy.
FORMAT: High quality, 1024x1024px, optimized for Google My Business.`;
  }

  private getPostTypeContext(postType: string): string {
    switch (postType.toUpperCase()) {
      case "OFFER":
        return "The image should convey excitement, value, and urgency - suitable for a special offer or promotion.";
      case "EVENT":
        return "The image should convey community, celebration, or gathering - suitable for an event announcement.";
      case "PRODUCT":
        return "The image should showcase quality and appeal - suitable for highlighting a product or service.";
      case "UPDATE":
      default:
        return "The image should be welcoming and professional - suitable for a business update or news.";
    }
  }

  private sanitizePrompt(prompt: string): string {
    return prompt
      .replace(/[^\w\s.,!?'"()-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  }
}

export const imageGenerationService = new ImageGenerationService();
