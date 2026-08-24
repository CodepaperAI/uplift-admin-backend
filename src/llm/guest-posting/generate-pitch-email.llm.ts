import type { Blog, Business, GuestPostPublisher } from "@prisma/client";
import { getLLMForKeywords } from "../../config/llm.config";

const llm = getLLMForKeywords();

export interface PitchEmailGenerationData {
  publisher: GuestPostPublisher;
  business: Business;
  submission: {
    title: string;
    proposedTopic?: string;
    blogId?: string;
  };
  blog?: Blog | null;
  user: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

/**
 * Generate personalized pitch email using AI
 */
export async function generatePitchEmailLLM(
  data: PitchEmailGenerationData,
): Promise<{
  subject: string;
  htmlContent: string;
  textContent: string;
  personalization: string;
}> {
  try {
    const { publisher, business, submission, blog, user } = data;

    // Build context for LLM
    const publisherInfo = `
Publisher: ${publisher.name}
Website: ${publisher.websiteUrl}
Niche: ${publisher.niche || "General"}
Contact: ${publisher.contactName || "Editorial Team"}
${
  publisher.submissionGuidelines
    ? `Guidelines: ${publisher.submissionGuidelines.substring(0, 500)}`
    : ""
}
`;

    const businessInfo = `
Business: ${business.businessName}
Type: ${business.businessType || "Business"}
Description: ${business.businessDescription || ""}
Website: ${business.businessWebsiteUrl || ""}
`;

    const articleInfo = `
Article Title: ${submission.title}
${submission.proposedTopic ? `Proposed Topic: ${submission.proposedTopic}` : ""}
${blog ? `Excerpt: ${blog.excerpt || ""}` : ""}
${blog ? `Content Preview: ${blog.content.substring(0, 500)}...` : ""}
`;

    const userName =
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.firstName || user.email?.split("@")[0] || "Content Creator";

    const prompt = `You are an expert at writing compelling guest post pitch emails. Generate a personalized, professional pitch email that:

1. **Personalization**: Start with a brief, genuine personalization (1-2 sentences) that shows you've researched their site. Reference a recent article, their niche, or something specific about their publication.

2. **Clear Value Proposition**: Clearly explain why your article is valuable to their audience.

3. **Professional Tone**: Be friendly but professional, confident but not pushy.

4. **Compliance**: Mention that you've reviewed their submission guidelines (if available).

5. **Call to Action**: End with a clear, friendly call to action.

CONTEXT:
${publisherInfo}

${businessInfo}

${articleInfo}

Writer Name: ${userName}

REQUIREMENTS:
- Keep the email concise (3-4 paragraphs max)
- Personalize the opening based on the publisher's niche/website
- Highlight the value of the article for their audience
- Be professional but approachable
- Include a clear call to action

Generate the email in this JSON format:
{
  "personalization": "1-2 sentence personalization showing you researched their site",
  "emailBody": "Main email body (3-4 paragraphs)",
  "subject": "Compelling subject line (max 60 characters)"
}

Return ONLY valid JSON, no markdown formatting.`;

    const response = await llm.invoke([
      {
        role: "system",
        content:
          "You are an expert email copywriter specializing in guest post pitches. Always return valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ]);

    const responseText = response.content as string;

    // Parse JSON response
    let parsed: {
      personalization: string;
      emailBody: string;
      subject: string;
    };

    try {
      // Clean response - remove markdown code blocks if present
      const cleaned = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("Error parsing AI response:", parseError);
      // Fallback to basic template
      parsed = {
        personalization: `I've been following ${
          publisher.name
        } and appreciate the quality content you publish in the ${
          publisher.niche || ""
        } space.`,
        emailBody: `I'm reaching out because I believe my article "${
          submission.title
        }" would be a great fit for your audience.

${
  submission.proposedTopic ||
  "The article covers topics relevant to your readers and provides valuable insights."
}

I'd love to contribute this piece to ${
          publisher.name
        } and would be happy to make any adjustments you might suggest.`,
        subject: `Guest Post Pitch: ${submission.title}`,
      };
    }

    // Build full email content
    const emailBody = `
${parsed.personalization}

${parsed.emailBody}

Best regards,
${userName}
${business.businessName}
${business.businessWebsiteUrl || ""}
`.trim();

    // Generate HTML and text versions
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .personalization { background-color: #e8f4f8; padding: 15px; border-left: 4px solid #3498db; margin: 20px 0; }
  </style>
</head>
<body>
  <p>Hello ${publisher.contactName || publisher.name} Team,</p>
  
  <div class="personalization">
    <p>${parsed.personalization}</p>
  </div>

  <p>${parsed.emailBody.replace(/\n\n/g, "</p><p>")}</p>

  <p>Best regards,<br>
  ${userName}<br>
  ${business.businessName}<br>
  ${business.businessWebsiteUrl || ""}</p>
</body>
</html>
    `.trim();

    const textContent = emailBody;

    return {
      subject: parsed.subject,
      htmlContent: htmlContent,
      textContent: textContent,
      personalization: parsed.personalization,
    };
  } catch (error: any) {
    console.error("Error generating pitch email:", error);
    throw new Error(`Failed to generate pitch email: ${error.message}`);
  }
}
