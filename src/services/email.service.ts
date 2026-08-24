import { BRAND } from "../config/brand.config";
import { Resend } from "resend";
import { prisma } from "../config/db.config";
import {
  generateWelcomeEmailHTML,
  generateWelcomeEmailText,
  generateOnboardingCompleteEmailHTML,
  generateOnboardingCompleteEmailText,
  generateWebsiteAddedEmailHTML,
  generateWebsiteAddedEmailText,
  generateSubscriptionEmailHTML,
  generateSubscriptionEmailText,
  generateOnboardingReminderEmailHTML,
  generateOnboardingReminderEmailText,
  generateOnboardingFollowUpEmailHTML,
  generateOnboardingFollowUpEmailText,
  generatePasswordResetEmailHTML,
  generatePasswordResetEmailText,
  generateChangeEmailVerificationEmailHTML,
  generateChangeEmailVerificationEmailText,
  generateQuotaAlertEmailHTML,
  generateQuotaAlertEmailText,
  generateGMBReviewReplyEmailHTML,
  generateGMBReviewReplyEmailText,
  generateContentApprovalReadyEmailText,
  type WelcomeEmailData,
  type OnboardingCompleteEmailData,
  type WebsiteAddedEmailData,
  type SubscriptionEmailData,
  type OnboardingReminderEmailData,
  type PasswordResetEmailData,
  type ChangeEmailVerificationEmailData,
  type QuotaAlertEmailData,
  type GMBReviewReplyEmailData,
  type ContentApprovalReadyEmailData,
} from "../utils/email-templates";

export class EmailService {
  private resend: Resend | null = null;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn(
        "⚠️ RESEND_API_KEY not set. Email functionality will be disabled."
      );
    } else {
      this.resend = new Resend(apiKey);
    }
  }

  async sendPitchEmail(
    submissionId: string,
    to: string,
    subject: string,
    htmlContent: string,
    textContent: string,
    replyTo?: string
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not configured");
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      // Generate tracking ID for webhook matching
      const trackingId = `submission_${submissionId}_${Date.now()}`;

      // Send email via Resend
      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [to],
        replyTo: replyTo || fromEmail,
        subject: subject,
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "guest-posting-pitch" },
          { name: "submission_id", value: submissionId },
          { name: "tracking_id", value: trackingId },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";

      // Update submission with email tracking info
      await prisma.guestPostSubmission.update({
        where: { id: submissionId },
        data: {
          emailId: emailId,
          emailSentAt: new Date(),
          emailTrackingId: trackingId,
          status: "PITCHED",
          pitchSentAt: new Date(),
        },
      });

      console.log(
        `✅ Pitch email sent for submission ${submissionId}, email ID: ${emailId}`
      );

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending pitch email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  /**
   * Track email event (opened, clicked, replied)
   */
  async trackEmailEvent(
    emailId: string,
    event: "opened" | "clicked" | "replied",
    metadata?: {
      submissionId?: string;
      replyContent?: string;
      timestamp?: Date;
    }
  ): Promise<void> {
    try {
      if (!emailId || !metadata?.submissionId) {
        return;
      }

      const updateData: any = {};

      switch (event) {
        case "opened":
          updateData.emailOpenedAt = metadata.timestamp || new Date();
          break;
        case "clicked":
          updateData.emailClickedAt = metadata.timestamp || new Date();
          break;
        case "replied":
          updateData.emailRepliedAt = metadata.timestamp || new Date();
          if (metadata.replyContent) {
            updateData.emailReplyContent = metadata.replyContent;
          }
          break;
      }

      await prisma.guestPostSubmission.update({
        where: { id: metadata.submissionId },
        data: updateData,
      });

      console.log(
        `✅ Email event tracked: ${event} for submission ${metadata.submissionId}`
      );
    } catch (error: any) {
      console.error(`❌ Error tracking email event ${event}:`, error);
    }
  }

  /**
   * Send welcome email to new user
   */
  async sendWelcomeEmail(
    data: WelcomeEmailData
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping welcome email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateWelcomeEmailHTML(data);
      const textContent = generateWelcomeEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: `Welcome to ${BRAND.name}! 🎉`,
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "welcome" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending welcome email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Welcome email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending welcome email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  /**
   * Send onboarding complete email
   */
  async sendOnboardingCompleteEmail(
    data: OnboardingCompleteEmailData & { userEmail: string }
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping onboarding complete email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateOnboardingCompleteEmailHTML(data);
      const textContent = generateOnboardingCompleteEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: "🎉 Onboarding Complete - Your SEO Strategy is Being Generated",
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "onboarding-complete" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending onboarding complete email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Onboarding complete email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending onboarding complete email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  /**
   * Send website added email
   */
  async sendWebsiteAddedEmail(
    data: WebsiteAddedEmailData & { userEmail: string }
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping website added email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateWebsiteAddedEmailHTML(data);
      const textContent = generateWebsiteAddedEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: "New Website Added to Your Account 🚀",
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "website-added" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending website added email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Website added email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending website added email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  /**
   * Send subscription confirmation email
   */
  async sendSubscriptionEmail(
    data: SubscriptionEmailData & { userEmail: string }
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping subscription email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateSubscriptionEmailHTML(data);
      const textContent = generateSubscriptionEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: "Subscription Confirmed - Welcome to Premium! ✅",
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "subscription" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending subscription email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Subscription email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending subscription email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  async sendOnboardingReminderEmail(
    data: OnboardingReminderEmailData & { userEmail: string }
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping onboarding reminder email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateOnboardingReminderEmailHTML(data);
      const textContent = generateOnboardingReminderEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: "Complete Your Setup - You're Almost There! 🚀",
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "onboarding-reminder" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending onboarding reminder email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Onboarding reminder email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending onboarding reminder email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  async sendOnboardingFollowUpEmail(
    data: OnboardingReminderEmailData & { userEmail: string }
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping onboarding follow-up email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateOnboardingFollowUpEmailHTML(data);
      const textContent = generateOnboardingFollowUpEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: "Don't Miss Out - Complete Your SEO Setup Today!",
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "onboarding-follow-up" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending onboarding follow-up email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Onboarding follow-up email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending onboarding follow-up email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  async sendPasswordResetEmail(
    data: PasswordResetEmailData
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping password reset email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generatePasswordResetEmailHTML(data);
      const textContent = generatePasswordResetEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: `Reset your ${BRAND.name} password`,
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "password-reset" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending password reset email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Password reset email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending password reset email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  async sendChangeEmailVerificationEmail(
    data: ChangeEmailVerificationEmailData
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping email verification email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const htmlContent = generateChangeEmailVerificationEmailHTML(data);
      const textContent = generateChangeEmailVerificationEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: `Verify your ${BRAND.name} email address`,
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "email-verification" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending email verification email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Email verification email sent to ${data.userEmail}, email ID: ${emailId}`);

      return {
        emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending email verification email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  /**
   * Send quota limit exceeded alert email
   */
  async sendQuotaAlertEmail(
    data: QuotaAlertEmailData
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY not configured. Skipping quota alert email.");
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;
      const alertEmail = process.env.QUOTA_ALERT_EMAIL || "info@codepaper.com";

      const htmlContent = generateQuotaAlertEmailHTML(data);
      const textContent = generateQuotaAlertEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [alertEmail],
        subject: `⚠️ API Quota Exceeded: ${data.service}`,
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "quota-alert" },
          { name: "service", value: data.service.toLowerCase() },
          { name: "error-type", value: data.errorType.toLowerCase() },
        ],
      });

      if (result.error) {
        console.error("❌ Resend error sending quota alert email:", result.error);
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(`✅ Quota alert email sent to ${alertEmail}, email ID: ${emailId}`);

      return {
        emailId: emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending quota alert email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  async sendGMBReviewReplyEmail(
    data: GMBReviewReplyEmailData & { userEmail: string }
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        console.warn(
          "⚠️ RESEND_API_KEY not configured. Skipping GMB review reply email."
        );
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }

      const fromEmail: string = BRAND.fromEmail;
      const fromName: string = BRAND.fromName;

      const replyWord =
        data.totalRepliesPosted > 1 ? "Replies" : "Reply";

      const htmlContent = generateGMBReviewReplyEmailHTML(data);
      const textContent = generateGMBReviewReplyEmailText(data);

      const result = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [data.userEmail],
        subject: `${data.totalRepliesPosted} Review ${replyWord} Posted to ${data.businessName}`,
        html: htmlContent,
        text: textContent,
        tags: [
          { name: "type", value: "gmb-review-reply" },
          { name: "category", value: "transactional" },
        ],
      });

      if (result.error) {
        console.error(
          "❌ Resend error sending GMB review reply email:",
          result.error
        );
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }

      const emailId = result.data?.id || "";
      console.log(
        `✅ GMB review reply email sent to ${data.userEmail}, email ID: ${emailId}`
      );

      return {
        emailId,
        success: true,
      };
    } catch (error: any) {
      console.error("❌ Error sending GMB review reply email:", error);
      return {
        emailId: "",
        success: false,
        error: error.message || "Failed to send email",
      };
    }
  }

  async sendContentApprovalReadyEmail(
    data: ContentApprovalReadyEmailData & {
      userEmail: string;
      idempotencyKey: string;
    },
  ): Promise<{ emailId: string; success: boolean; error?: string }> {
    try {
      if (!this.resend || !process.env.RESEND_API_KEY) {
        return {
          emailId: "",
          success: false,
          error: "RESEND_API_KEY is not configured",
        };
      }
      const result = await this.resend.emails.send(
        {
          from: `${BRAND.fromName} <${BRAND.fromEmail}>`,
          to: [data.userEmail],
          subject: `A ${data.contentLabel} post is ready to review`,
          text: generateContentApprovalReadyEmailText(data),
          tags: [
            { name: "type", value: "content-approval-ready" },
            { name: "category", value: "transactional" },
          ],
        },
        { idempotencyKey: data.idempotencyKey },
      );
      if (result.error) {
        return {
          emailId: "",
          success: false,
          error: result.error.message || "Failed to send email",
        };
      }
      return { emailId: result.data?.id || "", success: true };
    } catch (error) {
      return {
        emailId: "",
        success: false,
        error: error instanceof Error ? error.message : "Failed to send email",
      };
    }
  }
}
