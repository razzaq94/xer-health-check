import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Schedule } from "../xer/model.js";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * Loads a parsed schedule into Postgres in a single transaction:
 * either the whole file lands, or nothing does.
 */
export async function loadSchedule(databaseUrl: string, fileName: string, s: Schedule): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(schemaPath, "utf8"));

    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO xer_import (file_name, encoding) VALUES ($1, $2) RETURNING id",
      [fileName, s.encoding],
    );
    const importId = Number(rows[0]!.id);

    for (const i of s.issues) {
      await client.query(
        "INSERT INTO xer_issue (import_id, severity, code, message, table_name, line_no) VALUES ($1,$2,$3,$4,$5,$6)",
        [importId, i.severity, i.code, i.message, i.table ?? null, i.line ?? null],
      );
    }
    for (const p of s.projects) {
      await client.query("INSERT INTO xer_project (import_id, proj_id, short_name, data_date) VALUES ($1,$2,$3,$4)", [
        importId, p.id, p.shortName, p.dataDate,
      ]);
    }
    for (const c of s.calendars) {
      await client.query("INSERT INTO xer_calendar (import_id, clndr_id, name, hours_per_day) VALUES ($1,$2,$3,$4)", [
        importId, c.id, c.name, c.hoursPerDay,
      ]);
    }
    for (const t of s.tasks) {
      await client.query(
        `INSERT INTO xer_task (import_id, task_id, proj_id, clndr_id, task_code, task_name, task_type, status_code,
           orig_drtn_hrs, remain_drtn_hrs, total_float_hrs, hours_per_day, act_start, act_finish, early_start,
           early_finish, cstr_type, cstr_date, source_line)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          importId, t.id, t.projectId, t.calendarId || null, t.code, t.name, t.type, t.status,
          t.originalDurationHrs, t.remainingDurationHrs, t.totalFloatHrs, t.hoursPerDay, t.actualStart, t.actualFinish,
          t.earlyStart, t.earlyFinish, t.constraintType, t.constraintDate, t.line,
        ],
      );
    }
    for (const r of s.relationships) {
      await client.query(
        `INSERT INTO xer_relationship (import_id, task_pred_id, pred_task_id, succ_task_id, rel_type, lag_hrs, source_line)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [importId, r.id, r.predecessorId, r.successorId, r.type, r.lagHrs, r.line],
      );
    }

    await client.query("COMMIT");
    return importId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}
