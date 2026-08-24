import { describe, expect, it } from "bun:test";
import {
  filterOutGenericServices,
  isGenericService,
} from "../utils/generic-services.utils";

describe("isGenericService", () => {
  it("flags fulfillment / checkout / delivery mechanics", () => {
    expect(isGenericService("Order Delivery")).toBe(true);
    expect(isGenericService("order  delivery")).toBe(true);
    expect(isGenericService("Online Ordering")).toBe(true);
    expect(isGenericService("ORDERING")).toBe(true);
    expect(isGenericService("Pickup")).toBe(true);
    expect(isGenericService("Curbside Pickup")).toBe(true);
    expect(isGenericService("In-store pickup")).toBe(true);
    expect(isGenericService("Takeout")).toBe(true);
    expect(isGenericService("Drive-thru")).toBe(true);
    expect(isGenericService("Delivery")).toBe(true);
    expect(isGenericService("Delivery Service")).toBe(true);
    expect(isGenericService("Same-day delivery")).toBe(true);
    expect(isGenericService("Free Shipping")).toBe(true);
    expect(isGenericService("Shipping")).toBe(true);
    expect(isGenericService("Add to cart")).toBe(true);
    expect(isGenericService("Buy now")).toBe(true);
    expect(isGenericService("Checkout")).toBe(true);
  });

  it("flags returns / warranty / financing policy labels", () => {
    expect(isGenericService("Returns")).toBe(true);
    expect(isGenericService("Returns & Exchanges")).toBe(true);
    expect(isGenericService("Refunds")).toBe(true);
    expect(isGenericService("Warranty")).toBe(true);
    expect(isGenericService("Guarantee")).toBe(true);
    expect(isGenericService("Financing")).toBe(true);
    expect(isGenericService("Financing options")).toBe(true);
    expect(isGenericService("Insurance accepted")).toBe(true);
    expect(isGenericService("Payment plans")).toBe(true);
  });

  it("flags commerce wrappers (gift cards, memberships, loyalty)", () => {
    expect(isGenericService("Gift Cards")).toBe(true);
    expect(isGenericService("Gift card")).toBe(true);
    expect(isGenericService("Gift Certificates")).toBe(true);
    expect(isGenericService("E-gift card")).toBe(true);
    expect(isGenericService("Subscriptions")).toBe(true);
    expect(isGenericService("Membership")).toBe(true);
    expect(isGenericService("Loyalty Program")).toBe(true);
    expect(isGenericService("Rewards")).toBe(true);
  });

  it("flags CTAs / marketing buttons", () => {
    expect(isGenericService("Get a Quote")).toBe(true);
    expect(isGenericService("Get Quote")).toBe(true);
    expect(isGenericService("Free Quote")).toBe(true);
    expect(isGenericService("Free Estimate")).toBe(true);
    expect(isGenericService("Free Consultation")).toBe(true);
    expect(isGenericService("Free Trial")).toBe(true);
    expect(isGenericService("Free Demo")).toBe(true);
    expect(isGenericService("Request a Quote")).toBe(true);
    expect(isGenericService("Schedule Appointment")).toBe(true);
    expect(isGenericService("Schedule a Consultation")).toBe(true);
    expect(isGenericService("Book Now")).toBe(true);
    expect(isGenericService("Book Online")).toBe(true);
    expect(isGenericService("Book an appointment")).toBe(true);
    expect(isGenericService("Booking")).toBe(true);
    expect(isGenericService("Online Booking")).toBe(true);
    expect(isGenericService("Appointments")).toBe(true);
    expect(isGenericService("Call Us")).toBe(true);
    expect(isGenericService("Call Now")).toBe(true);
    expect(isGenericService("Contact Us")).toBe(true);
    expect(isGenericService("Reach out")).toBe(true);
    expect(isGenericService("Inquire")).toBe(true);
    expect(isGenericService("Inquiries")).toBe(true);
    expect(isGenericService("Get Started")).toBe(true);
    expect(isGenericService("Learn More")).toBe(true);
    expect(isGenericService("Sign Up Today")).toBe(true);
    expect(isGenericService("Subscribe")).toBe(true);
    expect(isGenericService("Newsletter")).toBe(true);
  });

  it("flags website navigation / footer labels", () => {
    expect(isGenericService("Home")).toBe(true);
    expect(isGenericService("About")).toBe(true);
    expect(isGenericService("About Us")).toBe(true);
    expect(isGenericService("Our Story")).toBe(true);
    expect(isGenericService("Contact")).toBe(true);
    expect(isGenericService("Locations")).toBe(true);
    expect(isGenericService("Our Location")).toBe(true);
    expect(isGenericService("Hours")).toBe(true);
    expect(isGenericService("Directions")).toBe(true);
    expect(isGenericService("Services")).toBe(true);
    expect(isGenericService("Our Services")).toBe(true);
    expect(isGenericService("Products")).toBe(true);
    expect(isGenericService("Shop")).toBe(true);
    expect(isGenericService("Store")).toBe(true);
    expect(isGenericService("Gallery")).toBe(true);
    expect(isGenericService("Portfolio")).toBe(true);
    expect(isGenericService("Testimonials")).toBe(true);
    expect(isGenericService("Reviews")).toBe(true);
    expect(isGenericService("Blog")).toBe(true);
    expect(isGenericService("News")).toBe(true);
    expect(isGenericService("Events")).toBe(true);
    expect(isGenericService("Careers")).toBe(true);
    expect(isGenericService("Our Team")).toBe(true);
    expect(isGenericService("Team")).toBe(true);
    expect(isGenericService("FAQ")).toBe(true);
    expect(isGenericService("FAQs")).toBe(true);
    expect(isGenericService("Help Center")).toBe(true);
    expect(isGenericService("Privacy Policy")).toBe(true);
    expect(isGenericService("Terms of Service")).toBe(true);
    expect(isGenericService("Sitemap")).toBe(true);
  });

  it("flags account / auth labels", () => {
    expect(isGenericService("My Account")).toBe(true);
    expect(isGenericService("Login")).toBe(true);
    expect(isGenericService("Log In")).toBe(true);
    expect(isGenericService("Sign In")).toBe(true);
    expect(isGenericService("Sign Up")).toBe(true);
    expect(isGenericService("Register")).toBe(true);
    expect(isGenericService("Dashboard")).toBe(true);
    expect(isGenericService("Create an Account")).toBe(true);
  });

  it("flags unqualified single-word generic services", () => {
    expect(isGenericService("Service")).toBe(true);
    expect(isGenericService("Repair")).toBe(true);
    expect(isGenericService("Repairs")).toBe(true);
    expect(isGenericService("Installation")).toBe(true);
    expect(isGenericService("Maintenance")).toBe(true);
    expect(isGenericService("Inspection")).toBe(true);
    expect(isGenericService("Cleaning")).toBe(true);
    expect(isGenericService("Consultation")).toBe(true);
    expect(isGenericService("Consulting")).toBe(true);
    expect(isGenericService("Help")).toBe(true);
    expect(isGenericService("Solutions")).toBe(true);
    expect(isGenericService("Sales")).toBe(true);
    expect(isGenericService("Quote")).toBe(true);
    expect(isGenericService("Estimate")).toBe(true);
    expect(isGenericService("Pricing")).toBe(true);
    expect(isGenericService("Plans")).toBe(true);
    expect(isGenericService("Packages")).toBe(true);
    expect(isGenericService("Treatment")).toBe(true);
    expect(isGenericService("Treatments")).toBe(true);
    expect(isGenericService("Lessons")).toBe(true);
    expect(isGenericService("Classes")).toBe(true);
    expect(isGenericService("Training")).toBe(true);
  });

  it("flags vague marketing modifiers used alone", () => {
    expect(isGenericService("Premium Service")).toBe(true);
    expect(isGenericService("Quality Service")).toBe(true);
    expect(isGenericService("Professional Services")).toBe(true);
    expect(isGenericService("Expert Service")).toBe(true);
    expect(isGenericService("Reliable Service")).toBe(true);
    expect(isGenericService("Affordable Services")).toBe(true);
    expect(isGenericService("Custom Solutions")).toBe(true);
    expect(isGenericService("Full Service")).toBe(true);
    expect(isGenericService("One-Stop Shop")).toBe(true);
  });

  it("flags availability filler", () => {
    expect(isGenericService("24/7 Service")).toBe(true);
    expect(isGenericService("24-7")).toBe(true);
    expect(isGenericService("24 Hour Service")).toBe(true);
    expect(isGenericService("Emergency Service")).toBe(true);
    expect(isGenericService("Same-Day Service")).toBe(true);
    expect(isGenericService("Walk-ins Welcome")).toBe(true);
    expect(isGenericService("By Appointment Only")).toBe(true);
  });

  it("treats empty / whitespace / too-short labels as generic", () => {
    expect(isGenericService("")).toBe(true);
    expect(isGenericService("   ")).toBe(true);
    expect(isGenericService("X")).toBe(true);
    expect(isGenericService("Hi")).toBe(true);
  });

  it("does NOT flag specific offerings across verticals", () => {
    // Food / catering
    expect(isGenericService("Wedding catering")).toBe(false);
    expect(isGenericService("Office lunch boxes")).toBe(false);
    expect(isGenericService("Halal shawarma platters")).toBe(false);
    expect(isGenericService("Private dining room")).toBe(false);

    // Trade / home services
    expect(isGenericService("Drain cleaning")).toBe(false);
    expect(isGenericService("Water heater repair")).toBe(false);
    expect(isGenericService("Tankless water heater installation")).toBe(false);
    expect(isGenericService("Brake pad replacement")).toBe(false);
    expect(isGenericService("Wheel alignment")).toBe(false);
    expect(isGenericService("Roof replacement")).toBe(false);
    expect(isGenericService("Kitchen remodeling")).toBe(false);
    expect(isGenericService("Hardwood floor refinishing")).toBe(false);

    // Healthcare
    expect(isGenericService("Root canal therapy")).toBe(false);
    expect(isGenericService("Invisalign clear aligners")).toBe(false);
    expect(isGenericService("Pediatric dental care")).toBe(false);
    expect(isGenericService("Teeth whitening")).toBe(false);

    // Beauty / wellness
    expect(isGenericService("Balayage colour")).toBe(false);
    expect(isGenericService("Bridal hair styling")).toBe(false);
    expect(isGenericService("Keratin smoothing treatment")).toBe(false);
    expect(isGenericService("Reformer Pilates classes")).toBe(false);
    expect(isGenericService("Prenatal yoga classes")).toBe(false);
    expect(isGenericService("Personal training sessions")).toBe(false);

    // Professional services
    expect(isGenericService("Estate planning will drafting")).toBe(false);
    expect(isGenericService("Personal injury representation")).toBe(false);
    expect(isGenericService("Business contract review")).toBe(false);
    expect(isGenericService("Real estate closings")).toBe(false);

    // Retail / specialty
    expect(isGenericService("Personal styling sessions")).toBe(false);
    expect(isGenericService("Bridal wardrobe consulting")).toBe(false);
    expect(isGenericService("In-store alterations")).toBe(false);

    // Initialisms (3 chars+) and qualified offerings
    expect(isGenericService("SEO")).toBe(false);
    expect(isGenericService("CPR training for daycares")).toBe(false);
    // Looks like "Delivery Service" but is a specific offering for the vertical.
    expect(isGenericService("Same-day catering delivery for offices")).toBe(false);
  });
});

describe("filterOutGenericServices", () => {
  it("strips generic entries while preserving order of specifics", () => {
    expect(
      filterOutGenericServices([
        "Wedding catering",
        "Order Delivery",
        "Office lunch boxes",
        "Pickup",
        "Halal platters",
      ]),
    ).toEqual([
      "Wedding catering",
      "Office lunch boxes",
      "Halal platters",
    ]);
  });

  it("dedupes case-insensitively", () => {
    expect(
      filterOutGenericServices([
        "Wedding Catering",
        "wedding catering",
        "  Wedding Catering  ",
      ]),
    ).toEqual(["Wedding Catering"]);
  });

  it("ignores non-string values without throwing", () => {
    expect(
      filterOutGenericServices([
        "Wedding catering",
        // @ts-expect-error — runtime contract is mixed input from JSON
        null,
        // @ts-expect-error
        undefined,
        // @ts-expect-error
        42,
        "Office lunch boxes",
      ]),
    ).toEqual(["Wedding catering", "Office lunch boxes"]);
  });

  it("returns an empty array when every input is generic", () => {
    expect(
      filterOutGenericServices([
        "Order Delivery",
        "Pickup",
        "Gift Cards",
        "Contact Us",
      ]),
    ).toEqual([]);
  });
});
