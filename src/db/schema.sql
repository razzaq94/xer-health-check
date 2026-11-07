-- One row per uploaded file. Everything else hangs off an import, so two
-- monthly updates of the same project can be stored and compared side by side.
CREATE TABLE IF NOT EXISTS xer_import (
  id            BIGSERIAL PRIMARY KEY,
  file_name     TEXT        NOT NULL,
  encoding      TEXT        NOT NULL,
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS xer_issue (
  id         BIGSERIAL PRIMARY KEY,
  import_id  BIGINT NOT NULL REFERENCES xer_import(id) ON DELETE CASCADE,
  severity   TEXT   NOT NULL CHECK (severity IN ('error', 'warning')),
  code       TEXT   NOT NULL,
  message    TEXT   NOT NULL,
  table_name TEXT,
  line_no    INT
);

CREATE TABLE IF NOT EXISTS xer_project (
  import_id  BIGINT NOT NULL REFERENCES xer_import(id) ON DELETE CASCADE,
  proj_id    TEXT   NOT NULL,
  short_name TEXT   NOT NULL,
  data_date  TIMESTAMP,
  PRIMARY KEY (import_id, proj_id)
);

CREATE TABLE IF NOT EXISTS xer_calendar (
  import_id     BIGINT  NOT NULL REFERENCES xer_import(id) ON DELETE CASCADE,
  clndr_id      TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  hours_per_day NUMERIC NOT NULL,
  PRIMARY KEY (import_id, clndr_id)
);

CREATE TABLE IF NOT EXISTS xer_task (
  import_id          BIGINT  NOT NULL REFERENCES xer_import(id) ON DELETE CASCADE,
  task_id            TEXT    NOT NULL,
  proj_id            TEXT    NOT NULL,
  clndr_id           TEXT,
  task_code          TEXT    NOT NULL,
  task_name          TEXT    NOT NULL,
  task_type          TEXT    NOT NULL,
  status_code        TEXT    NOT NULL,
  orig_drtn_hrs      NUMERIC,
  remain_drtn_hrs    NUMERIC,
  total_float_hrs    NUMERIC,
  hours_per_day      NUMERIC NOT NULL,
  act_start          TIMESTAMP,
  act_finish         TIMESTAMP,
  early_start        TIMESTAMP,
  early_finish       TIMESTAMP,
  cstr_type          TEXT,
  cstr_date          TIMESTAMP,
  source_line        INT     NOT NULL,
  PRIMARY KEY (import_id, task_id),
  FOREIGN KEY (import_id, proj_id) REFERENCES xer_project(import_id, proj_id)
);

CREATE TABLE IF NOT EXISTS xer_relationship (
  import_id    BIGINT  NOT NULL REFERENCES xer_import(id) ON DELETE CASCADE,
  task_pred_id TEXT    NOT NULL,
  pred_task_id TEXT    NOT NULL,
  succ_task_id TEXT    NOT NULL,
  rel_type     TEXT    NOT NULL CHECK (rel_type IN ('PR_FS', 'PR_SS', 'PR_FF', 'PR_SF')),
  lag_hrs      NUMERIC NOT NULL,
  source_line  INT     NOT NULL,
  PRIMARY KEY (import_id, task_pred_id),
  FOREIGN KEY (import_id, pred_task_id) REFERENCES xer_task(import_id, task_id),
  FOREIGN KEY (import_id, succ_task_id) REFERENCES xer_task(import_id, task_id)
);
