import type { Request, Response } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../config/db.config";
import { EmailService } from "../services/email.service";
import {
  generateWelcomeEmailHTML,
  generateOnboardingCompleteEmailHTML,
  generateWebsiteAddedEmailHTML,
  generateSubscriptionEmailHTML,
  generateOnboardingReminderEmailHTML,
  generateOnboardingFollowUpEmailHTML,
} from "../utils/email-templates";
import { sendError, sendSuccess } from "../utils/response.utils";

const emailService = new EmailService();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
});

const SEND_SUBSCRIPTION_EMAIL_SCHEMA = z.object({
  userId: z.string(),
});

const SEND_WELCOME_EMAIL_SCHEMA = z.object({
  userEmail: z.string().email(),
  userName: z.string(),
});

const SEND_ONBOARDING_REMINDER_EMAIL_SCHEMA = z.object({
  userEmail: z.string().email(),
  userName: z.string(),
  daysSinceSignup: z.number().optional(),
});

export async function sendSubscriptionEmail(req: Request, res: Response) {
  try {
    const body = req.body;
    const payload = SEND_SUBSCRIPTION_EMAIL_SCHEMA.parse(body);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        Subscription: true,
      },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (!user.Subscription) {
      return sendError(res, "Subscription not found", 404);
    }

    const subscription = user.Subscription;
    const price = subscription.stripePriceId
      ? await stripe.prices.retrieve(subscription.stripePriceId)
      : null;

    const amount = price
      ? `$${(price.unit_amount || 0) / 100}`
      : "N/A";
    const billingPeriod =
      price?.recurring?.interval === "month"
        ? "Monthly"
        : price?.recurring?.interval === "year"
        ? "Yearly"
        : "N/A";

    const nextBillingDate = subscription.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : undefined;

    const result = await emailService.sendSubscriptionEmail({
      userName: user.name || "there",
      userEmail: user.email,
      planName: subscription.planName || "Premium",
      amount,
      billingPeriod,
      nextBillingDate,
    });

    if (!result.success) {
      return sendError(
        res,
        result.error || "Failed to send subscription email",
        500
      );
    }

    return sendSuccess(res, { emailId: result.emailId }, "Subscription email sent successfully");
  } catch (error: any) {
    console.error("Error sending subscription email:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to send subscription email", 500, error);
  }
}

export async function getEmailPreviews(req: Request, res: Response) {
  try {
    const sampleData = {
      welcome: {
        userName: "John Doe",
        userEmail: "john.doe@example.com",
      },
      onboardingComplete: {
        userName: "John Doe",
        businessName: "Acme Corporation",
        websiteUrl: "https://acme.com",
      },
      websiteAdded: {
        userName: "John Doe",
        websiteName: "Acme Corporation",
        websiteUrl: "https://acme.com",
        totalWebsites: 2,
      },
      subscription: {
        userName: "John Doe",
        planName: "Uplift",
        amount: "$99.00",
        billingPeriod: "Monthly",
        nextBillingDate: "January 15, 2025",
      },
      onboardingReminder: {
        userName: "John Doe",
        daysSinceSignup: 3,
      },
      onboardingFollowUp: {
        userName: "John Doe",
        daysSinceSignup: 7,
      },
    };

    const previews = {
      welcome: {
        subject: "Welcome to Uplift! 🎉",
        html: generateWelcomeEmailHTML(sampleData.welcome),
        text: "Welcome email text preview",
      },
      onboardingComplete: {
        subject: "🎉 Onboarding Complete - Your SEO Strategy is Being Generated",
        html: generateOnboardingCompleteEmailHTML(sampleData.onboardingComplete),
        text: "Onboarding complete email text preview",
      },
      websiteAdded: {
        subject: "New Website Added to Your Account 🚀",
        html: generateWebsiteAddedEmailHTML(sampleData.websiteAdded),
        text: "Website added email text preview",
      },
      subscription: {
        subject: "Subscription Confirmed - Welcome to Premium! ✅",
        html: generateSubscriptionEmailHTML(sampleData.subscription),
        text: "Subscription email text preview",
      },
      onboardingReminder: {
        subject: "Complete Your Setup - You're Almost There! 🚀",
        html: generateOnboardingReminderEmailHTML(sampleData.onboardingReminder),
        text: "Onboarding reminder email text preview",
      },
      onboardingFollowUp: {
        subject: "Don't Miss Out - Complete Your SEO Setup Today!",
        html: generateOnboardingFollowUpEmailHTML(sampleData.onboardingFollowUp),
        text: "Onboarding follow-up email text preview",
      },
    };

    return sendSuccess(res, { previews }, "Email previews retrieved successfully");
  } catch (error: any) {
    console.error("Error getting email previews:", error);
    return sendError(res, "Failed to get email previews", 500, error);
  }
}

export async function sendWelcomeEmail(req: Request, res: Response) {
  try {
    const body = req.body;
    const payload = SEND_WELCOME_EMAIL_SCHEMA.parse(body);

    const result = await emailService.sendWelcomeEmail({
      userEmail: payload.userEmail,
      userName: payload.userName,
    });

    if (!result.success) {
      return sendError(
        res,
        result.error || "Failed to send welcome email",
        500
      );
    }

    return sendSuccess(res, { emailId: result.emailId }, "Welcome email sent successfully");
  } catch (error: any) {
    console.error("Error sending welcome email:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to send welcome email", 500, error);
  }
}

export async function sendOnboardingReminderEmail(req: Request, res: Response) {
  try {
    const body = req.body;
    const payload = SEND_ONBOARDING_REMINDER_EMAIL_SCHEMA.parse(body);

    const result = await emailService.sendOnboardingReminderEmail({
      userEmail: payload.userEmail,
      userName: payload.userName,
      daysSinceSignup: payload.daysSinceSignup,
    });

    if (!result.success) {
      return sendError(
        res,
        result.error || "Failed to send onboarding reminder email",
        500
      );
    }

    return sendSuccess(res, { emailId: result.emailId }, "Onboarding reminder email sent successfully");
  } catch (error: any) {
    console.error("Error sending onboarding reminder email:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to send onboarding reminder email", 500, error);
  }
}

export async function sendOnboardingFollowUpEmail(req: Request, res: Response) {
  try {
    const body = req.body;
    const payload = SEND_ONBOARDING_REMINDER_EMAIL_SCHEMA.parse(body);

    const result = await emailService.sendOnboardingFollowUpEmail({
      userEmail: payload.userEmail,
      userName: payload.userName,
      daysSinceSignup: payload.daysSinceSignup,
    });

    if (!result.success) {
      return sendError(
        res,
        result.error || "Failed to send onboarding follow-up email",
        500
      );
    }

    return sendSuccess(res, { emailId: result.emailId }, "Onboarding follow-up email sent successfully");
  } catch (error: any) {
    console.error("Error sending onboarding follow-up email:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to send onboarding follow-up email", 500, error);
  }
}
