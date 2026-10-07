import {
  Controller,
  Get,
  Header,
  HttpException,
  Param,
  ParseIntPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { TIME_RANGES, canonicalTime, timeRangeStart } from '../common/records';
import { bind } from '../common/sql';
import { resolvePersonnelName } from '../database/personnel';

const CSV_COLUMNS = [
  'id', 'category', 'data_type', 'entity_type', 'entity_id', 'soldier_id',
  'group_id', 'gateway_id', 'event_time', 'received_at', 'position_source',
  'transport', 'freshness', 'severity', 'record_origin', 'raw_format',
  'raw_hex', 'raw_bytes_length', 'created_at', 'data',
] as const;

const OPTION_COLUMNS: [string, string][] = [
  ['categories', 'category'],
  ['data_types', 'data_type'],
  ['entity_types', 'entity_type'],
  ['groups', 'group_id'],
  ['gateways', 'gateway_id'],
  ['position_sources', 'position_source'],
  ['transports', 'transport'],
  ['freshness', 'freshness'],
  ['severity', 'severity'],
  ['record_origins', 'record_origin'],
  ['raw_formats', 'raw_format'],
];

@Controller('api/explorer')
export class ExplorerController {
  constructor(private readonly db: DatabaseService) {}

  private rangeStart(value?: string | null): string | null {
    try {
      return timeRangeStart(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private timeBound(value: string): string {
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

  private toApi(row: any) {
    const item = this.db.recordToApi(row) as Record<string, unknown>;
    const soldierId =
      item.soldier_id != null ? Number(item.soldier_id) : null;
    item.personnel_name = resolvePersonnelName(this.db.connection, soldierId);
    return item;
  }

  private filters(q: any): { where: string; params: unknown[] } {
    // is_sos is legacy schema only — not a business filter.
    // SOS truth is data.flags.sos; TELEMETRY with SOS stays visible.
    const conditions: string[] = ['1 = 1'];
    const params: unknown[] = [];
    // Default FE domain = TELEMETRY. Transport (UPLINK/SATELLITE_BURST) is
    // internal audit — only when include_transport=1 or category is explicit.
    let category = this.asList(q.category);
    if (
      (!category || !category.length) &&
      q.include_transport !== '1' &&
      q.include_transport !== 'true'
    ) {
      category = ['TELEMETRY'];
    }
    const dataType = this.asList(q.data_type);
    for (const [column, values] of [
      ['category', category],
      ['data_type', dataType],
    ] as const) {
      if (values?.length) {
        conditions.push(`${column} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      }
    }
    for (const [column, value] of [
      ['entity_type', q.entity_type],
      ['entity_id', q.entity_id],
      ['group_id', q.group_id],
      ['gateway_id', q.gateway_id],
      ['position_source', q.position_source],
      ['transport', q.transport],
      ['freshness', q.freshness],
      ['severity', q.severity],
      ['record_origin', q.record_origin],
      ['raw_format', q.raw_format],
    ] as const) {
      if (value) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (q.soldier_id != null && q.soldier_id !== '') {
      conditions.push('soldier_id = ?');
      params.push(Number(q.soldier_id));
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
    if (q.q && String(q.q).trim()) {
      const needle = `%${String(q.q).trim()}%`;
      conditions.push(`(
        CAST(id AS TEXT) LIKE ? OR
        IFNULL(entity_id, '') LIKE ? COLLATE NOCASE OR
        IFNULL(entity_type, '') LIKE ? COLLATE NOCASE OR
        IFNULL(CAST(soldier_id AS TEXT), '') LIKE ? OR
        IFNULL(group_id, '') LIKE ? COLLATE NOCASE OR
        data_type LIKE ? COLLATE NOCASE OR
        category LIKE ? COLLATE NOCASE OR
        IFNULL(transport, '') LIKE ? COLLATE NOCASE OR
        IFNULL(position_source, '') LIKE ? COLLATE NOCASE OR
        IFNULL(raw_hex, '') LIKE ? COLLATE NOCASE OR
        data_json LIKE ? COLLATE NOCASE OR
        IFNULL(record_origin, '') LIKE ? COLLATE NOCASE OR
        EXISTS (
          SELECT 1 FROM personnel p
          WHERE p.soldier_id = explorer_records.soldier_id
            AND p.name LIKE ? COLLATE NOCASE
        )
      )`);
      for (let i = 0; i < 13; i++) params.push(needle);
    }
    return { where: conditions.join(' AND '), params };
  }

  private rows(where: string, params: unknown[], limit?: number, offset = 0) {
    let sql = `
      SELECT * FROM explorer_records
      WHERE ${where}
      ORDER BY event_time DESC, id DESC
    `;
    const bound = [...params];
    if (limit != null) {
      sql += ' LIMIT ? OFFSET ?';
      bound.push(limit, offset);
    }
    const total = (
      this.db.connection
        .prepare(`SELECT COUNT(*) AS n FROM explorer_records WHERE ${where}`)
        .get(...bind(params)) as any
    ).n as number;
    const rows = this.db.connection.prepare(sql).all(...bind(bound)) as any[];
    return { total, rows };
  }

  @Get()
  list(@Query() q: any) {
    const { where, params } = this.filters(q);
    const limit = Math.min(Math.max(Number(q.limit || 50), 1), 500);
    const offset = Math.max(Number(q.offset || 0), 0);
    const { total, rows } = this.rows(where, params, limit, offset);
    const items = rows.map((row) => this.toApi(row));
    return { items, limit, offset, count: items.length, total };
  }

  @Get('summary')
  summary(@Query() q: any) {
    const { where, params } = this.filters(q);
    const conn = this.db.connection;
    const total = (
      conn.prepare(`SELECT COUNT(*) AS n FROM explorer_records WHERE ${where}`).get(...bind(params)) as any
    ).n;
    const timeline = conn
      .prepare(
        `
        SELECT substr(event_time, 1, 13) || ':00:00Z' AS time, category, COUNT(*) AS count
        FROM explorer_records WHERE ${where}
        GROUP BY time, category
        ORDER BY time, count DESC, category
        `,
      )
      .all(...bind(params)) as any[];
    const byCategory = conn
      .prepare(
        `
        SELECT category, COUNT(*) AS count FROM explorer_records
        WHERE ${where} GROUP BY category ORDER BY count DESC, category
        `,
      )
      .all(...bind(params)) as any[];
    const byDataType = conn
      .prepare(
        `
        SELECT data_type, COUNT(*) AS count FROM explorer_records
        WHERE ${where} GROUP BY data_type ORDER BY count DESC, data_type
        `,
      )
      .all(...bind(params)) as any[];
    const buckets = new Map<string, any>();
    for (const row of timeline) {
      let bucket = buckets.get(row.time);
      if (!bucket) {
        bucket = { time: row.time, count: 0, segments: [] };
        buckets.set(row.time, bucket);
      }
      bucket.count += row.count;
      bucket.segments.push({ category: row.category, count: row.count });
    }
    return {
      total,
      timeline: Array.from(buckets.values()),
      by_category: byCategory.map((r) => ({ category: r.category, count: r.count })),
      by_data_type: byDataType.map((r) => ({ data_type: r.data_type, count: r.count })),
    };
  }

  @Get('filters/options')
  filterOptions() {
    const options: Record<string, string[]> = {};
    const conn = this.db.connection;
    for (const [key, column] of OPTION_COLUMNS) {
      const rows = conn
        .prepare(
          `
          SELECT DISTINCT ${column} AS value FROM explorer_records
          WHERE category = 'TELEMETRY' AND ${column} IS NOT NULL AND ${column} != ''
          ORDER BY value
          `,
        )
        .all() as any[];
      options[key] = rows.map((r) => r.value);
    }
    options.time_ranges = [...TIME_RANGES];
    return options;
  }

  @Get('export.csv')
  exportCsv(@Query() q: any, @Res() res: Response) {
    const { where, params } = this.filters(q);
    const { rows } = this.rows(where, params);
    const csvCell = (value: unknown) => {
      const text = value == null ? '' : String(value);
      if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };
    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows) {
      const item = this.toApi(row);
      lines.push(
        CSV_COLUMNS.map((col) => {
          const val = col === 'data' ? JSON.stringify(item.data) : item[col];
          return csvCell(val);
        }).join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="explorer.csv"');
    res.send('\ufeff' + lines.join('\n') + '\n');
  }

  @Get(':recordId')
  getOne(@Param('recordId', ParseIntPipe) recordId: number) {
    const row = this.db.getRecord(recordId);
    if (row == null) {
      throw new HttpException('record not found', 404);
    }
    return this.toApi(row);
  }
}
