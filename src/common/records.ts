import { decodeFlags, parseHex } from '../mesh/frame';

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const TIME_RANGES = ['all', '30d'] as const;

const TIME_RANGE_ALIASES: Record<string, string> = {
  all: 'all',
  alltime: 'all',
  '30d': '30d',
  '30day': '30d',
  '30days': '30d',
};

export function timeRangeStart(value?: string | null): string | null {
  if (value == null || !value.trim()) return null;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const preset = TIME_RANGE_ALIASES[key];
  if (preset == null) throw new Error('unknown timeRange');
  if (preset === 'all') return null;
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return start.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseEventTime(value: number | string): [string, number] {
  if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string')) {
    throw new Error('timestamp must be ISO-8601 or unix seconds');
  }
  if (typeof value === 'number') {
    const unix = value;
    const iso = new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return [iso, unix];
  }
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const unix = Number(text);
    const iso = new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return [iso, unix];
  }
  const normalized = text.replace('Z', '+00:00');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('timestamp must be ISO-8601 or unix seconds');
  }
  parsed.setUTCMilliseconds(0);
  const unix = Math.floor(parsed.getTime() / 1000);
  return [parsed.toISOString().replace(/\.\d{3}Z$/, 'Z'), unix];
}

export function canonicalTime(value: number | string): string {
  return parseEventTime(value)[0];
}

export function freshnessBetween(eventTime: string, receivedAt: string): string {
  const [, eventUnix] = parseEventTime(eventTime);
  const [, receivedUnix] = parseEventTime(receivedAt);
  const gap = receivedUnix - eventUnix;
  if (gap <= 30) return 'FRESH';
  if (gap <= 15 * 60) return 'AGING';
  return 'STALE';
}

export function normalizeHex(
  rawHex?: string | null,
): [string | null, number | null] {
  if (rawHex == null || rawHex === '') return [null, null];
  try {
    const raw = parseHex(rawHex);
    return [raw.toString('hex'), raw.length];
  } catch {
    return [rawHex, null];
  }
}

export function telemetryData(opts: {
  soldier_id: number;
  seq: number;
  timestamp: number;
  lat: number;
  lon: number;
  hr: number;
  hrv: number;
  spo2: number;
  temp: number;
  batt: number;
  flags: number;
}): Record<string, unknown> {
  const decoded = decodeFlags(opts.flags);
  const data: Record<string, unknown> = {
    soldier_id: opts.soldier_id,
    seq: opts.seq,
    timestamp: opts.timestamp,
    lat: opts.lat,
    lon: opts.lon,
    hr: opts.hr,
    hrv: opts.hrv,
    spo2: opts.spo2,
    temp: opts.temp,
    batt: opts.batt,
    flags: decoded,
  };
  if (!decoded.strap_connected) data.vital = 'TANPA VITAL';
  return data;
}

export type RecordInput = {
  category: string;
  data_type: string;
  entity_type?: string | null;
  entity_id?: string | null;
  soldier_id?: number | null;
  group_id?: string | null;
  gateway_id?: string | null;
  beacon_id?: string | null;
  event_time: string;
  received_at: string;
  position_source?: string | null;
  transport?: string | null;
  freshness?: string | null;
  severity?: string | null;
  record_origin?: string | null;
  raw_format?: string | null;
  raw_hex?: string | null;
  data: Record<string, unknown>;
  is_sos?: number;
  created_at?: string | null;
};

export function makeRecord(input: RecordInput): Record<string, unknown> {
  const [storedHex, nbytes] = normalizeHex(input.raw_hex);
  return {
    category: input.category,
    data_type: input.data_type,
    entity_type: input.entity_type ?? null,
    entity_id: input.entity_id ?? null,
    soldier_id: input.soldier_id ?? null,
    group_id: input.group_id ?? null,
    gateway_id: input.gateway_id ?? null,
    beacon_id: input.beacon_id ?? null,
    event_time: input.event_time,
    received_at: input.received_at,
    position_source: input.position_source ?? null,
    transport: input.transport ?? null,
    freshness: input.freshness ?? null,
    severity: input.severity ?? null,
    record_origin: input.record_origin ?? null,
    raw_format: input.raw_format ?? null,
    raw_hex: storedHex,
    raw_bytes_length: nbytes,
    data_json: JSON.stringify(input.data),
    is_sos: input.is_sos ?? 0,
    created_at: input.created_at || utcNow(),
  };
}
