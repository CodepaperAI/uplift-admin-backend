import type { GuestPostSubmission } from "@prisma/client";
import { getLLMForKeywords } from "../../config/llm.config";

const llm = getLLMForKeywords();

export type SubmissionWithPublisher = GuestPostSubmission & {
  publisher?: { name?: string | null; contactEmail?: string | null } | null;
};

export interface EmailReplyParseResult {
  status: "ACCEPTED" | "REJECTED" | "NEEDS_FOLLOWUP" | "UNKNOWN";
  publishedUrl?: string;
  rejectionReason?: string;
  confidence: number;
  extractedInfo?: {
    nextSteps?: string;
    deadline?: string;
    requirements?: string[];
  };
}

/**
 * Parse email reply to determine submission status
 */
export async function parseEmailReplyLLM(
  emailContent: string,
  submission: SubmissionWithPublisher,
): Promise<EmailReplyParseResult> {
  try {
    const publisherName = submission.publisher?.name ?? "Unknown";
    const publisherEmail = submission.publisher?.contactEmail ?? "Unknown";
    const prompt = `You are an expert at parsing email replies for guest post submissions. Analyze this email reply and determine the status of the guest post submission.

SUBMISSION CONTEXT:
- Title: ${submission.title}
- Publisher: ${publisherName}
- Publisher Email: ${publisherEmail}
- Current Status: ${submission.status}

EMAIL REPLY:
${emailContent}

TASK:
Analyze this email reply and determine:
1. Is the submission ACCEPTED, REJECTED, or needs FOLLOWUP?
2. If accepted, extract any published URL mentioned
3. If rejected, extract the rejection reason
4. Confidence level (0-1) of your analysis

Look for keywords:
- ACCEPTED: "accepted", "approved", "we'd love to publish", "great fit", "publish your article", "live at", "published here"
- REJECTED: "not a fit", "decline", "reject", "not interested", "doesn't align", "unfortunately"
- FOLLOWUP: "need more info", "revise", "make changes", "update", "questions", "clarify"

Return JSON in this format:
{
  "status": "ACCEPTED" | "REJECTED" | "NEEDS_FOLLOWUP" | "UNKNOWN",
  "publishedUrl": "url if mentioned, otherwise null",
  "rejectionReason": "reason if rejected, otherwise null",
  "confidence": 0.0-1.0,
  "extractedInfo": {
    "nextSteps": "any next steps mentioned",
    "deadline": "any deadline mentioned",
    "requirements": ["list of requirements if any"]
  }
}

Return ONLY valid JSON, no markdown formatting.`;

    const response = await llm.invoke([
      {
        role: "system",
        content:
          "You are an expert at parsing email replies. Always return valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ]);

    const responseText = response.content as string;

    // Parse JSON response
    let parsed: EmailReplyParseResult;

    try {
      // Clean response - remove markdown code blocks if present
      const cleaned = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("Error parsing AI response:", parseError);
      // Fallback: basic keyword matching
      const lowerContent = emailContent.toLowerCase();

      if (
        lowerContent.includes("accepted") ||
        lowerContent.includes("approved") ||
        lowerContent.includes("publish") ||
        lowerContent.includes("live at")
      ) {
        parsed = {
          status: "ACCEPTED",
          confidence: 0.6,
        };
      } else if (
        lowerContent.includes("reject") ||
        lowerContent.includes("decline") ||
        lowerContent.includes("not a fit") ||
        lowerContent.includes("unfortunately")
      ) {
        parsed = {
          status: "REJECTED",
          confidence: 0.6,
          rejectionReason: "Rejected based on email content",
        };
      } else {
        parsed = {
          status: "UNKNOWN",
          confidence: 0.3,
        };
      }
    }

    // Extract published URL if mentioned
    if (!parsed.publishedUrl) {
      const urlMatch = emailContent.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi);
      if (urlMatch && urlMatch.length > 0) {
        parsed.publishedUrl = urlMatch[0];
      }
    }

    return parsed;
  } catch (error: any) {
    console.error("Error parsing email reply:", error);
    return {
      status: "UNKNOWN",
      confidence: 0.0,
    };
  }
}
