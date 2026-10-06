import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { syncNoContact } from '../database/alert-rules';
import { TIME_RANGES, canonicalTime, timeRangeStart, utcNow } from '../common/records';
import { bind } from '../common/sql';

const PUBLIC = [
  'id', 'alert_code', 'alert_type', 'severity', 'status', 'entity_type', 'entity_id',
  'soldier_id', 'group_id', 'gateway_id', 'source_record_id', 'event_time',
  'first_seen_at', 'last_seen_at', 'position_source', 'latitude', 'longitude',
  'message', 'acknowledged_at', 'acknowledged_by', 'resolved_at', 'resolved_by',
  'derived_from', 'record_origin', 'created_at', 'updated_at',
] as const;

const OPTION_COLUMNS: [string, string][] = [
  ['alert_types', 'alert_type'],
  ['severities', 'severity'],
  ['statuses', 'status'],
  ['groups', 'group_id'],
  ['gateways', 'gateway_id'],
  ['derived_from', 'derived_from'],
  ['record_origins', 'record_origin'],
];

@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly db: DatabaseService) {}

  alertToApi(row: any) {
    const item: Record<string, unknown> = {};
    for (const field of PUBLIC) item[field] = row[field];
    item.details = JSON.parse(row.details_json);
    let source: Record<string, unknown> | null = null;
    if (row.source_record_id != null) {
      const record = this.db.getRecord(row.source_record_id);
      if (record) source = this.db.recordToApi(record);
    }
    item.source_record = source;
    return item;
  }

  private asList(value?: string | string[]): string[] | undefined {
    if (value == null) return undefined;
    return Array.isArray(value) ? value : [value];
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

  private filters(q: any) {
    const conditions = ['1 = 1'];
    const params: unknown[] = [];
    for (const [column, values] of [
      ['alert_type', this.asList(q.alert_type)],
      ['severity', this.asList(q.severity)],
    ] as const) {
      const kept = (values || []).filter(Boolean);
      if (kept.length) {
        conditions.push(`${column} IN (${kept.map(() => '?').join(', ')})`);
        params.push(...kept);
      }
    }
    for (const [column, value] of [
      ['status', q.status],
      ['group_id', q.group_id],
      ['gateway_id', q.gateway_id],
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
        CAST(id AS TEXT) LIKE ? OR alert_code LIKE ? COLLATE NOCASE OR
        alert_type LIKE ? COLLATE NOCASE OR severity LIKE ? COLLATE NOCASE OR
        message LIKE ? COLLATE NOCASE OR details_json LIKE ? COLLATE NOCASE OR
        IFNULL(group_id, '') LIKE ? COLLATE NOCASE OR
        IFNULL(CAST(soldier_id AS TEXT), '') LIKE ? OR
        IFNULL(record_origin, '') LIKE ? COLLATE NOCASE
      )`);
      for (let i = 0; i < 9; i++) params.push(needle);
    }
    return { where: conditions.join(' AND '), params };
  }

  private page(where: string, params: unknown[], limit: number, offset: number) {
    const conn = this.db.connection;
    const total = (
      conn.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE ${where}`).get(...bind(params)) as any
    ).n;
    const rows = conn
      .prepare(
        `SELECT * FROM alerts WHERE ${where} ORDER BY event_time DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...bind([...params, limit, offset])) as any[];
    return {
      items: rows.map((row) => this.alertToApi(row)),
      limit,
      offset,
      count: rows.length,
      total,
    };
  }

  private loadAlert(alertId: number) {
    const row = this.db.connection
      .prepare('SELECT * FROM alerts WHERE id = ?')
      .get(alertId) as any;
    if (row == null) throw new HttpException('alert not found', 404);
    return row;
  }

  @Get()
  list(@Query() q: any) {
    syncNoContact(this.db.connection);
    const { where, params } = this.filters(q);
    const limit = Math.min(Math.max(Number(q.limit || 50), 1), 500);
    const offset = Math.max(Number(q.offset || 0), 0);
    return this.page(where, params, limit, offset);
  }

  @Get('summary')
  summary(@Query() q: any) {
    syncNoContact(this.db.connection);
    const { where, params } = this.filters(q);
    const conn = this.db.connection;
    const total = (
      conn.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE ${where}`).get(...bind(params)) as any
    ).n;
    const timeline = conn
      .prepare(
        `SELECT substr(event_time, 1, 13) || ':00:00Z' AS time, COUNT(*) AS count
         FROM alerts WHERE ${where} GROUP BY time ORDER BY time`,
      )
      .all(...bind(params)) as any[];
    const bySeverity = conn
      .prepare(
        `SELECT severity, COUNT(*) AS count FROM alerts WHERE ${where}
         GROUP BY severity ORDER BY count DESC, severity`,
      )
      .all(...bind(params)) as any[];
    const byType = conn
      .prepare(
        `SELECT alert_type, COUNT(*) AS count FROM alerts WHERE ${where}
         GROUP BY alert_type ORDER BY count DESC, alert_type`,
      )
      .all(...bind(params)) as any[];
    return {
      total,
      timeline: timeline.map((r) => ({ time: r.time, count: r.count })),
      by_severity: bySeverity.map((r) => ({ severity: r.severity, count: r.count })),
      by_type: byType.map((r) => ({ alert_type: r.alert_type, count: r.count })),
    };
  }

  @Get('filters/options')
  filterOptions() {
    syncNoContact(this.db.connection);
    const options: Record<string, string[]> = {};
    for (const [key, column] of OPTION_COLUMNS) {
      const rows = this.db.connection
        .prepare(
          `SELECT DISTINCT ${column} AS value FROM alerts
           WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY value`,
        )
        .all() as any[];
      options[key] = rows.map((r) => r.value);
    }
    options.time_ranges = [...TIME_RANGES];
    return options;
  }

  @Get('export.csv')
  exportCsv(@Query() q: any, @Res() res: Response) {
    syncNoContact(this.db.connection);
    const { where, params } = this.filters(q);
    const rows = this.db.connection
      .prepare(`SELECT * FROM alerts WHERE ${where} ORDER BY event_time DESC, id DESC`)
      .all(...bind(params)) as any[];
    const columns = [...PUBLIC, 'details'];
    const csvCell = (value: unknown) => {
      const text = value == null ? '' : String(value);
      if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };
    const lines = [columns.join(',')];
    for (const row of rows) {
      const item = this.alertToApi(row);
      lines.push(
        columns
          .map((col) => {
            const val = col === 'details' ? JSON.stringify(item.details) : item[col];
            return csvCell(val);
          })
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="alerts.csv"');
    res.send('\ufeff' + lines.join('\n') + '\n');
  }

  @Get('sos')
  listSos(@Query('limit') limitRaw?: string, @Query('offset') offsetRaw?: string) {
    syncNoContact(this.db.connection);
    const limit = Math.min(Math.max(Number(limitRaw || 50), 1), 500);
    const offset = Math.max(Number(offsetRaw || 0), 0);
    return this.page(
      "alert_type = 'SOS' AND status IN ('ACTIVE', 'ACKNOWLEDGED')",
      [],
      limit,
      offset,
    );
  }

  @Get(':alertId')
  getOne(@Param('alertId', ParseIntPipe) alertId: number) {
    return this.alertToApi(this.loadAlert(alertId));
  }

  @Post(':alertId/acknowledge')
  @HttpCode(200)
  acknowledge(@Param('alertId', ParseIntPipe) alertId: number, @Body() body?: any) {
    const actor = body?.by || 'operator';
    const now = utcNow();
    const row = this.loadAlert(alertId);
    if (row.status === 'RESOLVED' || row.status === 'CLEARED') {
      throw new HttpException('alert is already closed', 409);
    }
    if (row.status === 'ACTIVE') {
      this.db.connection
        .prepare(
          `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...bind([now, actor, now, alertId]));
    }
    return this.alertToApi(this.loadAlert(alertId));
  }

  @Post(':alertId/resolve')
  @HttpCode(200)
  resolve(@Param('alertId', ParseIntPipe) alertId: number, @Body() body?: any) {
    const actor = body?.by || 'operator';
    const now = utcNow();
    const row = this.loadAlert(alertId);
    if (row.status === 'RESOLVED' || row.status === 'CLEARED') {
      throw new HttpException('alert is already closed', 409);
    }
    this.db.connection
      .prepare(
        `UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`,
      )
      .run(...bind([now, actor, now, alertId]));
    return this.alertToApi(this.loadAlert(alertId));
  }
}
