import type { Database } from 'better-sqlite3';
import { bind } from '../common/sql';
import { canonicalTime, parseEventTime, utcNow } from '../common/records';

// Port of app/alert_rules.py

export const OPEN_STATUSES = ['ACTIVE', 'ACKNOWLEDGED'] as const;
export const NO_CONTACT_GAP_SECONDS = 30 * 60;

const MESSAGES: Record<string, string> = {
  SOS: 'SOS button pressed',
  CASUALTY: 'Casualty detected',
  ARRHYTHMIA: 'Arrhythmia detected',
  LOW_BATTERY: 'Battery low',
  HEAT_STRESS: 'Heat stress detected',
  STRAP_DISCONNECTED: 'Chest strap disconnected',
  NO_CONTACT: 'No telemetry for more than 30 minutes',
};

const SEVERITY: Record<string, string> = {
  SOS: 'CRITICAL',
  CASUALTY: 'CRITICAL',
  ARRHYTHMIA: 'CRITICAL',
  LOW_BATTERY: 'WARNING',
  HEAT_STRESS: 'WARNING',
  STRAP_DISCONNECTED: 'INFO',
  NO_CONTACT: 'INFO',
};

const FLAG_RULES: readonly [string, string, string][] = [
  ['SOS', 'sos', 'FLAGS'],
  ['CASUALTY', 'casualty', 'FLAGS'],
  ['ARRHYTHMIA', 'arrhythmia', 'FLAGS'],
  ['LOW_BATTERY', 'low_battery', 'FLAGS'],
  ['HEAT_STRESS', 'heat_stress', 'FLAGS'],
];

const COLUMNS = [
  'alert_code',
  'alert_type',
  'severity',
  'status',
  'entity_type',
  'entity_id',
  'soldier_id',
  'group_id',
  'gateway_id',
  'source_record_id',
  'event_time',
  'first_seen_at',
  'last_seen_at',
  'position_source',
  'latitude',
  'longitude',
  'message',
  'acknowledged_at',
  'acknowledged_by',
  'resolved_at',
  'resolved_by',
  'derived_from',
  'record_origin',
  'created_at',
  'updated_at',
  'details_json',
] as const;

function code(alertType: string, soldierId: number, eventTime: string): string {
  const stamp = eventTime.replace(/-/g, '').replace(/:/g, '');
  return `${alertType}-${soldierId}-${stamp}`;
}

function details(payload: Record<string, any>): Record<string, unknown> {
  const flags = payload.flags;
  return {
    seq: payload.seq ?? null,
    hr: payload.hr ?? null,
    hrv: payload.hrv ?? null,
    spo2: payload.spo2 ?? null,
    temp: payload.temp ?? null,
    batt: payload.batt ?? null,
    flags: flags && typeof flags === 'object' ? flags : {},
  };
}

function insertAlert(db: Database, row: Record<string, any>): number {
  const columns = COLUMNS.join(', ');
  const marks = COLUMNS.map(() => '?').join(', ');
  const info = db
    .prepare(`INSERT INTO alerts (${columns}) VALUES (${marks})`)
    .run(...bind(COLUMNS.map((column) => row[column])));
  return Number(info.lastInsertRowid);
}

function openAlert(db: Database, soldierId: number, alertType: string): any {
  return db
    .prepare(
      `
      SELECT * FROM alerts
      WHERE soldier_id = ? AND alert_type = ? AND status IN ('ACTIVE', 'ACKNOWLEDGED')
      ORDER BY id DESC
      LIMIT 1
      `,
    )
    .get(soldierId, alertType);
}

interface ApplyConditionArgs {
  soldierId: number;
  alertType: string;
  active: boolean;
  derivedFrom: string;
  sourceRecordId: number | null;
  groupId: string | null;
  gatewayId: string | null;
  eventTime: string;
  positionSource: string | null;
  latitude: number | null;
  longitude: number | null;
  recordOrigin: string | null;
  details: Record<string, unknown>;
}

function applyCondition(db: Database, args: ApplyConditionArgs): void {
  const current = openAlert(db, args.soldierId, args.alertType);
  const now = utcNow();
  if (!args.active) {
    if (current != null) {
      db.prepare(
        `
        UPDATE alerts
        SET status = 'CLEARED', updated_at = ?
        WHERE id = ?
        `,
      ).run(...bind([now, current.id]));
    }
    return;
  }
  if (current != null) {
    db.prepare(
      `
      UPDATE alerts
      SET last_seen_at = ?, source_record_id = ?, gateway_id = ?,
          position_source = ?, latitude = ?, longitude = ?,
          details_json = ?, updated_at = ?
      WHERE id = ?
      `,
    ).run(
      ...bind([
        args.eventTime,
        args.sourceRecordId,
        args.gatewayId,
        args.positionSource,
        args.latitude,
        args.longitude,
        JSON.stringify(args.details),
        now,
        current.id,
      ]),
    );
    return;
  }
  insertAlert(db, {
    alert_code: code(args.alertType, args.soldierId, args.eventTime),
    alert_type: args.alertType,
    severity: SEVERITY[args.alertType],
    status: 'ACTIVE',
    entity_type: 'SOLDIER',
    entity_id: String(args.soldierId),
    soldier_id: args.soldierId,
    group_id: args.groupId,
    gateway_id: args.gatewayId,
    source_record_id: args.sourceRecordId,
    event_time: args.eventTime,
    first_seen_at: args.eventTime,
    last_seen_at: args.eventTime,
    position_source: args.positionSource,
    latitude: args.latitude,
    longitude: args.longitude,
    message: MESSAGES[args.alertType],
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    derived_from: args.derivedFrom,
    record_origin: args.recordOrigin,
    created_at: now,
    updated_at: now,
    details_json: JSON.stringify(args.details),
  });
}

export interface RaiseAlertsArgs {
  sourceRecordId: number;
  soldierId: number | null;
  groupId: string | null;
  gatewayId: string | null;
  eventTime: string;
  positionSource: string | null;
  recordOrigin: string | null;
  payload: Record<string, any>;
  /** Default true. Seed/live batching sets false and calls syncNoContact once per tick. */
  syncNoContactScan?: boolean;
}

export function raiseAlerts(db: Database, args: RaiseAlertsArgs): void {
  if (args.soldierId == null) return;
  const flags = args.payload.flags;
  if (flags != null && typeof flags === 'object') {
    const detail = details(args.payload);
    const latitude = args.payload.lat ?? null;
    const longitude = args.payload.lon ?? null;
    for (const [alertType, flagName, derivedFrom] of FLAG_RULES) {
      applyCondition(db, {
        soldierId: args.soldierId,
        alertType,
        active: Boolean((flags as any)[flagName]),
        derivedFrom,
        sourceRecordId: args.sourceRecordId,
        groupId: args.groupId,
        gatewayId: args.gatewayId,
        eventTime: args.eventTime,
        positionSource: args.positionSource,
        latitude,
        longitude,
        recordOrigin: args.recordOrigin,
        details: detail,
      });
    }
    applyCondition(db, {
      soldierId: args.soldierId,
      alertType: 'STRAP_DISCONNECTED',
      active: (flags as any).strap_connected === false,
      derivedFrom: 'CHEST_STRAP',
      sourceRecordId: args.sourceRecordId,
      groupId: args.groupId,
      gatewayId: args.gatewayId,
      eventTime: args.eventTime,
      positionSource: args.positionSource,
      latitude,
      longitude,
      recordOrigin: args.recordOrigin,
      details: detail,
    });
  }
  resolveNoContact(db, args.soldierId, args.eventTime);
  if (args.syncNoContactScan !== false) {
    syncNoContact(db, args.eventTime);
  }
}

/**
 * Telemetry returned → NO_CONTACT incident CLEARED (engine), not operator RESOLVED.
 * Deduped via openAlert: scheduler will not create a second ACTIVE while one is open.
 */
export function resolveNoContact(
  db: Database,
  soldierId: number,
  eventTime: string,
): void {
  const now = utcNow();
  db.prepare(
    `
    UPDATE alerts
    SET status = 'CLEARED', last_seen_at = ?, updated_at = ?
    WHERE soldier_id = ? AND alert_type = 'NO_CONTACT'
      AND status IN ('ACTIVE', 'ACKNOWLEDGED')
      AND event_time <= ?
    `,
  ).run(...bind([eventTime, now, soldierId, eventTime]));
}

export function syncNoContact(db: Database, asOf: string | null = null): void {
  let clock = (
    db
      .prepare(
        `
        SELECT MAX(event_time) AS t
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND soldier_id IS NOT NULL
        `,
      )
      .get() as any
  ).t as string | null;
  if (asOf && (clock == null || asOf > clock)) {
    clock = asOf;
  }
  if (!clock) return;
  const [, clockUnix] = parseEventTime(clock);
  const soldiers = db
    .prepare(
      `
      SELECT soldier_id, MAX(event_time) AS event_time
      FROM explorer_records
      WHERE category = 'TELEMETRY' AND soldier_id IS NOT NULL
      GROUP BY soldier_id
      `,
    )
    .all() as any[];
  const rows: any[] = [];
  for (const soldier of soldiers) {
    const row = db
      .prepare(
        `
        SELECT soldier_id, group_id, gateway_id, event_time, position_source,
               record_origin, id, data_json
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND soldier_id = ? AND event_time = ?
        ORDER BY id DESC
        LIMIT 1
        `,
      )
      .get(soldier.soldier_id, soldier.event_time);
    if (row != null) rows.push(row);
  }
  for (const row of rows) {
    const [, seenUnix] = parseEventTime(row.event_time);
    if (clockUnix - seenUnix <= NO_CONTACT_GAP_SECONDS) continue;
    if (openAlert(db, row.soldier_id, 'NO_CONTACT') != null) continue;
    const detected = canonicalTime(seenUnix + NO_CONTACT_GAP_SECONDS);
    const payload = JSON.parse(row.data_json);
    applyCondition(db, {
      soldierId: row.soldier_id,
      alertType: 'NO_CONTACT',
      active: true,
      derivedFrom: 'NO_TELEMETRY',
      sourceRecordId: row.id,
      groupId: row.group_id,
      gatewayId: row.gateway_id,
      eventTime: detected,
      positionSource: row.position_source,
      latitude: payload.lat ?? null,
      longitude: payload.lon ?? null,
      recordOrigin: row.record_origin,
      details: { last_telemetry_at: row.event_time, gap_seconds: clockUnix - seenUnix },
    });
  }
}

/** @deprecated Alerts are derived via raiseAlerts during unified telemetry seed. */
export function seedAlerts(_db: Database): void {
  throw new Error(
    'seedAlerts removed: use unified seedExplorer (telemetry → raiseAlerts)',
  );
}
