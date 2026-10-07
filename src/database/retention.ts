import type { Database } from 'better-sqlite3';
import { bind } from '../common/sql';
import { utcNow } from '../common/records';

export const RETENTION_DAYS = 30;
const META_KEY = 'retention_last_run_at';

function ensureMeta(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function lastRun(db: Database): string | null {
  ensureMeta(db);
  const row = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(META_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function markRun(db: Database, when: string) {
  ensureMeta(db);
  db.prepare(
    `
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(...bind([META_KEY, when]));
}

function cutoffIso(days = RETENTION_DAYS): string {
  const ms = Date.now() - days * 24 * 3600 * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export type RetentionResult = {
  ran: boolean;
  cutoff: string | null;
  deletedTelemetry: number;
  deletedBursts: number;
  deletedAlerts: number;
};

/**
 * Rolling 30-day retention for telemetry business data + burst audit + alerts.
 * Does NOT touch users/roles/permissions/personnel/groups/operations.
 *
 * Runs at most once per 24 hours (or when never run).
 */
export function runRetentionIfDue(
  db: Database,
  force = false,
): RetentionResult {
  ensureMeta(db);
  const now = utcNow();
  const previous = lastRun(db);
  if (!force && previous) {
    const prevMs = Date.parse(previous);
    if (Number.isFinite(prevMs) && Date.now() - prevMs < 24 * 3600 * 1000) {
      return {
        ran: false,
        cutoff: null,
        deletedTelemetry: 0,
        deletedBursts: 0,
        deletedAlerts: 0,
      };
    }
  }

  const cutoff = cutoffIso();
  const delTelemetry = db
    .prepare(
      `DELETE FROM explorer_records
       WHERE category = 'TELEMETRY' AND event_time < ?`,
    )
    .run(...bind([cutoff]));
  const delBursts = db
    .prepare(
      `DELETE FROM explorer_records
       WHERE category = 'UPLINK' AND data_type = 'SATELLITE_BURST' AND event_time < ?`,
    )
    .run(...bind([cutoff]));
  const delAlerts = db
    .prepare(`DELETE FROM alerts WHERE event_time < ?`)
    .run(...bind([cutoff]));

  markRun(db, now);
  return {
    ran: true,
    cutoff,
    deletedTelemetry: delTelemetry.changes,
    deletedBursts: delBursts.changes,
    deletedAlerts: delAlerts.changes,
  };
}
