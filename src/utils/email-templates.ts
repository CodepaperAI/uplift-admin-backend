import { BRAND } from "../config/brand.config";
import Handlebars from "handlebars";

/**
 * Email templates for guest posting
 */

export interface PitchEmailData {
  publisherName: string;
  publisherContactName?: string;
  publisherWebsite: string;
  userName: string;
  userBusinessName: string;
  userBusinessWebsite?: string;
  blogTitle: string;
  proposedTopic?: string;
  blogExcerpt?: string;
  blogUrl?: string;
  submissionGuidelines?: string;
  personalization?: string; // AI-generated personalization
}

/**
 * Generate HTML pitch email template
 */
export function generatePitchEmailHTML(data: PitchEmailData): string {
  const template = Handlebars.compile(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guest Post Pitch</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
    <h1 style="color: #2c3e50; margin-top: 0;">Guest Post Pitch</h1>
  </div>

  <div style="margin-bottom: 20px;">
    <p>Hello {{#if publisherContactName}}{{publisherContactName}}{{else}}{{publisherName}} Team{{/if}},</p>
    
    {{#if personalization}}
    <p style="background-color: #e8f4f8; padding: 15px; border-left: 4px solid #3498db; margin: 20px 0;">
      {{personalization}}
    </p>
    {{/if}}

    <p>I hope this email finds you well. I'm reaching out because I believe my content would be a great fit for {{publisherName}}.</p>

    <h2 style="color: #2c3e50; margin-top: 30px;">Proposed Article</h2>
    <p><strong>Title:</strong> {{blogTitle}}</p>
    
    {{#if proposedTopic}}
    <p><strong>Topic:</strong> {{proposedTopic}}</p>
    {{/if}}

    {{#if blogExcerpt}}
    <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 15px 0;">
      <p style="margin: 0; font-style: italic;">{{blogExcerpt}}</p>
    </div>
    {{/if}}

    {{#if blogUrl}}
    <p><a href="{{blogUrl}}" style="color: #3498db; text-decoration: none;">View full article →</a></p>
    {{/if}}

    <h2 style="color: #2c3e50; margin-top: 30px;">About Me</h2>
    <p>I'm {{userName}}, and I work with {{userBusinessName}}.</p>
    
    {{#if userBusinessWebsite}}
    <p>You can learn more about us at: <a href="{{userBusinessWebsite}}" style="color: #3498db;">{{userBusinessWebsite}}</a></p>
    {{/if}}

    {{#if submissionGuidelines}}
    <h2 style="color: #2c3e50; margin-top: 30px;">Compliance</h2>
    <p>I've reviewed your submission guidelines and ensured this content meets all requirements:</p>
    <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 15px 0;">
      <p style="margin: 0; white-space: pre-wrap;">{{submissionGuidelines}}</p>
    </div>
    {{/if}}

    <p style="margin-top: 30px;">I'd love to contribute this article to {{publisherName}} and would be happy to make any adjustments you might suggest.</p>

    <p>Thank you for your time and consideration.</p>

    <p>Best regards,<br>
    {{userName}}<br>
    {{#if userBusinessWebsite}}{{userBusinessName}}<br>{{/if}}
    {{#if userBusinessWebsite}}{{userBusinessWebsite}}{{/if}}</p>
  </div>

  <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
    <p>This email was sent via ${BRAND.name} guest posting automation.</p>
  </div>
</body>
</html>
  `);

  return template(data);
}

/**
 * Generate plain text pitch email
 */
export function generatePitchEmailText(data: PitchEmailData): string {
  const template = Handlebars.compile(`
Guest Post Pitch

Hello {{#if publisherContactName}}{{publisherContactName}}{{else}}{{publisherName}} Team{{/if}},

{{#if personalization}}
{{personalization}}

{{/if}}
I hope this email finds you well. I'm reaching out because I believe my content would be a great fit for {{publisherName}}.

PROPOSED ARTICLE

Title: {{blogTitle}}

{{#if proposedTopic}}
Topic: {{proposedTopic}}

{{/if}}
{{#if blogExcerpt}}
{{blogExcerpt}}

{{/if}}
{{#if blogUrl}}
View full article: {{blogUrl}}

{{/if}}
ABOUT ME

I'm {{userName}}, and I work with {{userBusinessName}}.

{{#if userBusinessWebsite}}
Learn more: {{userBusinessWebsite}}

{{/if}}
{{#if submissionGuidelines}}
SUBMISSION GUIDELINES COMPLIANCE

I've reviewed your submission guidelines and ensured this content meets all requirements:

{{submissionGuidelines}}

{{/if}}
I'd love to contribute this article to {{publisherName}} and would be happy to make any adjustments you might suggest.

Thank you for your time and consideration.

Best regards,
{{userName}}
{{#if userBusinessWebsite}}{{userBusinessName}}
{{userBusinessWebsite}}{{/if}}
  `);

  return template(data).trim();
}

/**
 * Generate email subject line
 */
export function generatePitchEmailSubject(data: PitchEmailData): string {
  // Default subject, can be customized
  return `Guest Post Pitch: ${data.blogTitle}`;
}

/**
 * Transactional Email Templates
 */

export interface WelcomeEmailData {
  userName: string;
  userEmail: string;
}

export interface OnboardingCompleteEmailData {
  userName: string;
  businessName: string;
  websiteUrl: string;
}

export interface WebsiteAddedEmailData {
  userName: string;
  websiteName: string;
  websiteUrl: string;
  totalWebsites: number;
}

export interface SubscriptionEmailData {
  userName: string;
  planName: string;
  amount: string;
  billingPeriod: string;
  nextBillingDate?: string;
}

export interface OnboardingReminderEmailData {
  userName: string;
  daysSinceSignup?: number;
}

export interface PasswordResetEmailData {
  userName: string;
  userEmail: string;
  resetUrl: string;
}

export interface ChangeEmailVerificationEmailData {
  userName: string;
  userEmail: string;
  verificationUrl: string;
}

const EMAIL_STYLES = {
  textPrimary: "#000000",
  textSecondary: "#000000",
  backgroundColor: "#ffffff",
  borderColor: "#000000",
  frontendUrl: BRAND.frontendUrl,
  logoUrl: BRAND.logoUrl,
};

function getEmailBaseTemplate(content: string): string {
  const logoUrl = EMAIL_STYLES.logoUrl;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #ffffff; line-height: 1.6;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #ffffff; padding: 20px 0;">
    <tr>
      <td align="center" style="padding: 20px 0;">
        <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: ${EMAIL_STYLES.backgroundColor}; border: 1px solid ${EMAIL_STYLES.borderColor}; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background-color: ${EMAIL_STYLES.backgroundColor}; border-bottom: 1px solid ${EMAIL_STYLES.borderColor};">
              <img src="${logoUrl}" alt="${BRAND.name}" style="max-width: 100px; height: auto;" />
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background-color: ${EMAIL_STYLES.textPrimary}; border-top: 1px solid ${EMAIL_STYLES.borderColor}; text-align: center; font-size: 12px; color: #ffffff;">
              <p style="margin: 0 0 8px; color: #ffffff;">\u00a9 ${BRAND.copyright}. All rights reserved.</p>
              <p style="margin: 0; color: #ffffff;">This is an automated email. Please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

export function generateWelcomeEmailHTML(data: WelcomeEmailData): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">Welcome to ${BRAND.name}, ${data.userName}!</h2>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Thank you for signing up! We're excited to help you take your SEO strategy to the next level.
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      With ${BRAND.name}, you can:
    </p>
    
    <ul style="margin: 0 0 20px; padding-left: 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      <li style="margin-bottom: 8px;">Generate AI-powered SEO content</li>
      <li style="margin-bottom: 8px;">Track keywords and rankings</li>
      <li style="margin-bottom: 8px;">Discover backlink opportunities</li>
      <li style="margin-bottom: 8px;">Automate content publishing</li>
    </ul>
    
    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Ready to get started? Complete your onboarding to set up your first website and start generating content.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${EMAIL_STYLES.frontendUrl}/dashboard/onboarding" 
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Complete Onboarding
      </a>
    </div>
    
    <p style="margin: 30px 0 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">
      If you have any questions, feel free to reach out to our support team. We're here to help!
    </p>
  `;
  
  return getEmailBaseTemplate(content);
}

export function generateWelcomeEmailText(data: WelcomeEmailData): string {
  return `
Welcome to ${BRAND.name}, ${data.userName}!

Thank you for signing up! We're excited to help you take your SEO strategy to the next level.

With ${BRAND.name}, you can:
- Generate AI-powered SEO content
- Track keywords and rankings
- Discover backlink opportunities
- Automate content publishing

Ready to get started? Complete your onboarding to set up your first website and start generating content.

Visit: ${EMAIL_STYLES.frontendUrl}/dashboard/onboarding

If you have any questions, feel free to reach out to our support team. We're here to help!

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generateOnboardingCompleteEmailHTML(data: OnboardingCompleteEmailData): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">🎉 Onboarding Complete!</h2>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Congratulations! You've successfully completed the onboarding process for <strong>${data.businessName}</strong>.
    </p>
    
    <div style="background-color: #f9fafb; border-left: 4px solid ${EMAIL_STYLES.borderColor}; padding: 20px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0 0 8px; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 14px;">Website:</p>
      <p style="margin: 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">${data.websiteUrl}</p>
    </div>
    
    <p style="margin: 20px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      We're now analyzing your website and generating your personalized SEO strategy. This includes:
    </p>
    
    <ul style="margin: 0 0 20px; padding-left: 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      <li style="margin-bottom: 8px;">Keyword research and planning</li>
      <li style="margin-bottom: 8px;">Content strategy development</li>
      <li style="margin-bottom: 8px;">Competitor analysis</li>
      <li style="margin-bottom: 8px;">Backlink opportunities</li>
    </ul>
    
    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      You'll receive a notification once your keyword plan is ready. In the meantime, explore your dashboard to see what's happening behind the scenes.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${EMAIL_STYLES.frontendUrl}/dashboard/home" 
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Go to Dashboard
      </a>
    </div>
  `;
  
  return getEmailBaseTemplate(content);
}

export function generateOnboardingCompleteEmailText(data: OnboardingCompleteEmailData): string {
  return `
🎉 Onboarding Complete!

Hi ${data.userName},

Congratulations! You've successfully completed the onboarding process for ${data.businessName}.

Website: ${data.websiteUrl}

We're now analyzing your website and generating your personalized SEO strategy. This includes:
- Keyword research and planning
- Content strategy development
- Competitor analysis
- Backlink opportunities

You'll receive a notification once your keyword plan is ready. In the meantime, explore your dashboard to see what's happening behind the scenes.

Visit your dashboard: ${EMAIL_STYLES.frontendUrl}/dashboard/home

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generateWebsiteAddedEmailHTML(data: WebsiteAddedEmailData): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">New Website Added! 🚀</h2>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Great news! You've successfully added <strong>${data.websiteName}</strong> to your account.
    </p>
    
    <div style="background-color: #f9fafb; border-left: 4px solid ${EMAIL_STYLES.borderColor}; padding: 20px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0 0 8px; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 14px;">Website URL:</p>
      <p style="margin: 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">${data.websiteUrl}</p>
    </div>
    
    <p style="margin: 20px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      You now have <strong>${data.totalWebsites}</strong> ${data.totalWebsites === 1 ? 'website' : 'websites'} in your account. We're analyzing this new website and will generate a personalized SEO strategy for it.
    </p>
    
    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Manage all your websites from your dashboard and switch between them anytime.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${EMAIL_STYLES.frontendUrl}/dashboard/websites" 
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Manage Websites
      </a>
    </div>
  `;
  
  return getEmailBaseTemplate(content);
}

export function generateWebsiteAddedEmailText(data: WebsiteAddedEmailData): string {
  return `
New Website Added! 🚀

Hi ${data.userName},

Great news! You've successfully added ${data.websiteName} to your account.

Website URL: ${data.websiteUrl}

You now have ${data.totalWebsites} ${data.totalWebsites === 1 ? 'website' : 'websites'} in your account. We're analyzing this new website and will generate a personalized SEO strategy for it.

Manage all your websites from your dashboard and switch between them anytime.

Visit: ${EMAIL_STYLES.frontendUrl}/dashboard/websites

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generateSubscriptionEmailHTML(data: SubscriptionEmailData): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">Subscription Confirmed! ✅</h2>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Thank you for subscribing to <strong>${data.planName}</strong>! Your payment has been processed successfully.
    </p>
    
    <div style="background-color: #f9fafb; border: 1px solid ${EMAIL_STYLES.borderColor}; padding: 24px; margin: 20px 0; border-radius: 8px;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">Plan:</td>
          <td style="padding: 8px 0; text-align: right; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 14px;">${data.planName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">Amount:</td>
          <td style="padding: 8px 0; text-align: right; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 14px;">${data.amount}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">Billing Period:</td>
          <td style="padding: 8px 0; text-align: right; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 14px;">${data.billingPeriod}</td>
        </tr>
        ${data.nextBillingDate ? `
        <tr>
          <td style="padding: 8px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">Next Billing Date:</td>
          <td style="padding: 8px 0; text-align: right; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 14px;">${data.nextBillingDate}</td>
        </tr>
        ` : ''}
      </table>
    </div>
    
    <p style="margin: 20px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      You now have full access to all premium features, including unlimited content generation, advanced analytics, and priority support.
    </p>
    
    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Manage your subscription, view invoices, and update payment methods anytime from your account settings.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${EMAIL_STYLES.frontendUrl}/dashboard/account" 
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Manage Subscription
      </a>
    </div>
  `;
  
  return getEmailBaseTemplate(content);
}

export function generateSubscriptionEmailText(data: SubscriptionEmailData): string {
  return `
Subscription Confirmed! ✅

Hi ${data.userName},

Thank you for subscribing to ${data.planName}! Your payment has been processed successfully.

Plan: ${data.planName}
Amount: ${data.amount}
Billing Period: ${data.billingPeriod}
${data.nextBillingDate ? `Next Billing Date: ${data.nextBillingDate}` : ''}

You now have full access to all premium features, including unlimited content generation, advanced analytics, and priority support.

Manage your subscription, view invoices, and update payment methods anytime from your account settings.

Visit: ${EMAIL_STYLES.frontendUrl}/dashboard/account

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generateOnboardingReminderEmailHTML(data: OnboardingReminderEmailData): string {
  const daysText = data.daysSinceSignup 
    ? data.daysSinceSignup === 1 
      ? "yesterday" 
      : `${data.daysSinceSignup} days ago`
    : "recently";
  
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">Complete Your Setup, ${data.userName}!</h2>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      We noticed you signed up ${daysText} but haven't completed your onboarding yet. You're just a few steps away from unlocking the full power of ${BRAND.name}!
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      <strong>What you're missing:</strong>
    </p>
    
    <ul style="margin: 0 0 20px; padding-left: 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      <li style="margin-bottom: 8px;">AI-powered keyword research and planning</li>
      <li style="margin-bottom: 8px;">Automated content generation</li>
      <li style="margin-bottom: 8px;">Competitor analysis and insights</li>
      <li style="margin-bottom: 8px;">Backlink opportunity discovery</li>
      <li style="margin-bottom: 8px;">Content calendar and publishing automation</li>
    </ul>
    
    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Complete your onboarding in just a few minutes and start growing your SEO presence today!
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${EMAIL_STYLES.frontendUrl}/dashboard/onboarding" 
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Complete Onboarding
      </a>
    </div>
    
    <p style="margin: 30px 0 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">
      If you have any questions or need help getting started, our support team is here to assist you.
    </p>
  `;
  
  return getEmailBaseTemplate(content);
}

export function generateOnboardingReminderEmailText(data: OnboardingReminderEmailData): string {
  const daysText = data.daysSinceSignup 
    ? data.daysSinceSignup === 1 
      ? "yesterday" 
      : `${data.daysSinceSignup} days ago`
    : "recently";
  
  return `
Complete Your Setup, ${data.userName}!

Hi ${data.userName},

We noticed you signed up ${daysText} but haven't completed your onboarding yet. You're just a few steps away from unlocking the full power of ${BRAND.name}!

What you're missing:
- AI-powered keyword research and planning
- Automated content generation
- Competitor analysis and insights
- Backlink opportunity discovery
- Content calendar and publishing automation

Complete your onboarding in just a few minutes and start growing your SEO presence today!

Visit: ${EMAIL_STYLES.frontendUrl}/dashboard/onboarding

If you have any questions or need help getting started, our support team is here to assist you.

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generateOnboardingFollowUpEmailHTML(data: OnboardingReminderEmailData): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">Don't Miss Out on SEO Growth, ${data.userName}!</h2>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>
    
    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      We wanted to reach out one more time because we believe ${BRAND.name} can make a real difference for your business.
    </p>
    
    <div style="background-color: #f9fafb; border-left: 4px solid ${EMAIL_STYLES.borderColor}; padding: 20px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0 0 10px; color: ${EMAIL_STYLES.textPrimary}; font-weight: 600; font-size: 16px;">Here's what successful users are achieving:</p>
      <ul style="margin: 0; padding-left: 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
        <li style="margin-bottom: 8px;">3x increase in organic traffic</li>
        <li style="margin-bottom: 8px;">Automated content publishing saving 10+ hours per week</li>
        <li style="margin-bottom: 8px;">Better keyword rankings through AI-optimized content</li>
        <li style="margin-bottom: 8px;">Streamlined backlink acquisition process</li>
      </ul>
    </div>
    
    <p style="margin: 20px 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      The onboarding process takes less than 5 minutes. Once complete, we'll immediately start analyzing your website and generating your personalized SEO strategy.
    </p>
    
    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Ready to transform your SEO? Let's get you set up!
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${EMAIL_STYLES.frontendUrl}/dashboard/onboarding" 
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Start Onboarding Now
      </a>
    </div>
    
    <p style="margin: 30px 0 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">
      If you're facing any challenges or have questions, reply to this email and we'll help you get started.
    </p>
  `;
  
  return getEmailBaseTemplate(content);
}

export function generateOnboardingFollowUpEmailText(data: OnboardingReminderEmailData): string {
  return `
Don't Miss Out on SEO Growth, ${data.userName}!

Hi ${data.userName},

We wanted to reach out one more time because we believe ${BRAND.name} can make a real difference for your business.

Here's what successful users are achieving:
- 3x increase in organic traffic
- Automated content publishing saving 10+ hours per week
- Better keyword rankings through AI-optimized content
- Streamlined backlink acquisition process

The onboarding process takes less than 5 minutes. Once complete, we'll immediately start analyzing your website and generating your personalized SEO strategy.

Ready to transform your SEO? Let's get you set up!

Visit: ${EMAIL_STYLES.frontendUrl}/dashboard/onboarding

If you're facing any challenges or have questions, reply to this email and we'll help you get started.

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generatePasswordResetEmailHTML(
  data: PasswordResetEmailData
): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">Reset Your Password</h2>

    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>

    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      We received a request to reset the password for <strong>${data.userEmail}</strong>.
    </p>

    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Use the button below to choose a new password. If you did not request this, you can safely ignore this email.
    </p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${data.resetUrl}"
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Reset Password
      </a>
    </div>

    <p style="margin: 30px 0 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">
      For security reasons, this link will expire automatically. If it no longer works, request a new password reset from the sign-in page.
    </p>
  `;

  return getEmailBaseTemplate(content);
}

export function generatePasswordResetEmailText(
  data: PasswordResetEmailData
): string {
  return `
Reset Your Password

Hi ${data.userName},

We received a request to reset the password for ${data.userEmail}.

Use this link to choose a new password:
${data.resetUrl}

If you did not request this, you can safely ignore this email.

For security reasons, this link will expire automatically. If it no longer works, request a new password reset from the sign-in page.

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export function generateChangeEmailVerificationEmailHTML(
  data: ChangeEmailVerificationEmailData
): string {
  const content = `
    <h2 style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 24px; font-weight: 600;">Verify Your Email Address</h2>

    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Hi ${data.userName},
    </p>

    <p style="margin: 0 0 20px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Please confirm that you want to use <strong>${data.userEmail}</strong> for your ${BRAND.name} account.
    </p>

    <p style="margin: 0 0 30px; color: ${EMAIL_STYLES.textPrimary}; font-size: 16px;">
      Once verified, this email address will be ready for sign-in and account notifications.
    </p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${data.verificationUrl}"
         style="display: inline-block; padding: 14px 32px; background: ${EMAIL_STYLES.textPrimary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Verify Email
      </a>
    </div>

    <p style="margin: 30px 0 0; color: ${EMAIL_STYLES.textPrimary}; font-size: 14px;">
      If you did not make this request, you can safely ignore this email.
    </p>
  `;

  return getEmailBaseTemplate(content);
}

export function generateChangeEmailVerificationEmailText(
  data: ChangeEmailVerificationEmailData
): string {
  return `
Verify Your Email Address

Hi ${data.userName},

Please confirm that you want to use ${data.userEmail} for your ${BRAND.name} account.

Verify your email here:
${data.verificationUrl}

If you did not make this request, you can safely ignore this email.

\u00a9 ${BRAND.copyright}. All rights reserved.
  `.trim();
}

export interface QuotaAlertEmailData {
  service: string;
  errorType: string;
  errorMessage: string;
  userId?: string;
  businessId?: string;
  keywordId?: string;
  blogId?: string;
  timestamp: string;
  additionalDetails?: string;
}

export function generateQuotaAlertEmailHTML(data: QuotaAlertEmailData): string {
  const template = Handlebars.compile(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Quota Alert</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ffc107;">
    <h1 style="color: #856404; margin-top: 0;">⚠️ API Quota Limit Exceeded</h1>
  </div>

  <div style="margin-bottom: 20px;">
    <p><strong>Service:</strong> {{service}}</p>
    <p><strong>Error Type:</strong> {{errorType}}</p>
    <p><strong>Timestamp:</strong> {{timestamp}}</p>
    
    <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #dc3545;">
      <p style="margin: 0; font-weight: bold; color: #721c24;">Error Message:</p>
      <p style="margin: 5px 0 0 0;">{{errorMessage}}</p>
    </div>

    {{#if userId}}
    <p><strong>User ID:</strong> {{userId}}</p>
    {{/if}}

    {{#if businessId}}
    <p><strong>Business ID:</strong> {{businessId}}</p>
    {{/if}}

    {{#if keywordId}}
    <p><strong>Keyword ID:</strong> {{keywordId}}</p>
    {{/if}}

    {{#if blogId}}
    <p><strong>Blog ID:</strong> {{blogId}}</p>
    {{/if}}

    {{#if additionalDetails}}
    <div style="background-color: #e7f3ff; padding: 15px; border-radius: 4px; margin: 15px 0;">
      <p style="margin: 0; font-weight: bold;">Additional Details:</p>
      <p style="margin: 5px 0 0 0; white-space: pre-wrap;">{{additionalDetails}}</p>
    </div>
    {{/if}}

    <div style="margin-top: 30px; padding: 15px; background-color: #f8f9fa; border-radius: 4px;">
      <p style="margin: 0; font-size: 14px; color: #666;">
        <strong>Action Required:</strong> Please check the API billing and quota limits for {{service}} and take appropriate action.
      </p>
    </div>
  </div>

  <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
    <p>This is an automated alert from ${BRAND.name} monitoring system.</p>
  </div>
</body>
</html>
  `);

  return template(data);
}

export function generateQuotaAlertEmailText(data: QuotaAlertEmailData): string {
  return `
⚠️ API QUOTA LIMIT EXCEEDED

Service: ${data.service}
Error Type: ${data.errorType}
Timestamp: ${data.timestamp}

Error Message:
${data.errorMessage}

${data.userId ? `User ID: ${data.userId}\n` : ''}
${data.businessId ? `Business ID: ${data.businessId}\n` : ''}
${data.keywordId ? `Keyword ID: ${data.keywordId}\n` : ''}
${data.blogId ? `Blog ID: ${data.blogId}\n` : ''}

${data.additionalDetails ? `Additional Details:\n${data.additionalDetails}\n` : ''}

Action Required: Please check the API billing and quota limits for ${data.service} and take appropriate action.

---
This is an automated alert from ${BRAND.name} monitoring system.
  `.trim();
}

export interface GMBReviewReplyEmailData {
  userName: string;
  businessName: string;
  totalRepliesPosted: number;
  replies: Array<{
    reviewerName: string;
    rating: number;
    replySnippet: string;
  }>;
}

export function generateGMBReviewReplyEmailHTML(
  data: GMBReviewReplyEmailData
): string {
  const starsHTML = (rating: number): string =>
    Array.from({ length: 5 }, (_, i) =>
      i < rating ? "★" : "☆"
    ).join("");

  const repliesHTML = data.replies
    .map(
      (r) => `
      <tr>
        <td style="padding: 12px 16px; border-bottom: 1px solid #f0f0f0;">
          <div style="font-weight: 600; color: #1a1a2e; margin-bottom: 4px;">${r.reviewerName}</div>
          <div style="color: #f59e0b; font-size: 14px; margin-bottom: 6px;">${starsHTML(r.rating)}</div>
          <div style="color: #6b7280; font-size: 13px; line-height: 1.5;">${r.replySnippet}</div>
        </td>
      </tr>`
    )
    .join("");

  const appUrl: string = BRAND.frontendUrl.replace(/\/$/, "");

  const template = Handlebars.compile(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Replies Posted</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: #ffffff; margin: 0 0 8px 0; font-size: 22px;">Review Replies Posted</h1>
    <p style="color: #e9d5ff; margin: 0; font-size: 14px;">Your Google reviews got AI-powered responses</p>
  </div>

  <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <p style="margin-top: 0;">Hi {{userName}},</p>

    <p>Great news! ${BRAND.name} has automatically generated and posted <strong>{{totalRepliesPosted}} review {{#if isPlural}}replies{{else}}reply{{/if}}</strong> to your Google Business Profile for <strong>{{businessName}}</strong>.</p>

    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center;">
      <div style="font-size: 32px; font-weight: 700; color: #16a34a;">{{totalRepliesPosted}}</div>
      <div style="font-size: 13px; color: #15803d;">{{#if isPlural}}Replies{{else}}Reply{{/if}} Posted to Google</div>
    </div>

    {{#if hasReplies}}
    <h3 style="color: #1a1a2e; margin-bottom: 12px; font-size: 15px;">Recent Replies</h3>
    <table style="width: 100%; border-collapse: collapse; border: 1px solid #f0f0f0; border-radius: 8px; overflow: hidden;">
      {{{repliesHTML}}}
    </table>
    {{/if}}

    <div style="margin-top: 24px; text-align: center;">
      <a href="${appUrl}/dashboard/google-my-business" style="display: inline-block; background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">View All Reviews</a>
    </div>

    <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">All replies are generated using AI based on your business profile and review context. You can review and edit them anytime from your dashboard.</p>
  </div>

  <div style="margin-top: 20px; padding: 16px; text-align: center; font-size: 12px; color: #9ca3af;">
    <p style="margin: 0;">Sent by <a href="${appUrl}" style="color: #7c3aed; text-decoration: none;">${BRAND.name}</a></p>
  </div>
</body>
</html>`);

  return template({
    ...data,
    isPlural: data.totalRepliesPosted > 1,
    hasReplies: data.replies.length > 0,
    repliesHTML,
  });
}

export function generateGMBReviewReplyEmailText(
  data: GMBReviewReplyEmailData
): string {
  const replyWord = data.totalRepliesPosted > 1 ? "replies" : "reply";

  const repliesText = data.replies
    .map(
      (r) =>
        `- ${r.reviewerName} (${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}): ${r.replySnippet}`
    )
    .join("\n");

  return `
Hi ${data.userName},

Great news! ${BRAND.name} has automatically generated and posted ${data.totalRepliesPosted} review ${replyWord} to your Google Business Profile for ${data.businessName}.

${data.totalRepliesPosted} ${replyWord} posted to Google.

${data.replies.length > 0 ? `Recent Replies:\n${repliesText}\n` : ""}
View all reviews: ${BRAND.frontendUrl.replace(/\/$/, "")}/dashboard/google-my-business

All replies are generated using AI based on your business profile and review context. You can review and edit them anytime from your dashboard.

---
Sent by ${BRAND.name}
  `.trim();
}

export interface ContentApprovalReadyEmailData {
  userName: string;
  businessName: string;
  contentLabel: "social media" | "Google Business Profile";
  reviewUrl: string;
}

export function generateContentApprovalReadyEmailText(
  data: ContentApprovalReadyEmailData,
): string {
  return [
    `Hi ${data.userName},`,
    "",
    `A ${data.contentLabel} post for ${data.businessName} is ready to review.`,
    "",
    `Review and publish the post: ${data.reviewUrl}`,
    "",
    `— ${BRAND.fromName}`,
  ].join("\n");
}
