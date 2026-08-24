import { EmailService } from "../services/email.service";

const emailService = new EmailService();

export interface QuotaErrorDetails {
  service: string;
  errorType: string;
  errorMessage: string;
  userId?: string;
  businessId?: string;
  keywordId?: string;
  blogId?: string;
  additionalDetails?: string;
}

/**
 * Send quota error alert email to info@codepaper.com
 * This function is non-blocking and won't throw errors
 */
export async function sendQuotaAlert(details: QuotaErrorDetails): Promise<void> {
  try {
    const alertData = {
      service: details.service,
      errorType: details.errorType,
      errorMessage: details.errorMessage,
      userId: details.userId,
      businessId: details.businessId,
      keywordId: details.keywordId,
      blogId: details.blogId,
      timestamp: new Date().toISOString(),
      additionalDetails: details.additionalDetails,
    };

    await emailService.sendQuotaAlertEmail(alertData);
  } catch (error: any) {
    // Don't throw - we don't want quota alert failures to break the main flow
    console.error("❌ Failed to send quota alert email:", error);
  }
}
