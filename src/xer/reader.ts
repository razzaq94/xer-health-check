import type { Issue } from "./issues.js";

/**
 * Layer 1: a "dumb" reader.
 *
 * Turns XER text into raw string tables with no interpretation of the values.
 * XER is tab-delimited text:
 *   ERMHDR  ...         header line (first line of every export)
 *   %T  TABLE_NAME      starts a table
 *   %F  field  field    column names for that table
 *   %R  value  value    one row
 *   %E                  end of file
 */

export interface RawTable {
  name: string;
  fields: string[];
  /** Each row keyed by field name; `line` is the 1-based line in the file. */
  rows: { line: number; values: Record<string, string> }[];
}

export interface RawXer {
  header: string[];
  encoding: "utf-8" | "windows-1252";
  tables: Map<string, RawTable>;
  issues: Issue[];
}

/** P6 exports are frequently Windows-1252, not UTF-8. Try strict UTF-8 first. */
export function decode(buf: Buffer): { text: string; encoding: RawXer["encoding"] } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: text.replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buf), encoding: "windows-1252" };
  }
}

export function readXer(input: Buffer | string): RawXer {
  const { text, encoding } =
    typeof input === "string" ? { text: input, encoding: "utf-8" as const } : decode(input);

  const issues: Issue[] = [];
  const tables = new Map<string, RawTable>();
  const lines = text.split(/\r?\n/);

  if (encoding === "windows-1252") {
    issues.push({
      severity: "warning",
      code: "ENCODING_FALLBACK",
      message: "File is not valid UTF-8; decoded as Windows-1252.",
    });
  }

  const first = lines[0] ?? "";
  if (!first.startsWith("ERMHDR")) {
    issues.push({
      severity: "error",
      code: "NOT_XER",
      message: "First line is not an ERMHDR header, so this is not a P6 XER export.",
      line: 1,
    });
    return { header: [], encoding, tables, issues };
  }
  const header = first.split("\t").slice(1);

  let current: RawTable | null = null;
  let sawEnd = false;

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;

    const parts = raw.split("\t");
    const marker = parts[0];

    if (marker === "%T") {
      const name = (parts[1] ?? "").trim();
      if (tables.has(name)) {
        issues.push({
          severity: "warning",
          code: "DUPLICATE_TABLE",
          message: `Table ${name} appears more than once; rows are appended to the first.`,
          table: name,
          line: lineNo,
        });
        current = tables.get(name)!;
      } else {
        current = { name, fields: [], rows: [] };
        tables.set(name, current);
      }
    } else if (marker === "%F") {
      if (!current) {
        issues.push({ severity: "warning", code: "ORPHAN_FIELDS", message: "%F line before any %T; ignored.", line: lineNo });
        continue;
      }
      current.fields = parts.slice(1).map((f) => f.trim());
    } else if (marker === "%R") {
      if (!current || current.fields.length === 0) {
        issues.push({ severity: "warning", code: "ORPHAN_ROW", message: "%R line with no table/fields; ignored.", line: lineNo });
        continue;
      }
      const values = parts.slice(1);
      if (values.length !== current.fields.length) {
        issues.push({
          severity: "warning",
          code: "FIELD_COUNT_MISMATCH",
          message: `${current.name} row has ${values.length} values but ${current.fields.length} fields; ${
            values.length < current.fields.length ? "missing values treated as empty" : "extra values dropped"
          }.`,
          table: current.name,
          line: lineNo,
        });
      }
      const rec: Record<string, string> = {};
      current.fields.forEach((f, idx) => {
        rec[f] = values[idx] ?? "";
      });
      current.rows.push({ line: lineNo, values: rec });
    } else if (marker === "%E") {
      sawEnd = true;
      break;
    } else {
      issues.push({
        severity: "warning",
        code: "UNKNOWN_LINE",
        message: `Unrecognised line marker "${(marker ?? "").slice(0, 10)}"; ignored.`,
        line: lineNo,
      });
    }
  }

  if (!sawEnd) {
    issues.push({
      severity: "warning",
      code: "NO_END_MARKER",
      message: "No %E end marker; the file may be truncated.",
    });
  }

  return { header, encoding, tables, issues };
}
