import { Router } from "express";
import { requireBackendAuth, type AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { sendError } from "../utils/response.utils";

const AdminRouter = Router();

AdminRouter.get(
  "/site-entitlements/:userId",
  requireBackendAuth,
  async (req: AuthenticatedRequest, res) => {
    if (!req.authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { userId } = req.params;
    if (userId !== req.authUserId) {
      return sendError(res, "Forbidden", 403);
    }

    try {
      const businesses = await prisma.business.findMany({
        where: {
          userId: req.authUserId,
        },
        include: {
          websiteSubscription: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      const result = businesses.map((business) => ({
        id: business.id,
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
        websiteStatus: business.websiteStatus,
        isActive: business.isActive,
        websiteSubscription: business.websiteSubscription
          ? {
              status: business.websiteSubscription.status,
              trialStatus: business.websiteSubscription.trialStatus,
              trialStartDate: business.websiteSubscription.trialStartDate,
              trialEndDate: business.websiteSubscription.trialEndDate,
              currentPeriodEnd: business.websiteSubscription.currentPeriodEnd,
            }
          : null,
      }));

      return res.json(result);
    } catch (error) {
      console.error("Error fetching site entitlements:", error);
      return sendError(res, "Internal server error", 500);
    }
  },
);

export default AdminRouter;
