import { BRAND } from "../config/brand.config";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL: string = BRAND.fromEmail;
const FROM_NAME: string = BRAND.fromName;
const APP_NAME: string = BRAND.name;
const APP_URL: string = BRAND.frontendUrl;
const MEETING_URL: string = BRAND.meetingUrl;

interface TrialDayInfo {
  dayNumber: number;
  totalDays: number;
  dayText: string;
}

function getTrialDayInfo(trialStartDate: Date | null | undefined): TrialDayInfo {
  if (!trialStartDate) {
    return { dayNumber: 1, totalDays: 7, dayText: "Day 1 of 7" };
  }
  const now = new Date();
  const dayNumber = Math.ceil(
    (now.getTime() - trialStartDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  const totalDays = 7;
  const clampedDay = Math.min(Math.max(dayNumber, 1), totalDays);
  return {
    dayNumber: clampedDay,
    totalDays,
    dayText: `Day ${clampedDay} of ${totalDays}`,
  };
}

export async function sendWelcomeEmail(
  to: string,
  userName: string,
  trialEndDate: Date,
) {
  const daysLeft = Math.ceil(
    (trialEndDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24),
  );

  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `Welcome to ${APP_NAME} - Your 7-Day Free Trial Starts Now! 🎉`,
      html: getWelcomeEmailTemplate(userName, daysLeft),
    });

    if (error) {
      console.error("❌ Failed to send welcome email:", error);
      throw error;
    }

    console.log("✅ Welcome email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending welcome email:", error);
    throw error;
  }
}

export async function sendFirstBlogEmail(
  to: string,
  userName: string,
  blogTitle: string,
  blogSlug: string,
  blogExcerpt: string,
  trialStartDate?: Date | null,
) {
  try {
    const blogUrl = `${APP_URL}/dashboard/project/all-content/${blogSlug}`;
    const trialDay = getTrialDayInfo(trialStartDate);

    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `🎉 ${trialDay.dayText}: Your Blog is Ready - "${blogTitle}"`,
      html: getFirstBlogEmailTemplate(
        userName,
        blogTitle,
        blogUrl,
        blogExcerpt,
        trialDay.dayText,
      ),
    });

    if (error) {
      console.error("❌ Failed to send first blog email:", error);
      throw error;
    }

    console.log("✅ First blog email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending first blog email:", error);
    throw error;
  }
}

export async function sendBlogEmail(
  to: string,
  userName: string,
  blogTitle: string,
  blogSlug: string,
  blogExcerpt: string,
  isFirstBlog: boolean = false,
  trialStartDate?: Date | null,
) {
  try {
    const blogUrl = `${APP_URL}/dashboard/project/all-content/${blogSlug}`;
    const trialDay = getTrialDayInfo(trialStartDate);
    const subject = `📝 ${trialDay.dayText}: Your Blog is Ready - "${blogTitle}"`;

    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: subject,
      html: getFirstBlogEmailTemplate(
        userName,
        blogTitle,
        blogUrl,
        blogExcerpt,
        trialDay.dayText,
      ),
    });

    if (error) {
      console.error("❌ Failed to send blog email:", error);
      throw error;
    }

    console.log("✅ Blog email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending blog email:", error);
    throw error;
  }
}

export async function sendQuickBlogEmail(
  to: string,
  userName: string,
  blogTitle: string,
  blogSlug: string,
  blogExcerpt: string,
  trialStartDate?: Date | null,
) {
  try {
    const blogUrl = `${APP_URL}/dashboard/project/all-content/${blogSlug}`;
    const trialDay = getTrialDayInfo(trialStartDate);

    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `🚀 ${trialDay.dayText}: Sample Blog Ready - "${blogTitle}"`,
      html: getQuickBlogEmailTemplate(
        userName,
        blogTitle,
        blogUrl,
        blogExcerpt,
        trialDay.dayText,
      ),
    });

    if (error) {
      console.error("❌ Failed to send quick blog email:", error);
      throw error;
    }

    console.log("✅ Quick blog email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending quick blog email:", error);
    throw error;
  }
}

export async function sendDailyBlogSummaryEmail(
  to: string,
  userName: string,
  blogs: Array<{ title: string; slug: string; excerpt: string }>,
  date: string,
  trialStartDate?: Date | null,
) {
  try {
    const trialDay = getTrialDayInfo(trialStartDate);
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `📚 ${trialDay.dayText}: ${blogs.length} New Blog${blogs.length > 1 ? "s" : ""} Ready!`,
      html: getDailyBlogSummaryEmailTemplate(userName, blogs, date, trialDay.dayText),
    });

    if (error) {
      console.error("❌ Failed to send daily blog summary email:", error);
      throw error;
    }

    console.log("✅ Daily blog summary email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending daily blog summary email:", error);
    throw error;
  }
}

export async function sendTrialExpiringEmail(
  to: string,
  userName: string,
  daysLeft: number,
) {
  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `⏰ Your ${APP_NAME} Trial Expires in ${daysLeft} Days`,
      html: getTrialExpiringEmailTemplate(userName, daysLeft),
    });

    if (error) {
      console.error("❌ Failed to send trial expiring email:", error);
      throw error;
    }

    console.log("✅ Trial expiring email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending trial expiring email:", error);
    throw error;
  }
}

export async function sendTrialExpiredEmail(to: string, userName: string) {
  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `Your ${APP_NAME} Trial Has Ended - Upgrade to Continue`,
      html: getTrialExpiredEmailTemplate(userName),
    });

    if (error) {
      console.error("❌ Failed to send trial expired email:", error);
      throw error;
    }

    console.log("✅ Trial expired email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending trial expired email:", error);
    throw error;
  }
}

interface KeywordData {
  keyword: string;
  searchVolume: string;
  difficulty: string;
  currentRanking?: string;
  expectedRanking?: string;
}

export async function sendTopKeywordsEmail(
  to: string,
  userName: string,
  businessName: string,
  keywords: KeywordData[],
) {
  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `🎯 Your Top 5 Keywords Are Ready - Start Ranking Now!`,
      html: getTopKeywordsEmailTemplate(userName, businessName, keywords),
    });

    if (error) {
      console.error("❌ Failed to send top keywords email:", error);
      throw error;
    }

    console.log("✅ Top keywords email sent successfully:", data?.id);
    return data;
  } catch (error) {
    console.error("❌ Error sending top keywords email:", error);
    throw error;
  }
}

function getTopKeywordsEmailTemplate(
  userName: string,
  businessName: string,
  keywords: KeywordData[],
): string {
  const keywordRows = keywords
    .map(
      (kw, index) => `
        <tr>
          <td style="padding: 14px 12px; border-bottom: 1px solid #f0f0f0;">
            <div style="display: flex; align-items: center;">
              <span style="display: inline-block; width: 24px; height: 24px; color: #666; text-align: center; line-height: 24px; font-weight: 600; font-size: 12px; margin-right: 8px;">${index + 1}</span>
              <span style="font-weight: 600; color: #333; font-size: 14px;">${kw.keyword}</span>
            </div>
          </td>
          <td style="padding: 14px 8px; border-bottom: 1px solid #f0f0f0; text-align: center;">
            <span style="color: #666; font-size: 13px;">${kw.searchVolume}</span>
          </td>
          <td style="padding: 14px 8px; border-bottom: 1px solid #f0f0f0; text-align: center;">
            <span style="color: #999; font-size: 13px;">${kw.currentRanking || "Not ranked"}</span>
          </td>
          <td style="padding: 14px 8px; border-bottom: 1px solid #f0f0f0; text-align: center;">
            <span style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; background: linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(16, 185, 129, 0.15) 100%); color: #16a34a;">#${kw.expectedRanking || "5-15"}</span>
          </td>
        </tr>
      `,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Top Keywords</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden; box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <!-- Header with gradient -->
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700;">🎯 Your Top 5 Keywords</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Handpicked for ${businessName}</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Great news! We've analyzed your business and identified the <strong>top 5 keywords</strong> you should target to rank higher on Google and attract more customers.
              </p>

              <!-- Keywords Table -->
              <table style="width: 100%; border-collapse: collapse; margin: 30px 0; background: #fafafa; border-radius: 12px; overflow: hidden;">
                <thead>
                  <tr style="background: linear-gradient(135deg, rgba(175, 104, 239, 0.1) 0%, rgba(254, 112, 178, 0.1) 50%, rgba(254, 149, 113, 0.1) 100%);">
                    <th style="padding: 12px 12px; text-align: left; font-weight: 600; color: #333; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Keyword</th>
                    <th style="padding: 12px 8px; text-align: center; font-weight: 600; color: #333; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Searches/mo</th>
                    <th style="padding: 12px 8px; text-align: center; font-weight: 600; color: #333; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Current Rank</th>
                    <th style="padding: 12px 8px; text-align: center; font-weight: 600; color: #333; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Expected (3-6mo)</th>
                  </tr>
                </thead>
                <tbody>
                  ${keywordRows}
                </tbody>
              </table>

              <!-- Ranking Improvement Note -->
              <div style="background: linear-gradient(135deg, rgba(34, 197, 94, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%); border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #22c55e;">
                <h3 style="margin: 0 0 10px 0; color: #166534; font-size: 16px; font-weight: 600;">📈 Your SEO Growth Potential</h3>
                <p style="margin: 0; color: #15803d; font-size: 14px; line-height: 1.6;">
                  With consistent content publishing and our SEO optimization, you can expect to see significant ranking improvements within <strong>3-6 months</strong>. The expected rankings above are based on keyword difficulty and our proven track record.
                </p>
              </div>

              <div style="background: linear-gradient(135deg, rgba(175, 104, 239, 0.1) 0%, rgba(254, 112, 178, 0.1) 50%, rgba(254, 149, 113, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0;">
                <h2 style="margin: 0 0 12px 0; color: #333; font-size: 18px; font-weight: 600;">💡 Understanding Your SEO Opportunity:</h2>
                <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 15px; line-height: 1.8;">
                  <li><strong>Current Rank:</strong> Where you stand today (most businesses start unranked)</li>
                  <li><strong>Expected Rank:</strong> Where you can be in 3-6 months with our content</li>
                  <li><strong>Searches/mo:</strong> Real customers searching for these terms monthly</li>
                  <li>Page 1 rankings (#1-10) drive 90%+ of all traffic!</li>
                </ul>
              </div>

              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">
                We're already generating SEO-optimized blog posts targeting these keywords. Check your dashboard to see your content calendar and track your rankings!
              </p>

              <div style="text-align: center; margin: 30px 0;">
                <a href="${APP_URL}/dashboard/project/content-plan" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(175, 104, 239, 0.4);">
                  View Content Calendar →
                </a>
              </div>

              <p style="margin: 30px 0 0 0; color: #666; font-size: 14px; line-height: 1.6;">
                Want to discuss your keyword strategy? <a href="${MEETING_URL}" style="color: #AF68EF; text-decoration: none;">Book a free consultation call</a> with our SEO experts.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background: #f9fafb; padding: 24px 30px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0 0 8px 0; color: #999; font-size: 12px;">
                © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                You're receiving this email because you signed up for ${APP_NAME}.
              </p>
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

function getWelcomeEmailTemplate(userName: string, daysLeft: number): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to ${APP_NAME}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden;     box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <!-- Header with gradient -->
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 700;">🎉 Welcome to ${APP_NAME}!</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 18px;">Your 7-Day Free Trial Starts Now</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Welcome aboard! We're thrilled to have you join ${APP_NAME}. Your <strong>${daysLeft}-day free trial</strong> is now active, and we're already working on generating your first SEO-optimized blog post.
              </p>

              <div style="background: linear-gradient(135deg, rgba(175, 104, 239, 0.1) 0%, rgba(254, 112, 178, 0.1) 50%, rgba(254, 149, 113, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0;">
                <h2 style="margin: 0 0 16px 0; color: #333; font-size: 20px; font-weight: 600;">What's Happening Right Now:</h2>
                <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 15px; line-height: 1.8;">
                  <li>🔍 Analyzing your website and business</li>
                  <li>🎯 Generating 30 targeted keywords</li>
                  <li>✍️ Creating your first blog post</li>
                  <li>📊 Setting up your SEO dashboard</li>
                </ul>
              </div>

              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">
                You'll receive another email as soon as your first blog is ready (usually within 2-3 minutes). In the meantime, feel free to explore your dashboard!
              </p>

              <div style="text-align: center; margin: 30px 0;">
                <a href="${APP_URL}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(175, 104, 239, 0.4);">
                  Go to Dashboard →
                </a>
              </div>

              <!-- Book a Call Section -->
              <div style="background: linear-gradient(135deg, rgba(111, 88, 231, 0.1) 0%, rgba(154, 127, 245, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0; text-align: center;">
                <h3 style="margin: 0 0 12px 0; color: #6F58E7; font-size: 18px; font-weight: 600;">📞 Want a Personalized Setup?</h3>
                <p style="margin: 0 0 16px 0; color: #555; font-size: 14px; line-height: 1.6;">
                  Book a free 30-minute consultation call with our team. We'll help you set up your SEO strategy and answer any questions!
                </p>
                <a href="${MEETING_URL}" style="display: inline-block; background: #6F58E7; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                  Book Free Consultation →
                </a>
              </div>

              <div style="background: #fff8e1; border-left: 4px solid #ffc107; padding: 16px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.6;">
                  <strong>💡 Pro Tip:</strong> Your trial includes full access to all features. Take this time to explore keyword tracking, blog generation, and SEO analytics!
                </p>
              </div>

              <p style="margin: 30px 0 0 0; color: #666; font-size: 14px; line-height: 1.6;">
                Need help getting started? Reply to this email or <a href="${MEETING_URL}" style="color: #AF68EF; text-decoration: none;">book a free call</a> with our team.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
                Happy blogging! 🚀<br>
                The ${APP_NAME} Team
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                ${APP_URL}
              </p>
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

function getFirstBlogEmailTemplate(
  userName: string,
  blogTitle: string,
  blogUrl: string,
  blogExcerpt: string,
  dayText: string = "Day 1 of 7",
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Blog is Ready!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden;     box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 8px 0; color: rgba(255,255,255,0.95); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">📅 ${dayText} - Free Trial</p>
              <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 700;">🎉 Your Blog is Ready!</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 18px;">SEO-optimized and ready to publish</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              
              <p style="margin: 0 0 30px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Great news! We've just finished generating your first SEO-optimized blog post. It's ready for you to review, edit, and publish.
              </p>

              <!-- Blog Preview Card -->
              <div style="background: linear-gradient(135deg, #6F58E7 0%, #9A7FF5 100%); border-radius: 12px; padding: 30px; margin: 30px 0; box-shadow: 0 10px 30px rgba(111, 88, 231, 0.3);">
                <h2 style="margin: 0 0 16px 0; color: white; font-size: 22px; font-weight: 600; line-height: 1.4;">${blogTitle}</h2>
                <p style="margin: 0 0 24px 0; color: rgba(255,255,255,0.9); font-size: 15px; line-height: 1.6;">${blogExcerpt}</p>
                <a href="${blogUrl}" style="display: inline-block; background: #8C77F5; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                  Read Your Blog →
                </a>
              </div>

              <div style="background: #e8f5e9; border-left: 4px solid #4caf50; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <h3 style="margin: 0 0 12px 0; color: #2e7d32; font-size: 16px; font-weight: 600;">✨ What's Included:</h3>
                <ul style="margin: 0; padding-left: 20px; color: #2e7d32; font-size: 14px; line-height: 1.8;">
                  <li>SEO-optimized title and meta description</li>
                  <li>Keyword-rich content (4000+ words)</li>
                  <li>AI-generated images</li>
                  <li>Internal and external links</li>
                  <li>Structured data (Schema.org)</li>
                  <li>SEO score: 100/100</li>
                </ul>
              </div>

              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">
                You can edit, customize, or publish it directly to your WordPress site. We've also generated 29 more keyword ideas for your next blog posts!
              </p>

              <div style="text-align: center; margin: 30px 0;">
                <a href="${APP_URL}/dashboard/project/content-plan" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(175, 104, 239, 0.4);">
                  View Content Plan →
                </a>
              </div>

              <div style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 16px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0; color: #e65100; font-size: 14px; line-height: 1.6;">
                  <strong>🔥 Trial Exclusive:</strong> This is just the beginning! During your trial, you can explore all our features. Upgrade anytime to unlock unlimited blog generation.
                </p>
              </div>

              <!-- Book a Call CTA -->
              <div style="text-align: center; margin: 20px 0; padding-top: 20px; border-top: 1px solid #e9ecef;">
                <p style="margin: 0 0 12px 0; color: #666; font-size: 14px;">Need help with your content strategy?</p>
                <a href="${MEETING_URL}" style="color: #6F58E7; text-decoration: none; font-weight: 600; font-size: 14px;">
                  📞 Book a Free Consultation Call →
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
                Keep creating amazing content! 🚀<br>
                The ${APP_NAME} Team
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                ${APP_URL}
              </p>
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

function getQuickBlogEmailTemplate(
  userName: string,
  blogTitle: string,
  blogUrl: string,
  blogExcerpt: string,
  dayText: string = "Day 1 of 7",
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Sample Blog is Ready!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden; box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 8px 0; color: rgba(255,255,255,0.95); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">📅 ${dayText} - Free Trial</p>
              <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 700;">🚀 Your Sample Blog is Ready!</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 18px;">A quick preview of what ${APP_NAME} can do</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              
              <p style="margin: 0 0 30px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Great news! We've generated a sample blog post for you in just seconds. This is a quick preview of our SEO-optimized content generation.
              </p>

              <!-- Blog Preview Card -->
              <div style="background: linear-gradient(135deg, #6F58E7 0%, #9A7FF5 100%); border-radius: 12px; padding: 30px; margin: 30px 0; box-shadow: 0 10px 30px rgba(111, 88, 231, 0.3);">
                <h2 style="margin: 0 0 16px 0; color: white; font-size: 22px; font-weight: 600; line-height: 1.4;">${blogTitle}</h2>
                <p style="margin: 0 0 24px 0; color: rgba(255,255,255,0.9); font-size: 15px; line-height: 1.6;">${blogExcerpt}</p>
                <a href="${blogUrl}" style="display: inline-block; background: #8C77F5; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                  Read Your Blog →
                </a>
              </div>

              <!-- Sample Blog Notice -->
              <div style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <h3 style="margin: 0 0 12px 0; color: #1565c0; font-size: 16px; font-weight: 600;">📝 About This Sample Blog:</h3>
                <ul style="margin: 0; padding-left: 20px; color: #1565c0; font-size: 14px; line-height: 1.8;">
                  <li>This is a <strong>sample blog</strong> to show you our content quality</li>
                  <li>Includes one purpose-built featured image</li>
                  <li>Your full content plan adds researched keywords and ongoing scheduled articles</li>
                  <li>Your complete onboarding is running in the background</li>
                </ul>
              </div>

              <div style="background: linear-gradient(135deg, rgba(175, 104, 239, 0.1) 0%, rgba(254, 112, 178, 0.1) 50%, rgba(254, 149, 113, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0;">
                <h3 style="margin: 0 0 16px 0; color: #333; font-size: 18px; font-weight: 600;">⏳ What's Happening Now:</h3>
                <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 15px; line-height: 1.8;">
                  <li>🔍 Deep analysis of your website</li>
                  <li>🎯 Researching 30 high-value keywords</li>
                  <li>✍️ Creating comprehensive content strategy</li>
                  <li>📊 Setting up your SEO dashboard</li>
                </ul>
                <p style="margin: 16px 0 0 0; color: #666; font-size: 14px;">
                  You'll receive more emails as your full content is ready!
                </p>
              </div>

              <div style="text-align: center; margin: 30px 0;">
                <a href="${APP_URL}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(175, 104, 239, 0.4);">
                  Go to Dashboard →
                </a>
              </div>

              <!-- Book a Call CTA -->
              <div style="background: linear-gradient(135deg, rgba(111, 88, 231, 0.1) 0%, rgba(154, 127, 245, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0; text-align: center;">
                <h3 style="margin: 0 0 12px 0; color: #6F58E7; font-size: 18px; font-weight: 600;">📞 Want Full Website Integration?</h3>
                <p style="margin: 0 0 16px 0; color: #555; font-size: 14px; line-height: 1.6;">
                  Book a free call and we'll help you integrate ${APP_NAME} with your WordPress site and set up auto-publishing!
                </p>
                <a href="${MEETING_URL}" style="display: inline-block; background: #6F58E7; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                  Book Free Consultation →
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
                This is just the beginning! 🚀<br>
                The ${APP_NAME} Team
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                ${APP_URL}
              </p>
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

function getTrialExpiringEmailTemplate(
  userName: string,
  daysLeft: number,
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Trial is Expiring Soon</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden;     box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 700;">⏰ Your Trial Expires in ${daysLeft} Days</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 18px;">Don't lose access to your content!</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              
              <p style="margin: 0 0 30px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Your ${APP_NAME} free trial is ending soon! You have <strong>${daysLeft} days</strong> left to upgrade and keep all your amazing content, keywords, and SEO insights.
              </p>

              <div style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); border-radius: 12px; padding: 30px; margin: 30px 0; text-align: center;">
                <h2 style="margin: 0 0 20px 0; color: white; font-size: 28px; font-weight: 700;">${daysLeft} Days Left</h2>
                <p style="margin: 0; color: rgba(255,255,255,0.9); font-size: 16px;">Upgrade now to continue your SEO journey</p>
              </div>

              <div style="background: #f3e5f5; border-radius: 12px; padding: 24px; margin: 30px 0;">
                <h3 style="margin: 0 0 16px 0; color: #6a1b9a; font-size: 18px; font-weight: 600;">🚀 What You'll Keep with Premium:</h3>
                <ul style="margin: 0; padding-left: 20px; color: #6a1b9a; font-size: 15px; line-height: 2;">
                  <li><strong>Unlimited</strong> blog generation</li>
                  <li><strong>30+ keywords</strong> already researched</li>
                  <li><strong>SEO analytics</strong> and tracking</li>
                  <li><strong>WordPress</strong> auto-publishing</li>
                  <li><strong>Priority</strong> support</li>
                  <li><strong>Advanced</strong> content optimization</li>
                </ul>
              </div>

              <div style="text-align: center; margin: 40px 0;">
                <a href="${APP_URL}/dashboard/settings/billing" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 18px 48px; border-radius: 8px; font-weight: 700; font-size: 18px; box-shadow: 0 6px 20px rgba(175, 104, 239, 0.4);">
                  Upgrade Now →
                </a>
                <p style="margin: 12px 0 0 0; color: #999; font-size: 13px;">Cancel anytime, no questions asked</p>
              </div>

              <div style="background: #ffebee; border-left: 4px solid #f44336; padding: 16px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0; color: #c62828; font-size: 14px; line-height: 1.6;">
                  <strong>⚠️ Important:</strong> After your trial ends, you'll lose access to blog generation, keyword tracking, and analytics. Your existing content will be preserved, but you won't be able to create new posts.
                </p>
              </div>

              <!-- Book a Call CTA -->
              <div style="background: linear-gradient(135deg, rgba(111, 88, 231, 0.1) 0%, rgba(154, 127, 245, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0; text-align: center;">
                <h3 style="margin: 0 0 12px 0; color: #6F58E7; font-size: 18px; font-weight: 600;">📞 Not Sure If It's Right for You?</h3>
                <p style="margin: 0 0 16px 0; color: #555; font-size: 14px; line-height: 1.6;">
                  Book a free call with our team. We'll answer your questions and help you decide.
                </p>
                <a href="${MEETING_URL}" style="display: inline-block; background: #6F58E7; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                  Book Free Consultation →
                </a>
              </div>

              <p style="margin: 30px 0 0 0; color: #666; font-size: 14px; line-height: 1.6;">
                Questions? Reply to this email or <a href="${MEETING_URL}" style="color: #AF68EF; text-decoration: none;">book a call</a> with us.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
                We hope to see you stick around! 💜<br>
                The ${APP_NAME} Team
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                ${APP_URL}
              </p>
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

function getTrialExpiredEmailTemplate(userName: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Trial Has Ended</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden;     box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 700;">Your Trial Has Ended</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.8); font-size: 18px;">But your SEO journey doesn't have to!</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              
              <p style="margin: 0 0 30px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Your 7-day free trial of ${APP_NAME} has come to an end. We hope you enjoyed exploring our platform and seeing the power of AI-driven SEO content!
              </p>

              <div style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); border-radius: 12px; padding: 30px; margin: 30px 0; text-align: center;">
                <h2 style="margin: 0 0 16px 0; color: white; font-size: 24px; font-weight: 700;">🎁 Special Offer: 20% Off</h2>
                <p style="margin: 0 0 24px 0; color: rgba(255,255,255,0.95); font-size: 16px; line-height: 1.6;">
                  Upgrade within the next 48 hours and get <strong>20% off</strong> your first 3 months!
                </p>
                <div style="background: rgba(255,255,255,0.2); border-radius: 8px; padding: 12px; margin: 0 auto; max-width: 300px;">
                  <p style="margin: 0; color: white; font-size: 24px; font-weight: 700; letter-spacing: 2px;">TRIAL20</p>
                  <p style="margin: 4px 0 0 0; color: rgba(255,255,255,0.9); font-size: 13px;">Use code at checkout</p>
                </div>
              </div>

              <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; margin: 30px 0;">
                <h3 style="margin: 0 0 16px 0; color: #333; font-size: 18px; font-weight: 600;">💎 What You're Missing:</h3>
                <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 15px; line-height: 2;">
                  <li>Generate <strong>unlimited</strong> SEO-optimized blogs</li>
                  <li>Track keyword rankings in real-time</li>
                  <li>Auto-publish to WordPress</li>
                  <li>Advanced analytics dashboard</li>
                  <li>Priority email support</li>
                  <li>Custom content strategies</li>
                </ul>
              </div>

              <div style="text-align: center; margin: 40px 0;">
                <a href="${APP_URL}/dashboard/settings/billing?promo=TRIAL20" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 18px 48px; border-radius: 8px; font-weight: 700; font-size: 18px; box-shadow: 0 6px 20px rgba(175, 104, 239, 0.4);">
                  Claim 20% Off Now →
                </a>
                <p style="margin: 12px 0 0 0; color: #999; font-size: 13px;">Offer expires in 48 hours</p>
              </div>

              <div style="border-top: 1px solid #e0e0e0; padding-top: 24px; margin-top: 30px;">
                <p style="margin: 0 0 16px 0; color: #333; font-size: 15px; font-weight: 600;">Your Content is Safe</p>
                <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.6;">
                  Don't worry! All your blogs, keywords, and settings are preserved. Upgrade anytime to pick up right where you left off.
                </p>
              </div>

              <!-- Book a Call CTA -->
              <div style="background: linear-gradient(135deg, rgba(111, 88, 231, 0.1) 0%, rgba(154, 127, 245, 0.1) 100%); border-radius: 12px; padding: 24px; margin: 30px 0; text-align: center;">
                <h3 style="margin: 0 0 12px 0; color: #6F58E7; font-size: 18px; font-weight: 600;">📞 Let's Talk About Your SEO Goals</h3>
                <p style="margin: 0 0 16px 0; color: #555; font-size: 14px; line-height: 1.6;">
                  Book a free call with our team to discuss how ${APP_NAME} can help grow your business.
                </p>
                <a href="${MEETING_URL}" style="display: inline-block; background: #6F58E7; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                  Book Free Consultation →
                </a>
              </div>

              <p style="margin: 30px 0 0 0; color: #666; font-size: 14px; line-height: 1.6;">
                Have questions? Reply to this email or <a href="${MEETING_URL}" style="color: #AF68EF; text-decoration: none;">book a free call</a> with us!
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
                We'd love to have you back! 💜<br>
                The ${APP_NAME} Team
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                ${APP_URL}
              </p>
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

function getDailyBlogSummaryEmailTemplate(
  userName: string,
  blogs: Array<{ title: string; slug: string; excerpt: string }>,
  date: string,
  dayText: string = "Day 1 of 7",
): string {
  const blogsList = blogs
    .map(
      (blog, index) => `
      <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 16px;">
        <h3 style="margin: 0 0 8px 0; color: #333; font-size: 18px; font-weight: 600;">${index + 1}. ${blog.title}</h3>
        <p style="margin: 0 0 12px 0; color: #666; font-size: 14px; line-height: 1.5;">${blog.excerpt || ""}</p>
        <a href="${APP_URL}/dashboard/project/all-content/${blog.slug}" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 14px;">
          Read Blog →
        </a>
      </div>
    `,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Daily Blog Summary</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: white; min-height: 100vh;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px; background: white;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden;     box-shadow: 0px 0px 47px 17px #f5f5f5;">
          <tr>
            <td style="background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 8px 0; color: rgba(255,255,255,0.95); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">📅 ${dayText} - Free Trial</p>
              <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 700;">📚 Your Daily Blog Summary</h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 18px;">${blogs.length} New Blog${blogs.length > 1 ? "s" : ""} Generated Today</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #333; font-size: 16px; line-height: 1.6;">Hi ${userName},</p>
              <p style="margin: 0 0 30px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Great news! We've generated <strong>${blogs.length}</strong> new SEO-optimized blog${blogs.length > 1 ? "s" : ""} for you today (${date}). They're ready for you to review, edit, and publish!
              </p>
              <div style="margin: 30px 0;">
                ${blogsList}
              </div>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${APP_URL}/dashboard/project/all-content" style="display: inline-block; background: linear-gradient(135deg, #AF68EF 0%, #FE70B2 50%, #FE9571 100%); color: white; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(175, 104, 239, 0.4);">
                  View All Blogs →
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
                Keep creating amazing content! 🚀<br>
                The ${APP_NAME} Team
              </p>
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
