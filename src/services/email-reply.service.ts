import Imap from "imap";
import { simpleParser } from "mailparser";
import { prisma } from "../config/db.config";
import { parseEmailReplyLLM } from "../llm/guest-posting/parse-email-reply.llm";
import { EmailService } from "./email.service";

interface IMAPConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

/**
 * Service for checking email replies via IMAP
 */
export class EmailReplyService {
  private emailService: EmailService;
  private imapConfig: IMAPConfig | null = null;

  constructor() {
    this.emailService = new EmailService();

    // Load IMAP config from environment
    if (
      process.env.IMAP_HOST &&
      process.env.IMAP_USER &&
      process.env.IMAP_PASSWORD
    ) {
      this.imapConfig = {
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT || "993"),
        secure: process.env.IMAP_SECURE !== "false", // Default to true (SSL)
        user: process.env.IMAP_USER,
        password: process.env.IMAP_PASSWORD,
      };
    }
  }

  /**
   * Check if IMAP is configured
   */
  isConfigured(): boolean {
    return this.imapConfig !== null;
  }

  /**
   * Check for email replies for a specific submission
   */
  async checkReplyForSubmission(
    submissionId: string
  ): Promise<{
    found: boolean;
    replyContent?: string;
    parsedStatus?: any;
  }> {
    if (!this.isConfigured()) {
      console.warn("⚠️ IMAP not configured. Cannot check email replies.");
      return { found: false };
    }

    try {
      // Get submission with email info
      const submission = await prisma.guestPostSubmission.findUnique({
        where: { id: submissionId },
        include: {
          publisher: {
            select: {
              id: true,
              name: true,
              contactEmail: true,
            },
          },
        },
      });

      if (!submission || !submission.emailId || !submission.emailSentAt) {
        return { found: false };
      }

      // Get the reply-to email (from the original email)
      const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.IMAP_USER;
      if (!fromEmail) {
        return { found: false };
      }

      // Validate publisher exists
      if (!submission.publisher || !submission.publisher.contactEmail) {
        console.warn(`⚠️ Publisher or contact email missing for submission ${submissionId}`);
        return { found: false };
      }

      // Check for replies in the inbox
      // Include subject matching for better accuracy (match by submission title)
      const subjectMatch = submission.title
        ? `Re: Guest Post Pitch: ${submission.title}`
        : undefined;

      const replies = await this.checkInboxForReplies(
        fromEmail,
        submission.publisher.contactEmail,
        submission.emailSentAt,
        subjectMatch
      );

      if (replies.length === 0) {
        return { found: false };
      }

      const latestReply = replies[0];
      if (!latestReply) {
        return { found: false };
      }

      const replyContent = latestReply.text || latestReply.html || "";
      if (!replyContent || replyContent.trim().length < 10) {
        console.warn(`⚠️ Reply content too short for submission ${submissionId}`);
        return { found: false };
      }

      // Parse the reply using LLM
      const parsedStatus = await parseEmailReplyLLM(replyContent, submission);

      // Update submission with reply
      await prisma.guestPostSubmission.update({
        where: { id: submissionId },
        data: {
          emailRepliedAt: latestReply.date,
          emailReplyContent: latestReply.text || latestReply.html,
          // Update status based on parsed result
          ...(parsedStatus.status === "ACCEPTED" && {
            status: "ACCEPTED",
            acceptedAt: latestReply.date,
          }),
          ...(parsedStatus.status === "REJECTED" && {
            status: "REJECTED",
            rejectedAt: latestReply.date,
            rejectionReason: parsedStatus.rejectionReason,
          }),
          ...(parsedStatus.publishedUrl && {
            publishedUrl: parsedStatus.publishedUrl,
            status: "PUBLISHED",
            publishedAt: latestReply.date,
          }),
        },
      });

      return {
        found: true,
        replyContent: latestReply.text || latestReply.html,
        parsedStatus,
      };
    } catch (error: any) {
      console.error(`Error checking reply for submission ${submissionId}:`, error);
      return { found: false };
    }
  }

  /**
   * Check inbox for replies to a specific email
   * Includes timeout and retry logic
   */
  private async checkInboxForReplies(
    fromEmail: string,
    toEmail: string,
    sinceDate: Date,
    subjectMatch?: string
  ): Promise<
    Array<{
      text?: string;
      html?: string;
      date: Date;
      subject?: string;
      inReplyTo?: string;
    }>
  > {
    if (!this.imapConfig) {
      return [];
    }

    const timeoutMs = 30000; // 30 seconds timeout
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Wait before retry (exponential backoff)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 1000)
          );
          console.log(`🔄 Retrying IMAP connection (attempt ${attempt + 1}/${maxRetries + 1})...`);
        }

        const result = await Promise.race([
          this._performImapSearch(fromEmail, toEmail, sinceDate, subjectMatch),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("IMAP connection timeout")), timeoutMs)
          ),
        ]);

        return result;
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries) {
          console.warn(`⚠️ IMAP connection failed (attempt ${attempt + 1}):`, error.message);
          continue;
        }
      }
    }

    console.error("❌ IMAP connection failed after all retries:", lastError);
    throw lastError || new Error("IMAP connection failed");
  }

  /**
   * Perform the actual IMAP search (internal method)
   */
  private _performImapSearch(
    fromEmail: string,
    toEmail: string,
    sinceDate: Date,
    subjectMatch?: string
  ): Promise<
    Array<{
      text?: string;
      html?: string;
      date: Date;
      subject?: string;
      inReplyTo?: string;
    }>
  > {
    return new Promise((resolve, reject) => {
      if (!this.imapConfig) {
        resolve([]);
        return;
      }

      const imap = new Imap({
        ...this.imapConfig,
        connTimeout: 10000, // 10 seconds connection timeout
        authTimeout: 5000, // 5 seconds auth timeout
      });

      const replies: Array<{
        text?: string;
        html?: string;
        date: Date;
        subject?: string;
        inReplyTo?: string;
      }> = [];

      let connectionTimeout: NodeJS.Timeout;
      let isResolved = false;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        if (!isResolved) {
          isResolved = true;
        }
      };

      // Set connection timeout
      connectionTimeout = setTimeout(() => {
        if (!isResolved) {
          cleanup();
          imap.end();
          reject(new Error("IMAP connection timeout"));
        }
      }, 15000); // 15 seconds total timeout

      imap.once("ready", () => {
        clearTimeout(connectionTimeout);
        imap.openBox("INBOX", false, (err, box) => {
          if (err) {
            cleanup();
            imap.end();
            reject(err);
            return;
          }

          // Build search criteria
          const searchCriteria: any[] = [
            ["FROM", toEmail],
            ["TO", fromEmail],
            ["SINCE", sinceDate],
          ];

          // Add subject matching if provided (for better reply matching)
          if (subjectMatch) {
            // Match subject containing the submission title or "Re:" prefix
            searchCriteria.push(["SUBJECT", subjectMatch]);
          }

          // Search for emails from the publisher, to our email, after the sent date
          imap.search(searchCriteria, (err, results) => {
            if (err || !results || results.length === 0) {
              cleanup();
              imap.end();
              resolve([]);
              return;
            }

            const fetch = imap.fetch(results, {
              bodies: "",
              struct: true,
            });

            fetch.on("message", (msg, seqno) => {
              msg.on("body", (stream) => {
                simpleParser(stream as unknown as import("stream").Stream, (err, parsed) => {
                  if (err) {
                    console.error("Error parsing email:", err);
                    return;
                  }

                  // Validate that we have content before adding
                  const hasContent = parsed.text || parsed.html;
                  if (!hasContent || (parsed.text && parsed.text.trim().length < 10)) {
                    return; // Skip empty or very short emails
                  }

                  replies.push({
                    text: typeof parsed.text === "string" ? parsed.text : undefined,
                    html: typeof parsed.html === "string" ? parsed.html : undefined,
                    date: parsed.date || new Date(),
                    subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
                    inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : undefined,
                  });
                });
              });
            });

            fetch.once("end", () => {
              cleanup();
              imap.end();
              // Sort by date, most recent first
              replies.sort((a, b) => b.date.getTime() - a.date.getTime());
              resolve(replies);
            });

            fetch.once("error", (err: unknown) => {
              cleanup();
              imap.end();
              reject(err);
            });
          });
        });
      });

      imap.once("error", (err: unknown) => {
        cleanup();
        console.error("IMAP error:", err);
        reject(err);
      });

      imap.once("end", () => {
        cleanup();
      });

      imap.connect();
    });
  }

  /**
   * Check for replies for all pending submissions
   */
  async checkAllPendingReplies(): Promise<{
    checked: number;
    found: number;
    updated: number;
  }> {
    if (!this.isConfigured()) {
      console.warn("⚠️ IMAP not configured. Skipping reply check.");
      return { checked: 0, found: 0, updated: 0 };
    }

    try {
      // Get all submissions with email sent but no reply yet
      const submissions = await prisma.guestPostSubmission.findMany({
        where: {
          status: "PITCHED",
          emailSentAt: {
            not: null,
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
          },
          emailRepliedAt: null,
        },
        include: {
          publisher: true,
        },
        take: 50, // Process 50 at a time
      });

      console.log(`📬 Checking replies for ${submissions.length} submissions...`);

      let found = 0;
      let updated = 0;

      for (const submission of submissions) {
        try {
          const result = await this.checkReplyForSubmission(submission.id);
          if (result.found) {
            found++;
            if (result.parsedStatus) {
              updated++;
            }
          }

          // Small delay to avoid overwhelming the email server
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error: any) {
          console.error(
            `Error checking reply for submission ${submission.id}:`,
            error
          );
        }
      }

      console.log(
        `✅ Reply check completed: ${found} replies found, ${updated} statuses updated`
      );

      return {
        checked: submissions.length,
        found,
        updated,
      };
    } catch (error: any) {
      console.error("Error checking all pending replies:", error);
      throw error;
    }
  }
}

