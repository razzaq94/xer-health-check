import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXer } from "../src/xer/model.js";
import { XerImportError } from "../src/xer/issues.js";

const sample = (name: string) => readFileSync(new URL(`../samples/${name}`, import.meta.url));

describe("clean file", () => {
  const s = parseXer(sample("sample-midrise.xer"));

  it("loads every row with no warnings", () => {
    expect(s.issues).toEqual([]);
    expect(s.encoding).toBe("utf-8");
    expect(s.projects).toHaveLength(1);
    expect(s.tasks).toHaveLength(14);
    expect(s.relationships).toHaveLength(13);
  });

  it("reads the data date and calendar hours", () => {
    expect(s.projects[0]!.dataDate).toBe("2026-03-02T08:00");
    const framing = s.tasks.find((t) => t.code === "A1060")!;
    expect(framing.hoursPerDay).toBe(10);
    expect(framing.totalFloatHrs).toBe(-20);
  });
});

describe("rule-breaking file", () => {
  const s = parseXer(sample("sample-broken.xer"));
  const codes = s.issues.map((i) => i.code);

  it("falls back to Windows-1252 and keeps accented text intact", () => {
    expect(s.encoding).toBe("windows-1252");
    expect(s.tasks.find((t) => t.id === "2002")!.name).toBe("Café fit-out");
  });

  it("records each broken rule as a warning with its line number", () => {
    expect(codes.sort()).toEqual(
      ["BAD_DATE", "DUPLICATE_TASK", "ENCODING_FALLBACK", "FIELD_COUNT_MISMATCH", "ORPHAN_RELATIONSHIP", "UNKNOWN_CALENDAR"].sort(),
    );
    expect(s.issues.filter((i) => i.code !== "ENCODING_FALLBACK").every((i) => typeof i.line === "number")).toBe(true);
  });

  it("applies the documented rule for each problem", () => {
    expect(s.tasks).toHaveLength(4); // duplicate dropped, first kept
    expect(s.tasks.find((t) => t.id === "2002")!.earlyStart).toBeNull(); // bad date -> empty
    expect(s.tasks.find((t) => t.id === "2003")!.hoursPerDay).toBe(8); // unknown calendar -> 8 h/day
    expect(s.tasks.find((t) => t.id === "2003")!.constraintType).toBeNull(); // short row padded
    expect(s.relationships).toHaveLength(3); // orphan skipped
  });
});

describe("files that must be rejected", () => {
  const rejects = (text: string, code: string) => {
    try {
      parseXer(text);
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(XerImportError);
      expect((e as XerImportError).issues.map((i) => i.code)).toContain(code);
    }
  };

  it("rejects a file that is not XER", () => rejects("task_id,task_code\n1,A1000\n", "NOT_XER"));

  it("rejects a file without a TASK table", () =>
    rejects("ERMHDR\t19.12\n%T\tPROJECT\n%F\tproj_id\n%R\t1\n%E\n", "MISSING_TABLE"));

  it("rejects a TASK table missing required fields", () =>
    rejects("ERMHDR\t19.12\n%T\tPROJECT\n%F\tproj_id\n%R\t1\n%T\tTASK\n%F\ttask_id\ttask_name\n%R\t1\tX\n%E\n", "MISSING_FIELDS"));
});
