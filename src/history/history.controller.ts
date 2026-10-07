import {
  Controller,
  Get,
  HttpException,
  Param,
  ParseIntPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  effectiveAccess,
  getUser,
  hasPermission,
} from '../database/access';
import { actorFromSession, sessionToken } from '../common/audit';
import { TIME_RANGES, canonicalTime, parseEventTime, timeRangeStart } from '../common/records';
import { bind } from '../common/sql';

/** Operational History domain = TELEMETRY only. Transport types remain optional debug overrides. */
const CATEGORY_BY_TYPE: Record<string, string> = {
  TELEMETRY: 'TELEMETRY',
  MESH_FRAME: 'MESH',
  UPLINK: 'UPLINK',
  BEACON: 'BEACON',
  SPECIAL: 'SPECIAL',
  SYSTEM: 'SYSTEM',
};
const TYPE_BY_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_BY_TYPE).map(([k, v]) => [v, k]),
);
const GAP_SECONDS = 15 * 60;
const CSV_COLUMNS = [
  'id', 'source_id', 'event_time', 'received_at', 'data_type', 'category',
  'soldier_id', 'group_id', 'gateway_id', 'position_source', 'latitude', 'longitude',
];

@Controller('api/history')
export class HistoryController {
  constructor(private readonly db: DatabaseService) {}

  /** Session + history.read (docs contract). */
  private requireHistory(request: Request) {
    const conn = this.db.connection;
    const actor = actorFromSession(conn, sessionToken(request));
    if (actor == null) throw new HttpException('authentication required', 401);
    const user = getUser(conn, actor.id!);
    if (user == null) throw new HttpException('authentication required', 401);
    const access = effectiveAccess(conn, user.id);
    const granted = new Set(access?.permissions ?? []);
    if (!hasPermission(granted, 'history', 'read')) {
      throw new HttpException('permission denied', 403);
    }
    return user;
  }

  private rangeStart(value?: string | null) {
    try {
      return timeRangeStart(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private timeBound(value: string) {
    try {
      return canonicalTime(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private asList(value?: string | string[]): string[] | undefined {
    if (value == null) return undefined;
    return Array.isArray(value) ? value : [value];
  }

  private categories(values?: string[]) {
    if (!values?.length) return null;
    const unknown = values.filter((v) => !(v in CATEGORY_BY_TYPE));
    if (unknown.length) {
      throw new HttpException(`unknown history_data_type: ${unknown.join(', ')}`, 400);
    }
    return values.map((v) => CATEGORY_BY_TYPE[v]);
  }

  /**
   * scope=GROUP&group_id=Alpha — `group_id` matches explorer_records.group_id,
   * which stores the enriched **group name string** (not numeric groups.id).
   */
  private scopeClause(scope: string, soldierId?: number | null, groupId?: string | null) {
    if (scope === 'SOLDIER') {
      if (soldierId == null) {
        throw new HttpException('soldier_id is required when scope is SOLDIER', 400);
      }
      return { clause: 'soldier_id = ?', params: [soldierId] as unknown[] };
    }
    if (scope === 'GROUP') {
      if (!groupId) {
        throw new HttpException('group_id is required when scope is GROUP', 400);
      }
      return { clause: 'group_id = ?', params: [groupId] as unknown[] };
    }
    throw new HttpException('scope must be SOLDIER or GROUP', 400);
  }

  private where(q: any) {
    const soldierId = q.soldier_id != null && q.soldier_id !== '' ? Number(q.soldier_id) : null;
    const { clause, params } = this.scopeClause(q.scope, soldierId, q.group_id);
    const conditions = [clause];
    // Default operational domain = TELEMETRY (not UPLINK/SATELLITE_BURST transport).
    let categories = this.categories(this.asList(q.history_data_type));
    if (!categories?.length) {
      categories = ['TELEMETRY'];
    }
    conditions.push(`category IN (${categories.map(() => '?').join(', ')})`);
    params.push(...categories);
    const sources = (this.asList(q.position_source) || []).filter(Boolean);
    if (sources.length) {
      conditions.push(`position_source IN (${sources.map(() => '?').join(', ')})`);
      params.push(...sources);
    }
    const rangeStart = this.rangeStart(q.timeRange);
    if (rangeStart) {
      conditions.push('event_time >= ?');
      params.push(rangeStart);
    }
    if (q.from_time) {
      conditions.push('event_time >= ?');
      params.push(this.timeBound(q.from_time));
    }
    if (q.to_time) {
      conditions.push('event_time <= ?');
      params.push(this.timeBound(q.to_time));
    }
    return { where: conditions.join(' AND '), params };
  }

  private load(where: string, params: unknown[]) {
    return this.db.connection
      .prepare(
        `SELECT * FROM explorer_records WHERE ${where} ORDER BY event_time ASC, id ASC`,
      )
      .all(...bind(params)) as any[];
  }

  private queryRows(q: any) {
    const { where, params } = this.where(q);
    return this.load(where, params);
  }

  private payload(row: any, data: any) {
    const nested = data.payload;
    if (row.category === 'MESH' && nested && typeof nested === 'object') return nested;
    return data;
  }

  private number(value: unknown): number | null {
    if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string')) {
      return null;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return null;
  }

  private sample(row: any) {
    const data = JSON.parse(row.data_json);
    const payload = this.payload(row, data);
    return {
      row,
      data,
      payload,
      seq: payload.seq,
      lat: this.number(payload.lat),
      lon: this.number(payload.lon),
      hr: this.number(payload.hr),
      batt: this.number(payload.batt),
    };
  }

  /** Deduplicate TELEMETRY only (operational History track/charts). */
  private deduped(rows: any[]) {
    const chosen = new Map<string, any>();
    for (const row of rows) {
      if (row.category !== 'TELEMETRY') continue;
      const sample = this.sample(row);
      const key = `${row.soldier_id}|${row.event_time}|${sample.seq}`;
      if (!chosen.has(key)) chosen.set(key, sample);
    }
    return Array.from(chosen.values());
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const radius = 6371.0;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dPhi / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(a));
  }

  private distanceKm(samples: any[]) {
    const bySoldier = new Map<number, any[]>();
    for (const sample of samples) {
      const soldierId = sample.row.soldier_id;
      if (soldierId == null || sample.lat == null || sample.lon == null) continue;
      if (!bySoldier.has(soldierId)) bySoldier.set(soldierId, []);
      bySoldier.get(soldierId)!.push(sample);
    }
    let total = 0;
    for (const points of bySoldier.values()) {
      points.sort((a, b) =>
        a.row.event_time === b.row.event_time
          ? a.row.id - b.row.id
          : a.row.event_time < b.row.event_time
            ? -1
            : 1,
      );
      for (let i = 0; i < points.length - 1; i += 1) {
        const previous = points[i];
        const current = points[i + 1];
        const [, prevUnix] = parseEventTime(previous.row.event_time);
        const [, curUnix] = parseEventTime(current.row.event_time);
        if (curUnix - prevUnix > GAP_SECONDS) continue;
        total += this.haversineKm(previous.lat, previous.lon, current.lat, current.lon);
      }
    }
    return Math.round(total * 1000) / 1000;
  }

  private average(values: number[]) {
    if (!values.length) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }

  private historyType(category: string) {
    return TYPE_BY_CATEGORY[category] || category;
  }

  private item(row: any) {
    const sample = this.sample(row);
    return {
      id: `R-${row.id}`,
      source_type: 'RECORD',
      source_id: row.id,
      event_time: row.event_time,
      received_at: row.received_at,
      // History maps category → data_type label (TELEMETRY), not DB data_type SOLDIER_TELEMETRY.
      data_type: this.historyType(row.category),
      category: row.category,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      soldier_id: row.soldier_id,
      group_id: row.group_id,
      gateway_id: row.gateway_id,
      position_source: row.position_source,
      latitude: sample.lat,
      longitude: sample.lon,
    };
  }

  private detail(row: any) {
    const sample = this.sample(row);
    const payload = sample.payload;
    const data = sample.data;
    const flags = flagsObject(payload.flags) ? payload.flags : {};
    const positionSource = row.position_source || (flags as any).position_source;
    const item: any = this.item(row);
    item.position_source = positionSource;
    item.transport = row.transport;
    item.details = {
      position: {
        latitude: sample.lat,
        longitude: sample.lon,
        position_source: positionSource,
      },
      vitals: {
        hr: payload.hr,
        hrv: payload.hrv,
        spo2: payload.spo2,
        temp: payload.temp,
      },
      device: { batt: payload.batt, flags },
      // 21-byte soldier packet has no hop/rssi/snr — do not fake Communication.
      packet_reference: {
        transport: row.transport ?? null,
        gateway_id: row.gateway_id ?? null,
        seq: payload.seq ?? null,
        burst_id: data.burst_id ?? null,
        burst_index: data.burst_index ?? null,
      },
      timing: { event_time: row.event_time, received_at: row.received_at },
      raw_data: {
        raw_hex: row.raw_hex,
        raw_format: row.raw_format,
        raw_bytes_length: row.raw_bytes_length,
      },
    };
    return item;
  }

  @Get()
  list(@Req() request: Request, @Query() q: any) {
    this.requireHistory(request);
    let rows = this.queryRows(q);
    rows = [...rows].sort((a, b) =>
      a.event_time === b.event_time
        ? b.id - a.id
        : a.event_time < b.event_time
          ? 1
          : -1,
    );
    const limit = Math.min(Math.max(Number(q.limit || 50), 1), 500);
    const offset = Math.max(Number(q.offset || 0), 0);
    const page = rows.slice(offset, offset + limit);
    return {
      items: page.map((row) => this.item(row)),
      limit,
      offset,
      count: page.length,
      total: rows.length,
    };
  }

  @Get('filters/options')
  filterOptions(@Req() request: Request, @Query() q: any) {
    this.requireHistory(request);
    // Always TELEMETRY domain for filter options (ignore transport overrides).
    const rows = this.queryRows({
      ...q,
      history_data_type: 'TELEMETRY',
      position_source: undefined,
    });
    return {
      // Operational History only exposes TELEMETRY — not UPLINK/MESH/BEACON.
      data_types: ['TELEMETRY'],
      position_sources: [...new Set(rows.map((r) => r.position_source).filter(Boolean))].sort(),
      soldiers: [...new Set(rows.map((r) => r.soldier_id).filter((v) => v != null))].sort(
        (a, b) => a - b,
      ),
      // Group names present on telemetry only after personnel enrichment.
      groups: [...new Set(rows.map((r) => r.group_id).filter(Boolean))].sort(),
      time_ranges: [...TIME_RANGES],
    };
  }

  @Get('summary')
  summary(@Req() request: Request, @Query() q: any) {
    this.requireHistory(request);
    const rows = this.queryRows(q);
    const samples = this.deduped(rows);
    return {
      cards: {
        total_distance_km: this.distanceKm(samples),
        distance_is_derived: true,
        heart_rate_avg_bpm: this.average(
          samples.filter((s) => s.hr != null).map((s) => s.hr),
        ),
        battery_avg_percent: this.average(
          samples.filter((s) => s.batt != null).map((s) => s.batt),
        ),
        // TELEMETRY row count only (transport audit excluded by default filter).
        total_records: rows.length,
        telemetry_count: rows.length,
      },
    };
  }

  @Get('statistics')
  statistics(@Req() request: Request, @Query() q: any) {
    this.requireHistory(request);
    const rows = this.queryRows(q);
    const samples = this.deduped(rows).filter((s) => s.lat != null && s.lon != null);
    const sourceCounts: Record<string, number> = {};
    for (const sample of samples) {
      const source = sample.row.position_source;
      if (source) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
    const bySoldier = new Map<number, number>();
    for (const row of rows) {
      if (row.soldier_id == null) continue;
      bySoldier.set(row.soldier_id, (bySoldier.get(row.soldier_id) || 0) + 1);
    }
    return {
      telemetry_count: rows.length,
      total_records: rows.length,
      position_points: samples.length,
      soldiers: bySoldier.size,
      by_position_source: Object.keys(sourceCounts)
        .sort()
        .map((name) => ({ name, count: sourceCounts[name] })),
      by_soldier: [...bySoldier.entries()]
        .sort(([a], [b]) => a - b)
        .map(([soldier_id, count]) => ({ soldier_id, count })),
    };
  }

  @Get('charts')
  charts(@Req() request: Request, @Query() q: any) {
    this.requireHistory(request);
    const rows = this.queryRows(q);
    const buckets = new Map<string, any>();
    for (const sample of this.deduped(rows)) {
      const stamp = sample.row.event_time;
      const key = stamp.slice(0, 13) + ':00:00Z';
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { time: key, hr: [] as number[], batt: [] as number[] };
        buckets.set(key, bucket);
      }
      if (sample.hr != null) bucket.hr.push(sample.hr);
      if (sample.batt != null) bucket.batt.push(sample.batt);
    }
    return {
      buckets: [...buckets.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, bucket]) => ({
          time: bucket.time,
          heart_rate_avg_bpm: this.average(bucket.hr),
          battery_avg_percent: this.average(bucket.batt),
          samples: bucket.hr.length || bucket.batt.length,
        })),
    };
  }

  @Get('track')
  track(@Req() request: Request, @Query() q: any) {
    this.requireHistory(request);
    // Force TELEMETRY for soldier movement track (ignore transport overrides).
    const rows = this.queryRows({ ...q, history_data_type: 'TELEMETRY' });
    const points: any[] = [];
    for (const sample of this.deduped(rows)) {
      if (sample.lat == null || sample.lon == null) continue;
      const row = sample.row;
      points.push({
        id: `R-${row.id}`,
        source_id: row.id,
        soldier_id: row.soldier_id,
        event_time: row.event_time,
        latitude: sample.lat,
        longitude: sample.lon,
        position_source: row.position_source,
      });
    }
    points.sort((a, b) =>
      a.event_time === b.event_time
        ? a.source_id - b.source_id
        : a.event_time < b.event_time
          ? -1
          : 1,
    );
    return { points };
  }

  @Get('export.csv')
  exportCsv(@Req() request: Request, @Query() q: any, @Res() res: Response) {
    this.requireHistory(request);
    let rows = this.queryRows(q);
    rows = [...rows].sort((a, b) =>
      a.event_time === b.event_time
        ? b.id - a.id
        : a.event_time < b.event_time
          ? 1
          : -1,
    );
    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows) {
      const item: any = this.item(row);
      lines.push(
        CSV_COLUMNS.map((col) => {
          const val = item[col];
          return `"${String(val == null ? '' : val).replace(/"/g, '""')}"`;
        }).join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="history.csv"');
    res.send('\ufeff' + lines.join('\n') + '\n');
  }

  @Get('point/:recordId')
  point(
    @Req() request: Request,
    @Param('recordId', ParseIntPipe) recordId: number,
  ) {
    this.requireHistory(request);
    const row = this.db.getRecord(recordId);
    if (row == null || row.category !== 'TELEMETRY') {
      throw new HttpException('record not found', 404);
    }
    return this.detail(row);
  }
}

function flagsObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}
