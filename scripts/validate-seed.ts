import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../src/database/database.service';

async function main() {
  const dbPath =
    process.env.TRACKFORGE_DB ||
    path.join(process.cwd(), 'data', 'seed-validate.db');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  process.env.TRACKFORGE_DB = dbPath;
  process.env.TRACKFORGE_SEED = '1';
  process.env.TRACKFORGE_SEED_HOURS = process.env.TRACKFORGE_SEED_HOURS || '24';
  process.env.TRACKFORGE_LIVE_SIM = '0';

  const started = Date.now();
  const svc = new DatabaseService();
  svc.open(dbPath);
  svc.initDb();
  const conn = svc.connection;

  const telemetry = (
    conn
      .prepare(
        `SELECT COUNT(*) AS n FROM explorer_records WHERE category = 'TELEMETRY'`,
      )
      .get() as any
  ).n;
  const bursts = (
    conn
      .prepare(
        `SELECT COUNT(*) AS n FROM explorer_records
         WHERE category = 'UPLINK' AND data_type = 'SATELLITE_BURST'`,
      )
      .get() as any
  ).n;
  const alerts = (conn.prepare(`SELECT COUNT(*) AS n FROM alerts`).get() as any)
    .n;
  const active = (
    conn
      .prepare(
        `SELECT COUNT(*) AS n FROM alerts WHERE status IN ('ACTIVE','ACKNOWLEDGED')`,
      )
      .get() as any
  ).n;
  const orphans = (
    conn
      .prepare(
        `SELECT COUNT(*) AS n FROM alerts WHERE source_record_id IS NULL`,
      )
      .get() as any
  ).n;
  const soldiers = (
    conn
      .prepare(
        `SELECT COUNT(DISTINCT soldier_id) AS n FROM explorer_records
         WHERE category = 'TELEMETRY'`,
      )
      .get() as any
  ).n;
  const types = conn
    .prepare(
      `SELECT alert_type, COUNT(*) AS n FROM alerts GROUP BY alert_type ORDER BY alert_type`,
    )
    .all();
  const sosTelemetry = (
    conn
      .prepare(
        `SELECT COUNT(*) AS n FROM explorer_records
         WHERE category = 'TELEMETRY' AND soldier_id = 104
           AND data_json LIKE '%"sos":true%'`,
      )
      .get() as any
  ).n;

  console.log(
    JSON.stringify(
      {
        seed_hours: process.env.TRACKFORGE_SEED_HOURS,
        elapsed_ms: Date.now() - started,
        soldiers,
        telemetry,
        history: telemetry,
        satellite_burst_audit: bursts,
        alerts_total: alerts,
        alerts_active: active,
        orphans,
        sos_telemetry_rows: sosTelemetry,
        alert_types: types,
      },
      null,
      2,
    ),
  );
  svc.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
