import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXer } from "../src/xer/model.js";
import { runChecks } from "../src/metrics/dcma.js";

/**
 * Expected values below were counted by hand from samples/sample-midrise.xer
 * (see the "Hand check" table in the README) before the code was run.
 */
const report = runChecks(parseXer(readFileSync(new URL("../samples/sample-midrise.xer", import.meta.url))))[0]!;
const get = (id: string) => report.checks.find((c) => c.id === id)!;

describe("DCMA checks on the sample schedule", () => {
  it("uses the documented populations", () => {
    expect(report.activityPopulation).toBe(11); // 14 minus 2 complete minus 1 LOE
    expect(report.relationshipPopulation).toBe(12); // 13 minus 1 into a completed activity
  });

  it.each([
    ["missing_logic", ["A1090", "A1100"], 11, 18.2],
    ["leads", ["A1050 -> A1060"], 12, 8.3],
    ["lags", ["A1020 -> A1040"], 12, 8.3],
    ["hard_constraints", ["A1050", "A1130"], 11, 18.2],
    ["high_float", ["A1040", "A1100"], 11, 18.2],
    ["negative_float", ["A1060"], 11, 9.1],
    ["high_duration", ["A1050", "A1100"], 10, 20.0],
    ["invalid_dates", ["A1110"], 13, 7.7],
  ])("%s", (id, items, population, percent) => {
    const c = get(id);
    expect(c.items).toEqual(items);
    expect(c.population).toBe(population);
    expect(c.percent).toBe(percent);
    expect(c.pass).toBe(false);
  });

  it("counts finish-to-start share", () => {
    const c = get("fs_relationships");
    expect(c.count).toBe(10);
    expect(c.percent).toBe(83.3);
    expect(c.pass).toBe(false);
  });

  it("does not treat a soft constraint (start on or after) as hard", () => {
    expect(get("hard_constraints").items).not.toContain("A1080");
  });

  it("converts hours to days using the activity's own calendar", () => {
    // 400 h is 40 days on a 10 h/day calendar (OK) but would be 50 days at 8 h/day (high).
    const xer = [
      "ERMHDR\t19.12",
      "%T\tPROJECT", "%F\tproj_id\tproj_short_name\tlast_recalc_date", "%R\t1\tP\t2026-03-02 08:00",
      "%T\tCALENDAR", "%F\tclndr_id\tclndr_name\tday_hr_cnt", "%R\t1\t8h\t8", "%R\t2\t10h\t10",
      "%T\tTASK",
      "%F\ttask_id\tproj_id\tclndr_id\ttask_code\ttask_type\tstatus_code\ttarget_drtn_hr_cnt",
      "%R\t1\t1\t1\tON_8H\tTT_Task\tTK_NotStart\t400",
      "%R\t2\t1\t2\tON_10H\tTT_Task\tTK_NotStart\t400",
      "%E",
    ].join("\n");
    const c = runChecks(parseXer(xer))[0]!.checks.find((x) => x.id === "high_duration")!;
    expect(c.items).toEqual(["ON_8H"]);
  });
});
