import { describe, expect, it } from "bun:test";
import { clearExistingCustomerDiscount } from "../utils/stripe-checkout-discount";

describe("clearExistingCustomerDiscount", () => {
  it("deletes an inherited customer discount before Checkout", async () => {
    const deletedCustomerIds: string[] = [];

    const cleared = await clearExistingCustomerDiscount("cus_discounted", {
      retrieve: async () => ({ discount: { id: "di_60off" } }),
      deleteDiscount: async (customerId) => {
        deletedCustomerIds.push(customerId);
        return { deleted: true };
      },
    });

    expect(cleared).toBe(true);
    expect(deletedCustomerIds).toEqual(["cus_discounted"]);
  });

  it("does not call Stripe delete when no customer discount exists", async () => {
    let deleteCalls = 0;

    const cleared = await clearExistingCustomerDiscount("cus_full_price", {
      retrieve: async () => ({ discount: null }),
      deleteDiscount: async () => {
        deleteCalls += 1;
        return { deleted: true };
      },
    });

    expect(cleared).toBe(false);
    expect(deleteCalls).toBe(0);
  });

  it("fails closed for a deleted customer", async () => {
    let error: unknown;

    try {
      await clearExistingCustomerDiscount("cus_deleted", {
        retrieve: async () => ({ deleted: true }),
        deleteDiscount: async () => ({ deleted: true }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toBe(
      "Stripe customer is no longer available",
    );
  });
});
