type BackendBrandConfig = {
  name: string;
  logoUrl: string;
  frontendUrl: string;
  meetingUrl: string;
  copyright: string;
  fromEmail: string;
  fromName: string;
};

const brandName: string = process.env.BRAND_NAME ?? "Uplift AI";

export const BRAND: BackendBrandConfig = {
  name: brandName,
  logoUrl:
    process.env.EMAIL_LOGO_URL ?? "https://www.upliftai.co/logo.png",
  frontendUrl: process.env.FRONTEND_URL ?? "http://upliftai.co/",
  meetingUrl:
    process.env.MEETING_URL ?? "https://cal.com/upliftseoai/30min",
  copyright: `${new Date().getFullYear()} ${brandName}`,
  fromEmail:
    process.env.RESEND_FROM_EMAIL ?? "noreply@yourdomain.com",
  fromName: process.env.RESEND_FROM_NAME ?? "Uplift AI",
};
