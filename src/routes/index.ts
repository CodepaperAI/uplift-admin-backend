import { Router } from "express";

import BacklinkRouter from "../services/backlink.service";
import BlogRouter from "../services/blog.service";
import BusinessRouter from "../services/business.service";
import KeywordRouter from "../services/keyword.service";
import LLMRouter from "../services/llm.service";
import OnboardingRouter from "../services/onboarding.service";
import WordPressRouter from "../services/wordpress.service";
import AdminRouter from "./admin.routes";
import AccountContextRouter from "./account-context.routes";
import SeoAuditRouter from "./seo-audit.routes";
import ApiTokenRouter from "./api-token.routes";
import EmailRouter from "./email.routes";
import ExternalBacklinksRouter from "./external-backlinks.routes";
import GoogleMyBusinessRouter from "./google-my-business.routes";
import LegalConsentRouter from "./legal-consent.routes";
import GuestPostingRouter from "./guest-posting.routes";
import MediumOAuthRouter from "./medium-oauth.routes";
import PublicApiRouter from "./public-api.routes";
import PublishingRouter from "./publishing.routes";
import QuickScrapeRouter from "../services/quick-scrape.service";
import RedditOAuthRouter from "./reddit-oauth.routes";
import RewardfulRouter from "./rewardful.routes";
import ShopifyOAuthRouter from "./shopify-oauth.routes";
import TrialRouter from "../services/trial.service";
import TrialAnalyticsRouter from "../services/trial-analytics.service.route";
import WebflowOAuthRouter from "./webflow-oauth.routes";
import InternalWebsiteRouter from "./internal-website.routes";
import WebsiteRouter from "./website.routes";
import WixOAuthRouter from "./wix-oauth.routes";
import WordPressOAuthRouter from "./wordpress-oauth.routes";
import SuperAdminRouter from "./superadmin.routes";
import AgencyAdminRouter from "./agency-admin.routes";
import BillingInternalRouter from "./billing-internal.routes";
import InternalAuthEmailRouter from "./internal-auth-email.routes";
import AuthEventsRouter from "./auth-events.routes";
import ClusterRouter from "../services/cluster.service";
import DRDashboardRouter from "./dr-dashboard.routes";
import OffPageRouter from "./offpage.routes";
import AiVisibilityRouter from "../services/ai-visibility.service";
import BusinessGeoProfileRouter from "../services/business-geo-profile.routes";
import BusinessPhotosRouter from "../services/business-photos.routes";
import FramerPluginAuthedRouter, {
  FramerPluginPublicRouter,
} from "./framer-plugin.routes";
import SocialCreativeRouter from "./social-creative.routes";
import SocialPublishingRouter from "./social-publishing.routes";
import CommandRouter from "./command.routes";
import CommandCallWebhookRouter from "./command-call-webhook.routes";
import DashboardRouter from "./dashboard.routes";
import BillingPortalRouter from "./billing-portal.routes";
import StripeWebhookRouter from "./stripe-webhook.routes";
import LocationRouter from "./location.routes";
import SalesPanelRouter from "./sales-panel.routes";
import PublicStatusProbeRouter from "./public-status-probe.routes";

const RouteHandler: Router = Router();

RouteHandler.use("/api/v1/account", AccountContextRouter);
RouteHandler.use("/api/v1/billing", BillingPortalRouter);
RouteHandler.use("/api/v1/stripe/webhook", StripeWebhookRouter);
RouteHandler.use("/api/v1/location", LocationRouter);
RouteHandler.use("/api/v1/business", BusinessRouter);
RouteHandler.use("/api/v1/dashboard", DashboardRouter);
RouteHandler.use("/api/v1/onboarding", OnboardingRouter);
RouteHandler.use("/api/v1/llm", LLMRouter);
RouteHandler.use("/api/v1/blog", BlogRouter);
RouteHandler.use("/api/v1/keyword", KeywordRouter);
RouteHandler.use("/api/v1/wordpress", WordPressRouter);
RouteHandler.use("/api/v1/backlink", BacklinkRouter);
RouteHandler.use("/api/v1/google-my-business", GoogleMyBusinessRouter);
RouteHandler.use("/api/v1/legal/consent", LegalConsentRouter);
RouteHandler.use("/api/v1/publishing", PublishingRouter);
RouteHandler.use("/api/v1/external-backlinks", ExternalBacklinksRouter);
RouteHandler.use("/api/v1/guest-posting", GuestPostingRouter);
RouteHandler.use("/api/v1", WordPressOAuthRouter); // Mount WordPress OAuth routes
RouteHandler.use("/api/v1", ShopifyOAuthRouter); // Mount Shopify OAuth routes
RouteHandler.use("/api/v1", WebflowOAuthRouter); // Mount Webflow OAuth routes
RouteHandler.use("/api/v1", WixOAuthRouter); // Mount Wix OAuth routes
RouteHandler.use("/api/v1", RedditOAuthRouter); // Mount Reddit OAuth routes
RouteHandler.use("/api/v1", MediumOAuthRouter); // Mount Medium OAuth routes
RouteHandler.use("/api/v1/website/internal", InternalWebsiteRouter);
RouteHandler.use("/api/v1/website", WebsiteRouter);
RouteHandler.use("/api/v1/email", EmailRouter);
RouteHandler.use("/api/v1/api-tokens", ApiTokenRouter);
RouteHandler.use("/api/v1/quick-scrape", QuickScrapeRouter);
RouteHandler.use("/api/v1/rewardful", RewardfulRouter);
RouteHandler.use("/api/v1/trial", TrialRouter);
RouteHandler.use("/api/v1/trial-analytics", TrialAnalyticsRouter);
RouteHandler.use("/api/v1/admin", AdminRouter);
RouteHandler.use("/api/v1/superadmin/agencies", SuperAdminRouter);
RouteHandler.use("/api/v1/agency-admin", AgencyAdminRouter);
RouteHandler.use("/api/v1/billing/internal/events", BillingInternalRouter);
RouteHandler.use("/api/v1/internal/auth-email", InternalAuthEmailRouter);
RouteHandler.use("/api/v1/auth-events", AuthEventsRouter);
RouteHandler.use("/api/v1/seo-audit", SeoAuditRouter);
RouteHandler.use("/api/v1/clusters", ClusterRouter);
RouteHandler.use("/api/v1/dr-dashboard", DRDashboardRouter);
RouteHandler.use("/api/v1/off-page", OffPageRouter);
RouteHandler.use("/api/v1/ai-visibility", AiVisibilityRouter);
RouteHandler.use("/api/v1/geo-profile", BusinessGeoProfileRouter);
RouteHandler.use("/api/v1/business-photos", BusinessPhotosRouter);
RouteHandler.use("/api/v1/framer-plugin", FramerPluginAuthedRouter);
RouteHandler.use("/api/v1/social-creatives", SocialCreativeRouter);
RouteHandler.use("/api/v1/social-publishing", SocialPublishingRouter);
RouteHandler.use("/api/v1/command/webhooks", CommandCallWebhookRouter);
RouteHandler.use("/api/v1/command", CommandRouter);
RouteHandler.use("/api/v1/sales", SalesPanelRouter);
RouteHandler.use("/api/v1/status/components", PublicStatusProbeRouter);
// Route-name alias for clients migrating from Studio. seo-be keeps its safer
// authenticated 202 + run polling contract instead of holding the request open.
RouteHandler.use("/api/v1/social-media", SocialCreativeRouter);
RouteHandler.use("/api/public/v1/framer-plugin", FramerPluginPublicRouter);
RouteHandler.use("/api/public/v1", PublicApiRouter);

export default RouteHandler;
