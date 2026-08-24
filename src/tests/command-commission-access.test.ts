import { describe, expect, test } from "bun:test";
import { resolveCommissionRepScope } from "../controllers/command-commissions.controller";

describe("Command commission row scope", () => {
  test("plain view.own cannot retrieve commission data", () => {
    expect(resolveCommissionRepScope({
      requestedRepId: null,
      capabilities: ["view.own"],
      actorRepId: "rep-1",
    })).toEqual({ allowed: false });
  });

  test("plain view.own cannot retrieve commission data by naming its own rep", () => {
    expect(resolveCommissionRepScope({
      requestedRepId: "rep-1",
      capabilities: ["view.own"],
      actorRepId: "rep-1",
    })).toEqual({ allowed: false });
  });

  test("an own-financial rep cannot request another rep's commission", () => {
    expect(resolveCommissionRepScope({
      requestedRepId: "rep-2",
      capabilities: ["view.own.financials"],
      actorRepId: "rep-1",
    })).toEqual({ allowed: false });
  });

  test("an own-financial rep is forced to their own row", () => {
    expect(resolveCommissionRepScope({
      requestedRepId: null,
      capabilities: ["view.own.financials"],
      actorRepId: "rep-1",
    })).toEqual({ allowed: true, repId: "rep-1" });
  });

  test("team viewers may select a specific rep or the company ledger", () => {
    expect(resolveCommissionRepScope({
      requestedRepId: "rep-2",
      capabilities: ["view.team.all"],
      actorRepId: "rep-1",
    })).toEqual({ allowed: true, repId: "rep-2" });
    expect(resolveCommissionRepScope({
      requestedRepId: null,
      capabilities: ["view.team.all"],
      actorRepId: "rep-1",
    })).toEqual({ allowed: true, repId: null });
  });
});
