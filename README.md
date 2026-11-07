# xer-health-check

Parses Primavera P6 **XER** exports, loads them into **Postgres**, and runs DCMA-style schedule checks in plain TypeScript. Every result lists the exact activities behind it, so each number can be traced back to rows in the file.

Built as a small exercise to learn the XER format. The sample files are synthetic, written by hand.

```
npm install
npm test                                        # 20 tests
npm run check -- samples/sample-midrise.xer     # clean schedule
npm run check -- samples/sample-broken.xer      # file that breaks the rules
DATABASE_URL=postgres://... npm run check -- samples/sample-midrise.xer --db
```

## How it's built

**Layer 1: reader** (`src/xer/reader.ts`). Turns XER text into raw tables without interpreting any values. XER is tab-delimited: `%T` starts a table, `%F` lists its fields, `%R` is a row, `%E` ends the file. Tries strict UTF-8 first and falls back to Windows-1252, which many P6 exports use.

**Layer 2: typed model** (`src/xer/model.ts`). Validates and converts the raw tables. Every rule is explicit: it either rejects the file or loads the data with a warning that names the table and line.

| Problem | Rule |
|---|---|
| Not an XER file, or `PROJECT` / `TASK` table missing | **Reject** the file |
| `TASK` table missing required fields | **Reject** the file |
| Row has too few or too many values | Load; missing values empty, extras dropped; warn |
| Invalid date (e.g. month 13) | Treat as empty; warn |
| Activity on an unknown calendar | Assume 8 h/day; warn |
| Duplicate `task_id` | Keep the first row; warn |
| Relationship pointing to a missing activity | Skip it; warn |
| Not valid UTF-8 | Decode as Windows-1252; warn |

Dates stay as `YYYY-MM-DDTHH:MM` in the schedule's own local time, so no timezone conversion can shift a date.

**Checks** (`src/metrics/dcma.ts`). Nine of the DCMA 14 points:

| Check | Target |
|---|---|
| Missing logic | <= 5% |
| Leads (negative lag) | 0 |
| Lags | <= 5% |
| Finish-to-start relationships | >= 90% |
| Hard constraints | <= 5% |
| High float (> 44 working days) | <= 5% |
| Negative float | 0 |
| High duration (> 44 working days) | <= 5% |
| Invalid dates vs data date | 0 |

Population rules: incomplete activities, excluding level-of-effort and WBS summary. Relationship checks use relationships whose successor is in that population. Hours are converted to working days with each activity's own calendar. Start milestones are exempt from "no predecessor" and finish milestones from "no successor".

Hard constraints are taken as `CS_MSO`, `CS_MEO`, `CS_MANDSTART`, `CS_MANDFIN`, `CS_MSOB`, `CS_MEOB` (Start On, Finish On, Mandatory, and "on or before"). This mapping, and the other definitions above, should be confirmed against the formula table a project controls team actually uses.

**Postgres** (`src/db/`). One `xer_import` row per file, with tasks, relationships, calendars and every import warning attached to it, so successive monthly updates can be compared. The whole file loads in one transaction or not at all.

## Hand check

Before running the code, the expected results for `sample-midrise.xer` were counted by hand. The tests assert these exact values.

Data date 2026-03-02 08:00. 14 activities: 2 complete and 1 LOE excluded, leaving **11**. 13 relationships: 1 points into a completed activity, leaving **12**.

| Check | Activities | Result |
|---|---|---|
| Missing logic | A1090 (no successor), A1100 (no predecessor) | 2 / 11 = 18.2% |
| Leads | A1050 -> A1060 (-16 h) | 1 / 12 |
| Lags | A1020 -> A1040 (SS +40 h) | 1 / 12 = 8.3% |
| Finish-to-start | 10 FS, 2 SS | 10 / 12 = 83.3% |
| Hard constraints | A1050 (Start On), A1130 (Finish On or Before). A1080 is Start On or After, so soft | 2 / 11 = 18.2% |
| High float | A1040 (400 h / 8 = 50 d), A1100 (600 h / 8 = 75 d) | 2 / 11 = 18.2% |
| Negative float | A1060 (-20 h) | 1 / 11 |
| High duration | A1050 (400 h / 8 = 50 d), A1100 (480 h / 8 = 60 d). A1060 is 300 h on a 10 h/day calendar = 30 d | 2 / 10 = 20.0% (milestones excluded) |
| Invalid dates | A1110 forecast to start 2026-02-20, before the data date | 1 / 13 |

`sample-broken.xer` is Windows-1252 and contains one example of each warning in the rules table. It still loads, and the output lists every problem with its line number.

## Not covered yet

- P6 XML exports and MS Project files
- The remaining DCMA points (resources, missed tasks, critical path test, CPLI, BEI), which need baseline data
- Comparing two updates of the same project
