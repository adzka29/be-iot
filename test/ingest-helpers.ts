import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  encodeFlags,
  packPayload,
  packSatelliteBurst,
} from '../src/mesh/frame';

export type SoldierTelemetryInput = {
  soldier_id: number;
  seq?: number;
  /** Unix seconds or ISO string — packed as unix into the 21-byte payload. */
  timestamp?: number | string;
  lat?: number;
  lon?: number;
  hr?: number;
  hrv?: number;
  spo2?: number;
  temp?: number;
  batt?: number;
  flags?: number;
};

function toUnix(value?: number | string): number {
  if (value == null) {
    return Math.floor(Date.parse('2026-10-07T10:00:00Z') / 1000);
  }
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  return Math.floor(Date.parse(text) / 1000);
}

/** Pack one or more soldier telemetries into a satellite burst hex. */
export function buildBurstHex(
  soldiers: SoldierTelemetryInput | SoldierTelemetryInput[],
  header?: Buffer,
): string {
  const list = Array.isArray(soldiers) ? soldiers : [soldiers];
  const payloads = list.map((s) =>
    packPayload({
      soldier_id: s.soldier_id,
      seq: s.seq ?? 1,
      timestamp: toUnix(s.timestamp),
      lat: s.lat ?? -6.2,
      lon: s.lon ?? 106.8,
      hr: s.hr ?? 80,
      hrv: s.hrv ?? 40,
      spo2: s.spo2 ?? 98,
      temp: s.temp ?? 36,
      batt: s.batt ?? 90,
      flags: s.flags ?? encodeFlags({}),
    }),
  );
  return packSatelliteBurst(payloads, header).toString('hex');
}

/** POST /api/ingest with a single-soldier (or multi) burst. */
export async function ingestBurst(
  app: INestApplication,
  soldiers: SoldierTelemetryInput | SoldierTelemetryInput[],
  meta: {
    gateway_id?: string;
    burst_id?: string;
    received_at?: string;
    record_origin?: string;
    freshness?: string;
  } = {},
) {
  return request(app.getHttpServer())
    .post('/api/ingest')
    .send({
      burst_hex: buildBurstHex(soldiers),
      gateway_id: meta.gateway_id ?? 'GW-01',
      burst_id: meta.burst_id,
      received_at: meta.received_at,
      record_origin: meta.record_origin,
      freshness: meta.freshness,
    });
}

/** First soldier telemetry record from a burst ingest response. */
export function firstRecord(response: { body: any }) {
  return response.body.records[0];
}
