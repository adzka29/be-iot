import type { Database } from 'better-sqlite3';
import { encodeFlags, packMeshFrame, packPayload } from '../mesh/frame';
import { makeRecord, parseEventTime, telemetryData } from '../common/records';
import { bind } from '../common/sql';
import { resolveGroupName } from './personnel';

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

const BASE = Date.UTC(2026, 9, 4, 8, 0, 0);

/** Device-like coords only — group comes from Personnel master enrichment. */
const SOLDIERS = [
  { soldier_id: 101, lat: -6.2011, lon: 106.8121 },
  { soldier_id: 102, lat: -6.2014, lon: 106.8124 },
  { soldier_id: 103, lat: -6.2017, lon: 106.8127 },
  { soldier_id: 104, lat: -6.202, lon: 106.813 },
  { soldier_id: 105, lat: -6.2023, lon: 106.8133 },
  { soldier_id: 106, lat: -6.2026, lon: 106.8136 },
  { soldier_id: 107, lat: -6.2029, lon: 106.8139 },
  { soldier_id: 108, lat: -6.2032, lon: 106.8142 },
];

const POSITIONS = ['GNSS', 'DEAD_RECKONING', 'TRILATERATION', 'STALE'] as const;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function freshness(eventMs: number, receivedMs: number): string {
  const gap = (receivedMs - eventMs) / 1000;
  if (gap <= 30) return 'FRESH';
  if (gap <= 15 * 60) return 'AGING';
  return 'STALE';
}

function insertRecord(db: Database, record: Record<string, unknown>): void {
  const placeholders = COLUMNS.map(() => '?').join(', ');
  const columns = COLUMNS.join(', ');
  db.prepare(
    `INSERT INTO explorer_records (${columns}) VALUES (${placeholders})`,
  ).run(...bind(COLUMNS.map((c) => record[c])));
}

export function seedExplorer(db: Database): void {
  let inserted = 0;
  for (let minute = 0; minute < 30; minute += 1) {
    for (let index = 0; index < SOLDIERS.length; index += 1) {
      const soldier = SOLDIERS[index];
      const groupName = resolveGroupName(db, soldier.soldier_id);
      const eventMs = BASE + (minute * 60 + index) * 1000;
      const receivedMs = eventMs + 4000;
      const position =
        minute % 7 === 0
          ? POSITIONS[(minute + index) % POSITIONS.length]
          : 'GNSS';
      const strap = (minute + index) % 11 !== 0;
      const flags = encodeFlags({
        sos: minute === 0 && index === 0,
        casualty: minute === 12 && index === 2,
        arrhythmia: minute === 18 && index === 4,
        position,
        strap,
        low_battery: soldier.soldier_id === 108 && minute > 24,
        heat_stress: minute > 26 && index === 1,
      });
      const eventTime = iso(eventMs);
      const receivedAt = iso(receivedMs);
      const [, unix] = parseEventTime(eventTime);
      const lat = Math.round((soldier.lat + minute * 0.00001) * 1e7) / 1e7;
      const lon = Math.round((soldier.lon + minute * 0.00001) * 1e7) / 1e7;
      const hr = 70 + ((minute + index) % 20);
      const hrv = 30 + ((minute + index) % 25);
      const spo2 = 95 + ((minute + index) % 4);
      const temp = 36 + ((minute + index) % 3);
      const batt = Math.max(40, 96 - minute);
      const payload = telemetryData({
        soldier_id: soldier.soldier_id,
        seq: (minute + index) % 256,
        timestamp: unix,
        lat,
        lon,
        hr,
        hrv,
        spo2,
        temp,
        batt,
        flags,
      });
      const raw = packPayload({
        soldier_id: soldier.soldier_id,
        seq: payload.seq as number,
        timestamp: unix,
        lat,
        lon,
        hr,
        hrv,
        spo2,
        temp,
        batt,
        flags,
      });
      insertRecord(
        db,
        makeRecord({
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
          transport: 'MESH',
          freshness: freshness(eventMs, receivedMs),
          severity: null,
          record_origin: 'SIMULATED',
          raw_format: 'PAYLOAD_21',
          raw_hex: raw.toString('hex'),
          data: payload,
          created_at: receivedAt,
        }),
      );
      const hopCount = (index + minute) % 3;
      const ttl = 4 - hopCount;
      const frame = packMeshFrame(1, ttl, hopCount, raw);
      insertRecord(
        db,
        makeRecord({
          category: 'MESH',
          data_type: 'LORA_FRAME',
          entity_type: 'SOLDIER',
          entity_id: String(soldier.soldier_id),
          soldier_id: soldier.soldier_id,
          group_id: groupName,
          gateway_id: 'GW-01',
          event_time: eventTime,
          received_at: receivedAt,
          position_source: (payload.flags as any).position_source,
          transport: 'LORA',
          freshness: freshness(eventMs, receivedMs),
          severity: null,
          record_origin: 'SIMULATED',
          raw_format: 'FRAME_25',
          raw_hex: frame.toString('hex'),
          data: {
            source_id: soldier.soldier_id,
            seq: payload.seq,
            ver_type: 1,
            ttl,
            hop_count: hopCount,
            payload_length: 21,
            rssi: -72 - hopCount * 8 - (minute % 5),
            snr: Math.round((12 - hopCount * 1.5) * 10) / 10,
            pdr: Math.round((1 - hopCount * 0.04) * 100) / 100,
            spreading_factor: 9,
            tx_power_dbm: 14,
            payload,
          },
          created_at: receivedAt,
        }),
      );
      inserted += 2;
    }
  }

  const uplinks = [
    {
      burst_id: 'burst-20261004-083000',
      sent_at: '2026-10-04T08:30:00Z',
      received_at: '2026-10-04T08:30:18Z',
      delivery_mode: 'LIVE',
      delivery_status: 'delivered',
      retry_count: 0,
      session_duration_seconds: 18,
      freshness: 'FRESH',
      raw_hex: 'aa' + '11'.repeat(86),
    },
    {
      burst_id: 'burst-20261004-060000',
      sent_at: '2026-10-04T06:00:00Z',
      received_at: '2026-10-04T08:40:00Z',
      delivery_mode: 'STORE_AND_CARRY',
      delivery_status: 'delivered',
      retry_count: 2,
      session_duration_seconds: 40,
      freshness: 'STALE',
      raw_hex: 'bb' + '22'.repeat(86),
    },
  ];
  for (const uplink of uplinks) {
    insertRecord(
      db,
      makeRecord({
        category: 'UPLINK',
        data_type: 'SATELLITE_UPLINK',
        entity_type: 'GATEWAY',
        entity_id: 'GW-01',
        soldier_id: null,
        group_id: 'Alpha',
        gateway_id: 'GW-01',
        event_time: uplink.sent_at,
        received_at: uplink.received_at,
        position_source: null,
        transport: 'SATELLITE',
        freshness: uplink.freshness,
        severity: null,
        record_origin: 'SIMULATED',
        raw_format: 'HEX',
        raw_hex: uplink.raw_hex,
        data: {
          gateway_id: 'GW-01',
          burst_id: uplink.burst_id,
          packet_count: 8,
          payload_size_bytes: 174,
          sent_at: uplink.sent_at,
          received_at: uplink.received_at,
          delivery_status: uplink.delivery_status,
          retry_count: uplink.retry_count,
          session_duration_seconds: uplink.session_duration_seconds,
          delivery_mode: uplink.delivery_mode,
        },
        created_at: uplink.received_at,
      }),
    );
    inserted += 1;
  }

  for (let beaconNumber = 1; beaconNumber <= 6; beaconNumber += 1) {
    for (let observation = 0; observation < 3; observation += 1) {
      const observer = SOLDIERS[observation];
      const eventMs = BASE + ((5 + beaconNumber) * 60 + observation * 5) * 1000;
      const eventTime = iso(eventMs);
      const receivedAt = iso(eventMs + 2000);
      const beaconId = `B-${String(beaconNumber).padStart(2, '0')}`;
      insertRecord(
        db,
        makeRecord({
          category: 'BEACON',
          data_type: 'BEACON_OBSERVATION',
          entity_type: 'BEACON',
          entity_id: beaconId,
          soldier_id: null,
          group_id: 'Alpha',
          gateway_id: 'GW-01',
          beacon_id: beaconId,
          event_time: eventTime,
          received_at: receivedAt,
          position_source: null,
          transport: 'LORA',
          freshness: 'FRESH',
          severity: null,
          record_origin: 'SIMULATED',
          raw_format: 'HEX',
          raw_hex: `${beaconNumber.toString(16).padStart(2, '0')}${observation.toString(16).padStart(2, '0')}`,
          data: {
            beacon_id: beaconId,
            observer_id: String(observer.soldier_id),
            rssi: -60 - observation * 15 - beaconNumber,
            timestamp: eventTime,
          },
          created_at: receivedAt,
        }),
      );
      inserted += 1;
    }
  }

  const specials = [
    {
      special_type: 'RR_SERIES',
      soldier_id: 101,
      transport: 'MESH',
      payload_hex: Buffer.from(Array.from({ length: 100 }, (_, i) => i)).toString('hex'),
      event_time: '2026-10-04T08:12:00Z',
      received_at: '2026-10-04T08:12:06Z',
      freshness: 'FRESH',
    },
    {
      special_type: 'EKG_RECORDING',
      soldier_id: 102,
      transport: 'SATELLITE',
      payload_hex: Buffer.from(Array.from({ length: 64 }, (_, i) => i)).toString('hex'),
      event_time: '2026-10-04T08:18:00Z',
      received_at: '2026-10-04T08:33:00Z',
      freshness: 'AGING',
    },
  ];
  for (const special of specials) {
    insertRecord(
      db,
      makeRecord({
        category: 'SPECIAL',
        data_type: special.special_type,
        entity_type: 'SOLDIER',
        entity_id: String(special.soldier_id),
        soldier_id: special.soldier_id,
        group_id: 'Alpha',
        gateway_id: 'GW-01',
        event_time: special.event_time,
        received_at: special.received_at,
        position_source: null,
        transport: special.transport,
        freshness: special.freshness,
        severity: null,
        record_origin: 'SIMULATED',
        raw_format: 'OPAQUE',
        raw_hex: special.payload_hex,
        data: {
          special_type: special.special_type,
          soldier_id: special.soldier_id,
          metadata: {},
        },
        created_at: special.received_at,
      }),
    );
    inserted += 1;
  }

  const systems = [
    {
      event_type: 'DEVICE_STATE_CHANGE',
      entity_type: 'SOLDIER',
      entity_id: '101',
      soldier_id: 101,
      severity: 'WARNING',
      gateway_id: 'GW-01',
      details: { state: 'strap_disconnected' },
    },
    {
      event_type: 'GATEWAY_STATE_CHANGE',
      entity_type: 'GATEWAY',
      entity_id: 'GW-01',
      soldier_id: null as number | null,
      severity: 'INFO',
      gateway_id: 'GW-01',
      details: { state: 'uplink_queue_ready' },
    },
    {
      event_type: 'COMMUNICATION_STATE_CHANGE',
      entity_type: 'GATEWAY',
      entity_id: 'GW-01',
      soldier_id: null as number | null,
      severity: 'CRITICAL',
      gateway_id: 'GW-01',
      details: { state: 'satellite_session_failed' },
    },
  ];
  for (let offset = 0; offset < systems.length; offset += 1) {
    const system = systems[offset];
    const eventMs = BASE + (20 * 60 + offset) * 1000;
    const eventTime = iso(eventMs);
    const receivedAt = iso(eventMs + 1000);
    insertRecord(
      db,
      makeRecord({
        category: 'SYSTEM',
        data_type: system.event_type,
        entity_type: system.entity_type,
        entity_id: system.entity_id,
        soldier_id: system.soldier_id,
        group_id: 'Alpha',
        gateway_id: system.gateway_id,
        event_time: eventTime,
        received_at: receivedAt,
        position_source: null,
        transport: null,
        freshness: 'FRESH',
        severity: system.severity,
        record_origin: 'SIMULATED',
        raw_format: 'JSON',
        raw_hex: null,
        data: {
          event_type: system.event_type,
          entity_type: system.entity_type,
          entity_id: system.entity_id,
          details: system.details,
        },
        created_at: receivedAt,
      }),
    );
    inserted += 1;
  }

  if (inserted !== 505) {
    throw new Error(`seeder inserted ${inserted} records, expected 505`);
  }
}
