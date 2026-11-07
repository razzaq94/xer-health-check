/**
 * Every problem found while reading a file is recorded, never swallowed.
 *
 * - "error": the file cannot be trusted at all, so the import stops.
 * - "warning": the row is loaded (or skipped) by an explicit rule, and the
 *   user can see exactly which table and line were affected.
 */
export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  table?: string;
  line?: number;
}

export class XerImportError extends Error {
  constructor(public readonly issues: Issue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.name = "XerImportError";
  }
}
