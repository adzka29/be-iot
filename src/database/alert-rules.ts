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
  syncNoContact(db, args.eventTime);
}

export function resolveNoContact(
  db: Database,
  soldierId: number,
  eventTime: string,
): void {
  const now = utcNow();
  db.prepare(
    `
    UPDATE alerts
    SET status = 'RESOLVED', resolved_at = ?, resolved_by = 'engine', updated_at = ?
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

export function seedAlerts(db: Database): void {
  const episodes: readonly [string, number, string, string][] = [
    ['SOS', 101, '2026-10-04T08:00:00Z', 'FLAGS'],
    ['SOS', 102, '2026-10-04T08:05:01Z', 'FLAGS'],
    ['SOS', 103, '2026-10-04T08:10:02Z', 'FLAGS'],
    ['CASUALTY', 104, '2026-10-04T08:12:03Z', 'FLAGS'],
    ['ARRHYTHMIA', 105, '2026-10-04T08:18:04Z', 'FLAGS'],
    ['ARRHYTHMIA', 106, '2026-10-04T08:20:05Z', 'FLAGS'],
    ['LOW_BATTERY', 101, '2026-10-04T08:25:00Z', 'FLAGS'],
    ['LOW_BATTERY', 102, '2026-10-04T08:25:01Z', 'FLAGS'],
    ['LOW_BATTERY', 103, '2026-10-04T08:25:02Z', 'FLAGS'],
    ['LOW_BATTERY', 104, '2026-10-04T08:25:03Z', 'FLAGS'],
    ['LOW_BATTERY', 105, '2026-10-04T08:25:04Z', 'FLAGS'],
    ['LOW_BATTERY', 106, '2026-10-04T08:25:05Z', 'FLAGS'],
    ['LOW_BATTERY', 107, '2026-10-04T08:25:06Z', 'FLAGS'],
    ['HEAT_STRESS', 101, '2026-10-04T08:26:00Z', 'FLAGS'],
    ['HEAT_STRESS', 102, '2026-10-04T08:26:01Z', 'FLAGS'],
    ['HEAT_STRESS', 103, '2026-10-04T08:26:02Z', 'FLAGS'],
    ['HEAT_STRESS', 104, '2026-10-04T08:26:03Z', 'FLAGS'],
    ['HEAT_STRESS', 105, '2026-10-04T08:26:04Z', 'FLAGS'],
    ['STRAP_DISCONNECTED', 105, '2026-10-04T08:15:04Z', 'CHEST_STRAP'],
    ['STRAP_DISCONNECTED', 106, '2026-10-04T08:15:05Z', 'CHEST_STRAP'],
    ['STRAP_DISCONNECTED', 107, '2026-10-04T08:15:06Z', 'CHEST_STRAP'],
    ['STRAP_DISCONNECTED', 108, '2026-10-04T08:15:07Z', 'CHEST_STRAP'],
  ];
  let inserted = 0;
  for (const [alertType, soldierId, eventTime, derivedFrom] of episodes) {
    const source = db
      .prepare(
        `
        SELECT id, position_source, data_json
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND soldier_id = ? AND event_time = ?
        ORDER BY id
        LIMIT 1
        `,
      )
      .get(soldierId, eventTime) as any;
    const payload = source != null ? JSON.parse(source.data_json) : {};
    insertAlert(db, {
      alert_code: code(alertType, soldierId, eventTime),
      alert_type: alertType,
      severity: SEVERITY[alertType],
      status: 'ACTIVE',
      entity_type: 'SOLDIER',
      entity_id: String(soldierId),
      soldier_id: soldierId,
      group_id: 'Alpha',
      gateway_id: 'GW-01',
      source_record_id: source == null ? null : source.id,
      event_time: eventTime,
      first_seen_at: eventTime,
      last_seen_at: eventTime,
      position_source: source == null ? null : source.position_source,
      latitude: payload.lat ?? null,
      longitude: payload.lon ?? null,
      message: MESSAGES[alertType],
      acknowledged_at: null,
      acknowledged_by: null,
      resolved_at: null,
      resolved_by: null,
      derived_from: derivedFrom,
      record_origin: 'SIMULATED',
      created_at: eventTime,
      updated_at: eventTime,
      details_json: JSON.stringify(
        Object.keys(payload).length ? details(payload) : { condition: alertType },
      ),
    });
    inserted += 1;
  }
  for (let offset = 0; offset < 14; offset += 1) {
    const soldierId = 301 + offset;
    const eventTime = `2026-10-04T07:${String(offset).padStart(2, '0')}:00Z`;
    insertAlert(db, {
      alert_code: code('NO_CONTACT', soldierId, eventTime),
      alert_type: 'NO_CONTACT',
      severity: 'INFO',
      status: 'ACTIVE',
      entity_type: 'SOLDIER',
      entity_id: String(soldierId),
      soldier_id: soldierId,
      group_id: 'Alpha',
      gateway_id: 'GW-01',
      source_record_id: null,
      event_time: eventTime,
      first_seen_at: eventTime,
      last_seen_at: eventTime,
      position_source: null,
      latitude: null,
      longitude: null,
      message: MESSAGES.NO_CONTACT,
      acknowledged_at: null,
      acknowledged_by: null,
      resolved_at: null,
      resolved_by: null,
      derived_from: 'NO_TELEMETRY',
      record_origin: 'SIMULATED',
      created_at: eventTime,
      updated_at: eventTime,
      details_json: JSON.stringify({ gap_seconds: NO_CONTACT_GAP_SECONDS }),
    });
    inserted += 1;
  }
  if (inserted !== 36) {
    throw new Error(`seeder inserted ${inserted} alerts, expected 36`);
  }
}
