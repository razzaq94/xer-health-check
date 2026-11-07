import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseXer } from "./xer/model.js";
import { XerImportError } from "./xer/issues.js";
import { runChecks } from "./metrics/dcma.js";
import { loadSchedule } from "./db/load.js";

const USAGE = `Usage: npm run check -- <file.xer> [--json] [--db]

  --json   print the full result as JSON
  --db     also load the file into Postgres (uses DATABASE_URL)`;

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }

  let schedule;
  try {
    schedule = parseXer(await readFile(file));
  } catch (e) {
    if (e instanceof XerImportError) {
      console.error(`Rejected ${basename(file)}:`);
      for (const i of e.issues) console.error(`  ERROR ${i.code}: ${i.message}`);
      process.exit(1);
    }
    throw e;
  }

  const reports = runChecks(schedule);

  if (args.includes("--db")) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("--db needs DATABASE_URL, e.g. postgres://user:pass@localhost:5432/xer");
      process.exit(2);
    }
    const id = await loadSchedule(url, basename(file), schedule);
    console.error(`Loaded into Postgres as import #${id}.`);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ issues: schedule.issues, reports }, null, 2));
    return;
  }

  console.log(`\n${basename(file)}  (${schedule.encoding}, ${schedule.tasks.length} activities, ${schedule.relationships.length} relationships)`);

  if (schedule.issues.length) {
    console.log(`\nImport warnings (${schedule.issues.length}):`);
    for (const i of schedule.issues) {
      console.log(`  ${i.code}${i.line ? ` [line ${i.line}]` : ""}: ${i.message}`);
    }
  }

  for (const r of reports) {
    console.log(`\nProject ${r.project.shortName}  data date ${r.project.dataDate?.replace("T", " ") ?? "n/a"}`);
    console.log(`Population: ${r.activityPopulation} incomplete activities, ${r.relationshipPopulation} relationships\n`);
    const rows = r.checks.map((c) => ({
      check: c.name,
      result: `${c.count} / ${c.population}`,
      "%": c.percent.toFixed(1),
      target: c.rule,
      status: c.pass ? "PASS" : "FAIL",
    }));
    console.table(rows);
    for (const c of r.checks) {
      if (!c.pass && c.id !== "fs_relationships") console.log(`  ${c.name}: ${c.items.join(", ")}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
