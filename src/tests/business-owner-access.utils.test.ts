import { describe, expect, it, mock } from "bun:test";
import { getOwnedActiveBusiness } from "../utils/business-owner-access.utils";

describe("business owner access helper", () => {
  it("uses authenticated user ownership and active business status", async () => {
    const findBusinessMock = mock(async () => ({ id: "biz-1" }));

    const business = await getOwnedActiveBusiness(
      { businessId: "biz-1", userId: "user-1" },
      findBusinessMock,
    );

    expect(business).toEqual({ id: "biz-1" });
    expect(findBusinessMock).toHaveBeenCalledWith({
      where: { id: "biz-1", userId: "user-1", isActive: true },
      select: { id: true },
    });
  });

  it("does not query when the authenticated user or business is missing", async () => {
    const findBusinessMock = mock(async () => ({ id: "biz-1" }));

    await expect(
      getOwnedActiveBusiness(
        { businessId: "biz-1", userId: "" },
        findBusinessMock,
      ),
    ).resolves.toBeNull();
    await expect(
      getOwnedActiveBusiness(
        { businessId: "", userId: "user-1" },
        findBusinessMock,
      ),
    ).resolves.toBeNull();
    expect(findBusinessMock).not.toHaveBeenCalled();
  });
});
