import { readXer, type RawTable } from "./reader.js";
import { XerImportError, type Issue } from "./issues.js";

/**
 * Layer 2: typed, validated model.
 *
 * Every rule here is explicit: it either rejects the file (error) or loads the
 * data with a recorded warning. Dates are kept as "YYYY-MM-DDTHH:MM" strings in
 * the schedule's own local time, so no timezone conversion can shift them.
 */

export type TaskType = "TT_Task" | "TT_Rsrc" | "TT_Mile" | "TT_FinMile" | "TT_LOE" | "TT_WBS" | string;
export type TaskStatus = "TK_NotStart" | "TK_Active" | "TK_Complete" | string;
export type RelType = "PR_FS" | "PR_SS" | "PR_FF" | "PR_SF";

export interface Calendar {
  id: string;
  name: string;
  hoursPerDay: number;
}

export interface Project {
  id: string;
  shortName: string;
  dataDate: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  calendarId: string;
  code: string;
  name: string;
  type: TaskType;
  status: TaskStatus;
  originalDurationHrs: number | null;
  remainingDurationHrs: number | null;
  totalFloatHrs: number | null;
  actualStart: string | null;
  actualFinish: string | null;
  earlyStart: string | null;
  earlyFinish: string | null;
  constraintType: string | null;
  constraintDate: string | null;
  /** Hours per working day from the task's calendar (8 if the calendar is unknown). */
  hoursPerDay: number;
  line: number;
}

export interface Relationship {
  id: string;
  predecessorId: string;
  successorId: string;
  type: RelType;
  lagHrs: number;
  line: number;
}

export interface Schedule {
  encoding: "utf-8" | "windows-1252";
  projects: Project[];
  calendars: Calendar[];
  tasks: Task[];
  relationships: Relationship[];
  issues: Issue[];
}

const REQUIRED_TASK_FIELDS = ["task_id", "proj_id", "task_code", "task_type", "status_code"];
const REL_TYPES = new Set<RelType>(["PR_FS", "PR_SS", "PR_FF", "PR_SF"]);
const DEFAULT_HOURS_PER_DAY = 8;

export function parseXer(input: Buffer | string): Schedule {
  const raw = readXer(input);
  const issues: Issue[] = [...raw.issues];

  const fail = () => {
    throw new XerImportError(issues.filter((i) => i.severity === "error"));
  };
  if (issues.some((i) => i.severity === "error")) fail();

  // --- Hard requirements: without these, nothing downstream is meaningful.
  for (const name of ["PROJECT", "TASK"]) {
    if (!raw.tables.has(name)) {
      issues.push({ severity: "error", code: "MISSING_TABLE", message: `Required table ${name} is missing.`, table: name });
    }
  }
  const taskTable = raw.tables.get("TASK");
  if (taskTable) {
    const missing = REQUIRED_TASK_FIELDS.filter((f) => !taskTable.fields.includes(f));
    if (missing.length) {
      issues.push({
        severity: "error",
        code: "MISSING_FIELDS",
        message: `TASK table is missing required fields: ${missing.join(", ")}.`,
        table: "TASK",
      });
    }
  }
  if (issues.some((i) => i.severity === "error")) fail();

  // --- Helpers that record a warning instead of guessing silently.
  const num = (t: RawTable, line: number, field: string, v: string | undefined): number | null => {
    if (v === undefined || v.trim() === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      issues.push({ severity: "warning", code: "BAD_NUMBER", message: `${t.name}.${field} "${v}" is not a number; treated as empty.`, table: t.name, line });
      return null;
    }
    return n;
  };
  const date = (t: RawTable, line: number, field: string, v: string | undefined): string | null => {
    if (v === undefined || v.trim() === "") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(v.trim());
    const ok =
      m &&
      (() => {
        const [y, mo, d, h = "00", mi = "00"] = m.slice(1);
        const dt = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi));
        return dt.getUTCFullYear() === +y! && dt.getUTCMonth() === +mo! - 1 && dt.getUTCDate() === +d! && +h < 24 && +mi < 60;
      })();
    if (!ok) {
      issues.push({ severity: "warning", code: "BAD_DATE", message: `${t.name}.${field} "${v}" is not a valid date; treated as empty.`, table: t.name, line });
      return null;
    }
    return `${m![1]}-${m![2]}-${m![3]}T${m![4] ?? "00"}:${m![5] ?? "00"}`;
  };

  // --- Calendars
  const calendars: Calendar[] = [];
  const calTable = raw.tables.get("CALENDAR");
  for (const r of calTable?.rows ?? []) {
    const hrs = num(calTable!, r.line, "day_hr_cnt", r.values.day_hr_cnt);
    calendars.push({
      id: r.values.clndr_id ?? "",
      name: r.values.clndr_name ?? "",
      hoursPerDay: hrs && hrs > 0 ? hrs : DEFAULT_HOURS_PER_DAY,
    });
  }
  const calHours = new Map(calendars.map((c) => [c.id, c.hoursPerDay]));

  // --- Projects
  const projTable = raw.tables.get("PROJECT")!;
  const projects: Project[] = projTable.rows.map((r) => ({
    id: r.values.proj_id ?? "",
    shortName: r.values.proj_short_name ?? "",
    dataDate: date(projTable, r.line, "last_recalc_date", r.values.last_recalc_date),
  }));
  for (const p of projects) {
    if (!p.dataDate) {
      issues.push({ severity: "warning", code: "NO_DATA_DATE", message: `Project ${p.shortName || p.id} has no data date; date checks are skipped for it.`, table: "PROJECT" });
    }
  }
  if (projects.length > 1) {
    issues.push({ severity: "warning", code: "MULTIPLE_PROJECTS", message: `File contains ${projects.length} projects; checks are reported per project.`, table: "PROJECT" });
  }
  const projectIds = new Set(projects.map((p) => p.id));

  // --- Tasks
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const r of taskTable!.rows) {
    const v = r.values;
    const id = v.task_id ?? "";
    if (!id) {
      issues.push({ severity: "warning", code: "NO_TASK_ID", message: "TASK row has no task_id; skipped.", table: "TASK", line: r.line });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ severity: "warning", code: "DUPLICATE_TASK", message: `task_id ${id} appears more than once; first row kept.`, table: "TASK", line: r.line });
      continue;
    }
    seen.add(id);
    if (!projectIds.has(v.proj_id ?? "")) {
      issues.push({ severity: "warning", code: "UNKNOWN_PROJECT", message: `Task ${v.task_code} references unknown project ${v.proj_id}; skipped.`, table: "TASK", line: r.line });
      continue;
    }
    const clndr = v.clndr_id ?? "";
    let hoursPerDay = calHours.get(clndr);
    if (hoursPerDay === undefined) {
      issues.push({
        severity: "warning",
        code: "UNKNOWN_CALENDAR",
        message: `Task ${v.task_code} uses unknown calendar ${clndr || "(blank)"}; ${DEFAULT_HOURS_PER_DAY} h/day assumed.`,
        table: "TASK",
        line: r.line,
      });
      hoursPerDay = DEFAULT_HOURS_PER_DAY;
    }
    tasks.push({
      id,
      projectId: v.proj_id ?? "",
      calendarId: clndr,
      code: v.task_code ?? "",
      name: v.task_name ?? "",
      type: v.task_type ?? "",
      status: v.status_code ?? "",
      originalDurationHrs: num(taskTable!, r.line, "target_drtn_hr_cnt", v.target_drtn_hr_cnt),
      remainingDurationHrs: num(taskTable!, r.line, "remain_drtn_hr_cnt", v.remain_drtn_hr_cnt),
      totalFloatHrs: num(taskTable!, r.line, "total_float_hr_cnt", v.total_float_hr_cnt),
      actualStart: date(taskTable!, r.line, "act_start_date", v.act_start_date),
      actualFinish: date(taskTable!, r.line, "act_end_date", v.act_end_date),
      earlyStart: date(taskTable!, r.line, "early_start_date", v.early_start_date),
      earlyFinish: date(taskTable!, r.line, "early_end_date", v.early_end_date),
      constraintType: v.cstr_type?.trim() || null,
      constraintDate: date(taskTable!, r.line, "cstr_date", v.cstr_date),
      hoursPerDay,
      line: r.line,
    });
  }
  const taskIds = new Set(tasks.map((t) => t.id));

  // --- Relationships
  const relationships: Relationship[] = [];
  const predTable = raw.tables.get("TASKPRED");
  if (!predTable) {
    issues.push({ severity: "warning", code: "NO_RELATIONSHIPS", message: "TASKPRED table is missing; every activity will show as missing logic.", table: "TASKPRED" });
  }
  for (const r of predTable?.rows ?? []) {
    const v = r.values;
    const pred = v.pred_task_id ?? "";
    const succ = v.task_id ?? "";
    if (!taskIds.has(pred) || !taskIds.has(succ)) {
      issues.push({
        severity: "warning",
        code: "ORPHAN_RELATIONSHIP",
        message: `Relationship ${v.task_pred_id} links ${pred} -> ${succ}, but ${!taskIds.has(pred) ? pred : succ} is not a loaded activity; skipped.`,
        table: "TASKPRED",
        line: r.line,
      });
      continue;
    }
    const type = (v.pred_type ?? "") as RelType;
    if (!REL_TYPES.has(type)) {
      issues.push({ severity: "warning", code: "BAD_REL_TYPE", message: `Relationship ${v.task_pred_id} has unknown type "${v.pred_type}"; skipped.`, table: "TASKPRED", line: r.line });
      continue;
    }
    relationships.push({
      id: v.task_pred_id ?? "",
      predecessorId: pred,
      successorId: succ,
      type,
      lagHrs: num(predTable!, r.line, "lag_hr_cnt", v.lag_hr_cnt) ?? 0,
      line: r.line,
    });
  }

  return { encoding: raw.encoding, projects, calendars, tasks, relationships, issues };
}
