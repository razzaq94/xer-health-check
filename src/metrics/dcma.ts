import type { Project, Relationship, Schedule, Task } from "../xer/model.js";

/**
 * A subset of the DCMA 14-point schedule assessment, computed in plain code.
 *
 * Every check returns the activities (or relationships) that failed, not just
 * a percentage, so each number can be traced back to rows in the file.
 *
 * Population rules (stated once, used everywhere):
 * - Activities: incomplete (not TK_Complete), excluding level-of-effort and
 *   WBS summary activities.
 * - Relationships: those whose successor is in the activity population.
 * - Duration and float are converted from hours to working days using each
 *   activity's own calendar.
 */

export interface CheckResult {
  id: string;
  name: string;
  /** Pass if `count / population` compares against the threshold this way. */
  rule: string;
  count: number;
  population: number;
  percent: number;
  pass: boolean;
  /** Activity codes, or "PRED -> SUCC" for relationship checks. */
  items: string[];
}

export interface ProjectReport {
  project: Project;
  activityPopulation: number;
  relationshipPopulation: number;
  checks: CheckResult[];
}

const HIGH_DAYS = 44;
/** Constraint types that fix or cap a date (Start On, Finish On, Mandatory, and "on or before"). */
export const HARD_CONSTRAINTS = new Set(["CS_MSO", "CS_MEO", "CS_MANDSTART", "CS_MANDFIN", "CS_MSOB", "CS_MEOB"]);

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (count: number, pop: number) => (pop === 0 ? 0 : round1((count / pop) * 100));

function check(
  id: string,
  name: string,
  items: string[],
  population: number,
  threshold: { max?: number; min?: number },
): CheckResult {
  const count = items.length;
  const percent = pct(count, population);
  let pass: boolean;
  let rule: string;
  if (threshold.min !== undefined) {
    // "min" checks measure the share that is GOOD (e.g. FS relationships).
    pass = population === 0 || percent >= threshold.min;
    rule = `>= ${threshold.min}%`;
  } else {
    const max = threshold.max ?? 0;
    pass = population === 0 || (max === 0 ? count === 0 : percent <= max);
    rule = max === 0 ? "= 0" : `<= ${max}%`;
  }
  return { id, name, rule, count, population, percent, pass, items };
}

const isMilestone = (t: Task) => t.type === "TT_Mile" || t.type === "TT_FinMile";
const days = (hrs: number | null, t: Task) => (hrs === null ? null : hrs / t.hoursPerDay);

export function runChecks(schedule: Schedule): ProjectReport[] {
  return schedule.projects.map((project) => {
    const projTasks = schedule.tasks.filter((t) => t.projectId === project.id);
    const byId = new Map(projTasks.map((t) => [t.id, t]));

    const population = projTasks.filter(
      (t) => t.status !== "TK_Complete" && t.type !== "TT_LOE" && t.type !== "TT_WBS",
    );
    const inPop = new Set(population.map((t) => t.id));
    const rels = schedule.relationships.filter((r) => inPop.has(r.successorId));

    const hasPred = new Set(schedule.relationships.map((r) => r.successorId));
    const hasSucc = new Set(schedule.relationships.map((r) => r.predecessorId));
    const relLabel = (r: Relationship) => `${byId.get(r.predecessorId)?.code ?? r.predecessorId} -> ${byId.get(r.successorId)?.code ?? r.successorId}`;

    // 1. Missing logic: no predecessor (start milestones exempt) or no successor (finish milestones exempt).
    const missingLogic = population.filter(
      (t) => (!hasPred.has(t.id) && t.type !== "TT_Mile") || (!hasSucc.has(t.id) && t.type !== "TT_FinMile"),
    );

    // 2-4. Relationship quality.
    const leads = rels.filter((r) => r.lagHrs < 0);
    const lags = rels.filter((r) => r.lagHrs > 0);
    const fs = rels.filter((r) => r.type === "PR_FS");

    // 5. Hard constraints.
    const hard = population.filter((t) => t.constraintType !== null && HARD_CONSTRAINTS.has(t.constraintType));

    // 6-7. Float.
    const highFloat = population.filter((t) => (days(t.totalFloatHrs, t) ?? 0) > HIGH_DAYS);
    const negFloat = population.filter((t) => (t.totalFloatHrs ?? 0) < 0);

    // 8. High duration (milestones have no duration, so they are not in this population).
    const durPop = population.filter((t) => !isMilestone(t));
    const highDur = durPop.filter((t) => (days(t.originalDurationHrs, t) ?? 0) > HIGH_DAYS);

    // 9. Invalid dates: actuals after the data date, or remaining work forecast before it.
    const dd = project.dataDate;
    const invalidDates = dd
      ? projTasks.filter((t) => {
          if (t.type === "TT_LOE" || t.type === "TT_WBS") return false;
          const actualInFuture = (t.actualStart !== null && t.actualStart > dd) || (t.actualFinish !== null && t.actualFinish > dd);
          const forecastInPast =
            t.status !== "TK_Complete" &&
            ((t.status === "TK_NotStart" && t.earlyStart !== null && t.earlyStart < dd) ||
              (t.earlyFinish !== null && t.earlyFinish < dd));
          return actualInFuture || forecastInPast;
        })
      : [];

    const codes = (ts: Task[]) => ts.map((t) => t.code);

    const checks: CheckResult[] = [
      check("missing_logic", "Missing logic", codes(missingLogic), population.length, { max: 5 }),
      check("leads", "Leads (negative lag)", leads.map(relLabel), rels.length, { max: 0 }),
      check("lags", "Lags", lags.map(relLabel), rels.length, { max: 5 }),
      // Reports the FS relationships themselves; pass when they are >= 90% of all.
      check("fs_relationships", "Finish-to-start relationships", fs.map(relLabel), rels.length, { min: 90 }),
      check("hard_constraints", "Hard constraints", codes(hard), population.length, { max: 5 }),
      check("high_float", `High float (> ${HIGH_DAYS} working days)`, codes(highFloat), population.length, { max: 5 }),
      check("negative_float", "Negative float", codes(negFloat), population.length, { max: 0 }),
      check("high_duration", `High duration (> ${HIGH_DAYS} working days)`, codes(highDur), durPop.length, { max: 5 }),
      // Population here is every non-LOE/WBS activity, because completed work can have bad actuals too.
      check("invalid_dates", "Invalid dates vs data date", codes(invalidDates), dd ? projTasks.filter((t) => t.type !== "TT_LOE" && t.type !== "TT_WBS").length : 0, { max: 0 }),
    ];

    return {
      project,
      activityPopulation: population.length,
      relationshipPopulation: rels.length,
      checks,
    };
  });
}
