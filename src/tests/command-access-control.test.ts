import { describe, expect, it } from "bun:test";
import {
  canAccessRepScope,
  canEnterCommandPanel,
  COMMAND_CAPABILITIES,
  resolveCommandCapabilities,
} from "../command/access-control";
import { canAccessPipelineRep } from "../command/pipeline-access";
import { canAccessDealRep } from "../command/deal-access";

describe("Command Panel access control", () => {
  it("never admits a normal product user without explicit Command enablement", () => {
    expect(
      canEnterCommandPanel({ role: "USER", commandPanelEnabled: false }),
    ).toBe(false);
    expect(
      canEnterCommandPanel({ role: "USER", commandPanelEnabled: true }),
    ).toBe(true);
  });

  it("always admits SUPERADMIN while rejecting unrelated roles", () => {
    expect(
      canEnterCommandPanel({
        role: "SUPERADMIN",
        commandPanelEnabled: false,
      }),
    ).toBe(true);
    expect(
      canEnterCommandPanel({
        role: "AGENCY_ADMIN",
        commandPanelEnabled: true,
      }),
    ).toBe(false);
  });

  it("gives SUPERADMIN every named capability", () => {
    expect(
      resolveCommandCapabilities("SUPERADMIN", [
        { capability: "view.financials", enabled: false },
      ]),
    ).toEqual([...COMMAND_CAPABILITIES]);
  });

  it("applies persisted grants and revocations over conservative defaults", () => {
    const capabilities = resolveCommandCapabilities("SALES", [
      { capability: "edit.calls", enabled: false },
      { capability: "view.coaching", enabled: true },
      { capability: "not.real", enabled: true },
    ]);

    expect(capabilities).toContain("view.own");
    expect(capabilities).toContain("view.own.financials");
    expect(capabilities).not.toContain("view.own.coaching");
    expect(capabilities).toContain("view.coaching");
    expect(capabilities).not.toContain("edit.calls");
    expect(capabilities).not.toContain("not.real");
  });

  it("allows a view.own actor to access exactly their own rep row", () => {
    const capabilities = resolveCommandCapabilities("SALES", []);
    expect(
      canAccessRepScope({
        capabilities,
        actorRepId: "rep-a",
        requestedRepId: "rep-a",
      }),
    ).toBe(true);
    expect(
      canAccessRepScope({
        capabilities,
        actorRepId: "rep-a",
        requestedRepId: "rep-b",
      }),
    ).toBe(false);
  });

  it("allows team-level viewers across rep rows", () => {
    expect(
      canAccessRepScope({
        capabilities: resolveCommandCapabilities("ADMIN", []),
        actorRepId: null,
        requestedRepId: "rep-b",
      }),
    ).toBe(true);
  });

  it("denies another rep's pipeline even when the caller asks directly", () => {
    expect(
      canAccessPipelineRep({
        capabilities: ["view.own"],
        actorRepId: "rep-a",
        requestedRepId: "rep-b",
      }),
    ).toBe(false);
    expect(
      canAccessPipelineRep({
        capabilities: ["view.pipeline.all"],
        actorRepId: "rep-a",
        requestedRepId: "rep-b",
      }),
    ).toBe(true);
  });

  it("requires the own-financial capability and denies another rep's deals", () => {
    expect(
      canAccessDealRep({
        capabilities: ["view.own"],
        actorRepId: "rep-a",
        requestedRepId: "rep-a",
      }),
    ).toBe(false);
    expect(
      canAccessDealRep({
        capabilities: ["view.own.financials"],
        actorRepId: "rep-a",
        requestedRepId: "rep-b",
      }),
    ).toBe(false);
    expect(
      canAccessDealRep({
        capabilities: ["view.own.financials"],
        actorRepId: "rep-a",
        requestedRepId: "rep-a",
      }),
    ).toBe(true);
    expect(
      canAccessDealRep({
        capabilities: ["view.deals.all"],
        actorRepId: null,
        requestedRepId: "rep-b",
      }),
    ).toBe(true);
  });

  it("keeps General Users out of financial and coaching capabilities", () => {
    const capabilities = resolveCommandCapabilities("USER", []);
    expect(capabilities).toEqual(["view.own"]);
    expect(capabilities).not.toContain("view.own.financials");
    expect(capabilities).not.toContain("view.own.coaching");
  });
});
