import type { Database } from 'better-sqlite3';
import {
  encodeFlags,
  packPayload,
  packSatelliteBurst,
} from '../mesh/frame';
import { makeRecord, parseEventTime, telemetryData } from '../common/records';
import { bind } from '../common/sql';
import { resolveGroupName } from './personnel';
import { raiseAlerts, syncNoContact } from './alert-rules';

const COLUMNS = [
  'category',
  'data_type',
  'entity_type',
  'entity_id',
  'soldier_id',
  'group_id',
  'gateway_id',
  'beacon_id',
  'event_time',
  'received_at',
  'position_source',
  'transport',
  'freshness',
  'severity',
  'record_origin',
  'raw_format',
  'raw_hex',
  'raw_bytes_length',
  'data_json',
  'is_sos',
  'created_at',
] as const;

/** Fallback deterministic clock (tests set TRACKFORGE_SEED_BASE). */
export const SEED_BASE_MS_FIXED = Date.UTC(2026, 9, 4, 8, 0, 0);

/** @deprecated use resolveSeedBaseMs() — kept for older imports. */
export const SEED_BASE_MS = SEED_BASE_MS_FIXED;

/** Complete SYNAPSE-T cadence: 2 packets/soldier/minute. */
export const SEED_INTERVAL_MS = 30_000;

/**
 * Seed window start.
 * - Demo/prod: ends at wall-clock "now" so Explorer/History match current jam.
 * - Tests: set TRACKFORGE_SEED_BASE=2026-10-04T08:00:00Z for stable assertions.
 */
export function resolveSeedBaseMs(hours = seedDurationHours()): number {
  const override = process.env.TRACKFORGE_SEED_BASE?.trim();
  if (override) {
    const parsed = Date.parse(override);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ticks = seedTickCount(hours);
  const end = Date.now() - (Date.now() % SEED_INTERVAL_MS);
  return end - (ticks - 1) * SEED_INTERVAL_MS;
}

/** 15 simulated field soldiers (IDs only — no fabricated names/Danru). */
export const SEED_SOLDIERS = [
  { soldier_id: 101, lat: -6.2011, lon: 106.8121, bearing: 0.12 },
  { soldier_id: 102, lat: -6.2015, lon: 106.8126, bearing: 0.35 },
  { soldier_id: 103, lat: -6.2019, lon: 106.8131, bearing: 0.58 },
  { soldier_id: 104, lat: -6.2023, lon: 106.8136, bearing: 0.81 },
  { soldier_id: 105, lat: -6.2027, lon: 106.8141, bearing: 1.04 },
  { soldier_id: 106, lat: -6.2031, lon: 106.8146, bearing: 1.27 },
  { soldier_id: 107, lat: -6.2035, lon: 106.8151, bearing: 1.5 },
  { soldier_id: 108, lat: -6.2039, lon: 106.8156, bearing: 1.73 },
  { soldier_id: 109, lat: -6.2043, lon: 106.8161, bearing: 1.96 },
  { soldier_id: 110, lat: -6.2047, lon: 106.8166, bearing: 2.19 },
  { soldier_id: 111, lat: -6.2051, lon: 106.8171, bearing: 2.42 },
  { soldier_id: 112, lat: -6.2055, lon: 106.8176, bearing: 2.65 },
  { soldier_id: 113, lat: -6.2059, lon: 106.8181, bearing: 2.88 },
  { soldier_id: 114, lat: -6.2063, lon: 106.8186, bearing: 3.11 },
  { soldier_id: 115, lat: -6.2067, lon: 106.8191, bearing: 3.34 },
] as const;

export type SeedSoldier = (typeof SEED_SOLDIERS)[number];

const POSITIONS = ['GNSS', 'DEAD_RECKONING', 'TRILATERATION', 'STALE'] as const;

/** Soldier with deterministic NO_CONTACT gap (telemetry pause > 30 min). */
export const NO_CONTACT_SOLDIER_ID = 115;

export function seedDurationHours(): number {
  const raw = process.env.TRACKFORGE_SEED_HOURS;
  if (raw == null || raw === '') return 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return n;
}

export function seedTickCount(hours = seedDurationHours()): number {
  return Math.round((hours * 3600 * 1000) / SEED_INTERVAL_MS);
}

/** Expected TELEMETRY rows if no gaps (15 soldiers × ticks). */
export function expectedTelemetryWithoutGaps(hours = seedDurationHours()): number {
  return SEED_SOLDIERS.length * seedTickCount(hours);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function freshness(eventMs: number, receivedMs: number): string {
  const gap = (receivedMs - eventMs) / 1000;
  if (gap <= 30) return 'FRESH';
  if (gap <= 15 * 60) return 'AGING';
  return 'STALE';
}

function insertRecord(db: Database, record: Record<string, unknown>): number {
  const placeholders = COLUMNS.map(() => '?').join(', ');
  const columns = COLUMNS.join(', ');
  const info = db
    .prepare(
      `INSERT INTO explorer_records (${columns}) VALUES (${placeholders})`,
    )
    .run(...bind(COLUMNS.map((c) => record[c])));
  return Number(info.lastInsertRowid);
}

/**
 * Bounded incident windows as fractions of the seed duration.
 * Mid-day windows clear; late windows stay active so Alerts UI has ACTIVE rows.
 */
function inWindow(progress: number, start: number, end: number): boolean {
  return progress >= start && progress < end;
}

function flagsFor(soldierId: number, progress: number, tick: number): number {
  const position =
    tick % 17 === 0 ? POSITIONS[(tick + soldierId) % POSITIONS.length] : 'GNSS';

  // Mid incident (clears) + late incident (stays ACTIVE at end).
  const sos =
    soldierId === 104 &&
    (inWindow(progress, 0.35, 0.38) || inWindow(progress, 0.92, 1.01));
  const arrhythmia =
    soldierId === 106 &&
    (inWindow(progress, 0.4, 0.43) || inWindow(progress, 0.93, 1.01));
  const heat =
    soldierId === 108 &&
    (inWindow(progress, 0.45, 0.48) || inWindow(progress, 0.94, 1.01));
  const lowBatt =
    soldierId === 110 &&
    (inWindow(progress, 0.5, 0.53) || inWindow(progress, 0.95, 1.01));
  const strapOff =
    soldierId === 112 &&
    (inWindow(progress, 0.55, 0.58) || inWindow(progress, 0.96, 1.01));
  const casualty =
    soldierId === 114 &&
    (inWindow(progress, 0.6, 0.63) || inWindow(progress, 0.97, 1.01));

  return encodeFlags({
    sos,
    casualty,
    arrhythmia,
    position,
    strap: !strapOff,
    low_battery: lowBatt,
    heat_stress: heat,
  });
}

/** Skip telemetry for S-115 during a >30min gap (scaled; min 35 minutes wall). */
function inNoContactGap(
  eventMs: number,
  baseMs: number,
  durationMs: number,
): boolean {
  const minGapMs = 35 * 60 * 1000;
  if (durationMs < minGapMs + 20 * 60 * 1000) {
    // Short seed: place a 35min gap if duration allows, else skip gap.
    if (durationMs < minGapMs + 10 * 60 * 1000) return false;
  }
  const gapStart = baseMs + Math.min(durationMs * 0.25, durationMs - minGapMs - 5 * 60 * 1000);
  const gapEnd = gapStart + minGapMs;
  return eventMs >= gapStart && eventMs < gapEnd;
}

function vitals(soldier: SeedSoldier, tick: number) {
  const phase = tick + soldier.soldier_id * 3;
  const walk = tick * 0.000008;
  const lat =
    Math.round(
      (soldier.lat + Math.sin(soldier.bearing + tick * 0.015) * 0.0004 + walk) *
        1e7,
    ) / 1e7;
  const lon =
    Math.round(
      (soldier.lon + Math.cos(soldier.bearing + tick * 0.013) * 0.0004 + walk * 0.7) *
        1e7,
    ) / 1e7;
  const hr = 62 + ((phase * 7) % 28) + (phase % 5);
  const hrv = 28 + ((phase * 5) % 30);
  const spo2 = 96 + (phase % 3);
  const temp = 36 + ((phase * 3) % 3);
  const batt = Math.max(18, 98 - Math.floor(tick / 48) - (soldier.soldier_id % 5));
  return { lat, lon, hr, hrv, spo2, temp, batt };
}

export type SeedResult = {
  telemetry: number;
  bursts: number;
  ticks: number;
  hours: number;
  skippedGap: number;
};

/**
 * Unified operational seed (ONE dataset):
 *   TELEMETRY → explorer_records → raiseAlerts → alerts
 *   History reads the same TELEMETRY rows.
 *
 * Optional SATELLITE_BURST rows are transport/audit envelopes only.
 */
export function seedExplorer(db: Database): SeedResult {
  const hours = seedDurationHours();
  const ticks = seedTickCount(hours);
  const durationMs = hours * 3600 * 1000;
  const baseMs = resolveSeedBaseMs(hours);

  const insertStmt = db.prepare(
    `INSERT INTO explorer_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  );

  let telemetryCount = 0;
  let burstCount = 0;
  let skippedGap = 0;

  const runTick = db.transaction((tick: number) => {
    const eventMs = baseMs + tick * SEED_INTERVAL_MS;
    const progress = ticks <= 1 ? 1 : tick / (ticks - 1);
    const minutePayloads: Buffer[] = [];
    const sourceIds: number[] = [];

    for (const soldier of SEED_SOLDIERS) {
      if (
        soldier.soldier_id === NO_CONTACT_SOLDIER_ID &&
        inNoContactGap(eventMs, baseMs, durationMs)
      ) {
        skippedGap += 1;
        continue;
      }

      const groupName = resolveGroupName(db, soldier.soldier_id);
      const receivedMs = eventMs + 800 + (soldier.soldier_id % 7) * 40;
      const flags = flagsFor(soldier.soldier_id, progress, tick);
      const eventTime = iso(eventMs);
      const receivedAt = iso(receivedMs);
      const [, unix] = parseEventTime(eventTime);
      const v = vitals(soldier, tick);
      const seq = tick % 256;
      const payload = telemetryData({
        soldier_id: soldier.soldier_id,
        seq,
        timestamp: unix,
        lat: v.lat,
        lon: v.lon,
        hr: v.hr,
        hrv: v.hrv,
        spo2: v.spo2,
        temp: v.temp,
        batt: v.batt,
        flags,
      });
      const raw = packPayload({
        soldier_id: soldier.soldier_id,
        seq,
        timestamp: unix,
        lat: v.lat,
        lon: v.lon,
        hr: v.hr,
        hrv: v.hrv,
        spo2: v.spo2,
        temp: v.temp,
        batt: v.batt,
        flags,
      });
      minutePayloads.push(raw);

      const record = makeRecord({
        category: 'TELEMETRY',
        data_type: 'SOLDIER_TELEMETRY',
        entity_type: 'SOLDIER',
        entity_id: String(soldier.soldier_id),
        soldier_id: soldier.soldier_id,
        group_id: groupName,
        gateway_id: 'GW-01',
        event_time: eventTime,
        received_at: receivedAt,
        position_source: (payload.flags as any).position_source,
        transport: 'SATELLITE',
        freshness: freshness(eventMs, receivedMs),
        severity: null,
        record_origin: 'SIMULATED',
        raw_format: 'PAYLOAD_21',
        raw_hex: raw.toString('hex'),
        data: payload,
        created_at: receivedAt,
      });
      const info = insertStmt.run(...bind(COLUMNS.map((c) => record[c])));
      const recordId = Number(info.lastInsertRowid);
      telemetryCount += 1;
      sourceIds.push(recordId);

      raiseAlerts(db, {
        sourceRecordId: recordId,
        soldierId: soldier.soldier_id,
        groupId: groupName,
        gatewayId: 'GW-01',
        eventTime,
        positionSource: (payload.flags as any).position_source,
        recordOrigin: 'SIMULATED',
        payload,
        syncNoContactScan: false,
      });
    }

    // Scan NO_CONTACT periodically (not every soldier packet) — still from real gaps.
    if (tick % 10 === 0 || tick === ticks - 1) {
      syncNoContact(db, iso(eventMs));
    }

    // Burst audit every 10 minutes of wall clock (20 ticks × 30s).
    if (tick % 20 === 0 && minutePayloads.length > 0) {
      const burstRaw = packSatelliteBurst(minutePayloads);
      const burstId = `burst-seed-${iso(eventMs).replace(/[:.]/g, '')}`;
      const receivedAt = iso(eventMs + 5000);
      insertRecord(
        db,
        makeRecord({
          category: 'UPLINK',
          data_type: 'SATELLITE_BURST',
          entity_type: 'GATEWAY',
          entity_id: 'GW-01',
          soldier_id: null,
          group_id: null,
          gateway_id: 'GW-01',
          event_time: receivedAt,
          received_at: receivedAt,
          position_source: null,
          transport: 'SATELLITE',
          freshness: 'FRESH',
          severity: null,
          record_origin: 'SIMULATED',
          raw_format: 'SATELLITE_BURST',
          raw_hex: burstRaw.toString('hex'),
          data: {
            burst_id: burstId,
            soldier_count: minutePayloads.length,
            payload_size_bytes: burstRaw.length,
            gateway_id: 'GW-01',
            source_telemetry_ids: sourceIds,
          },
          created_at: receivedAt,
        }),
      );
      burstCount += 1;
    }
  });

  for (let tick = 0; tick < ticks; tick += 1) {
    runTick(tick);
  }

  const endMs = baseMs + (ticks - 1) * SEED_INTERVAL_MS;
  syncNoContact(db, iso(endMs));

  return {
    telemetry: telemetryCount,
    bursts: burstCount,
    ticks,
    hours,
    skippedGap,
  };
}

/**
 * Shared tick generator for historical seed continuation / live simulator.
 * Continues seq from `tickIndex` and timestamps from seed base.
 */
export function generateLiveTick(
  db: Database,
  tickIndex: number,
  eventMs: number,
): number {
  const progress = 1; // live: keep late-window alert flags for demo continuity
  let inserted = 0;
  const insertStmt = db.prepare(
    `INSERT INTO explorer_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  );

  const run = db.transaction(() => {
    for (const soldier of SEED_SOLDIERS) {
      const groupName = resolveGroupName(db, soldier.soldier_id);
      const receivedMs = eventMs + 800 + (soldier.soldier_id % 7) * 40;
      const flags = flagsFor(soldier.soldier_id, progress, tickIndex);
      const eventTime = iso(eventMs);
      const receivedAt = iso(receivedMs);
      const [, unix] = parseEventTime(eventTime);
      const v = vitals(soldier, tickIndex);
      const seq = tickIndex % 256;
      const payload = telemetryData({
        soldier_id: soldier.soldier_id,
        seq,
        timestamp: unix,
        lat: v.lat,
        lon: v.lon,
        hr: v.hr,
        hrv: v.hrv,
        spo2: v.spo2,
        temp: v.temp,
        batt: v.batt,
        flags,
      });
      const raw = packPayload({
        soldier_id: soldier.soldier_id,
        seq,
        timestamp: unix,
        lat: v.lat,
        lon: v.lon,
        hr: v.hr,
        hrv: v.hrv,
        spo2: v.spo2,
        temp: v.temp,
        batt: v.batt,
        flags,
      });
      const record = makeRecord({
        category: 'TELEMETRY',
        data_type: 'SOLDIER_TELEMETRY',
        entity_type: 'SOLDIER',
        entity_id: String(soldier.soldier_id),
        soldier_id: soldier.soldier_id,
        group_id: groupName,
        gateway_id: 'GW-01',
        event_time: eventTime,
        received_at: receivedAt,
        position_source: (payload.flags as any).position_source,
        transport: 'SATELLITE',
        freshness: freshness(eventMs, receivedMs),
        severity: null,
        record_origin: 'SIMULATED',
        raw_format: 'PAYLOAD_21',
        raw_hex: raw.toString('hex'),
        data: payload,
        created_at: receivedAt,
      });
      const info = insertStmt.run(...bind(COLUMNS.map((c) => record[c])));
      const recordId = Number(info.lastInsertRowid);
      inserted += 1;
      raiseAlerts(db, {
        sourceRecordId: recordId,
        soldierId: soldier.soldier_id,
        groupId: groupName,
        gatewayId: 'GW-01',
        eventTime,
        positionSource: (payload.flags as any).position_source,
        recordOrigin: 'SIMULATED',
        payload,
        syncNoContactScan: false,
      });
    }
    syncNoContact(db, iso(eventMs));
  });
  run();
  return inserted;
}
