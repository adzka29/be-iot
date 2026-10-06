import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  ACTIONS,
  CATEGORIES,
  OUTCOMES,
  actorFromSession,
  auditTimeBound,
  displayLabel,
  insertAudit,
  normalizeAuditCode,
  sessionToken,
} from '../common/audit';
import { bind } from '../common/sql';

const TIME_RANGES: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  private filters(q: any): { where: string; params: unknown[] } {
    const conditions = ['1 = 1'];
    const params: unknown[] = [];
    if (q.timeRange) {
      if (!(q.timeRange in TIME_RANGES)) {
        throw new HttpException('unknown timeRange', 400);
      }
      const start = new Date(Date.now() - TIME_RANGES[q.timeRange]);
      conditions.push('timestamp >= ?');
      params.push(start.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    }
    if (q.from_time) {
      conditions.push('timestamp >= ?');
      params.push(auditTimeBound(q.from_time));
    }
    if (q.to_time) {
      conditions.push('timestamp <= ?');
      params.push(auditTimeBound(q.to_time));
    }
    const actionCode = normalizeAuditCode(q.action, ACTIONS, 'action');
    if (actionCode) {
      conditions.push('action = ?');
      params.push(actionCode);
    }
    const categoryCode = normalizeAuditCode(q.category, CATEGORIES, 'category');
    if (categoryCode) {
      conditions.push('category = ?');
      params.push(categoryCode);
    }
    const outcomeCode = normalizeAuditCode(q.outcome, OUTCOMES, 'outcome');
    if (outcomeCode) {
      conditions.push('outcome = ?');
      params.push(outcomeCode);
    }
    if (q.actor && String(q.actor).trim()) {
      conditions.push('actor_name LIKE ?');
      params.push(`%${String(q.actor).trim()}%`);
    }
    if (q.resource && String(q.resource).trim()) {
      conditions.push('target_type = ?');
      params.push(String(q.resource).trim().toUpperCase().replace(/ /g, '_'));
    }
    if (q.ip && String(q.ip).trim()) {
      conditions.push('ip_address = ?');
      params.push(String(q.ip).trim());
    }
    if (q.userId != null && q.userId !== '') {
      conditions.push('actor_id = ?');
      params.push(Number(q.userId));
    }
    if (q.search && String(q.search).trim()) {
      const needle = `%${String(q.search).trim()}%`;
      conditions.push(`(
        event_id LIKE ? OR event_type LIKE ? OR description LIKE ?
        OR IFNULL(actor_name, '') LIKE ? OR IFNULL(target_name, '') LIKE ?
      )`);
      params.push(needle, needle, needle, needle, needle);
    }
    return { where: conditions.join(' AND '), params };
  }

  private target(row: any) {
    if (row.target_id == null && row.target_name == null && row.target_type == null) {
      return null;
    }
    return {
      id: row.target_id,
      name: row.target_name,
      type: displayLabel(row.target_type),
    };
  }

  private actor(row: any) {
    return { id: row.actor_id, name: row.actor_name, role: row.actor_role };
  }

  private listItem(row: any) {
    return {
      eventId: row.event_id,
      timestamp: row.timestamp,
      event: displayLabel(row.event_type),
      category: displayLabel(row.category),
      actor: this.actor(row),
      target: this.target(row),
      action: displayLabel(row.action),
      outcome: displayLabel(row.outcome),
      description: row.description,
    };
  }

  private detail(row: any) {
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
    let target: { id: any; name: any; type: any } | null = null;
    if (row.target_id != null || row.target_name != null || row.target_type != null) {
      target = {
        id: row.target_id,
        name: row.target_name,
        type: row.target_type,
      };
    }
    return {
      eventId: row.event_id,
      timestamp: row.timestamp,
      actor: this.actor(row),
      actorType: row.actor_type,
      category: row.category,
      eventType: row.event_type,
      action: row.action,
      target,
      outcome: row.outcome,
      description: row.description,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      sessionId: row.session_id,
      metadata,
    };
  }

  @Get()
  list(@Query() q: any) {
    const { where, params } = this.filters(q);
    const page = Math.max(Number(q.page || 1), 1);
    const limit = Math.min(Math.max(Number(q.limit || 20), 1), 100);
    const conn = this.db.connection;
    const total = (
      conn.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where}`).get(...bind(params)) as any
    ).n;
    const rows = conn
      .prepare(
        `SELECT * FROM audit_logs WHERE ${where}
         ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...bind([...params, limit, (page - 1) * limit])) as any[];
    return {
      items: rows.map((r) => this.listItem(r)),
      total,
      page,
      limit,
    };
  }

  @Get('summary')
  summary() {
    const row = this.db.connection
      .prepare(
        `SELECT
          COUNT(*) AS total_activities,
          SUM(CASE WHEN actor_type = 'USER' THEN 1 ELSE 0 END) AS user_actions,
          SUM(CASE WHEN actor_type = 'SYSTEM' THEN 1 ELSE 0 END) AS system_actions,
          SUM(CASE WHEN outcome IN ('FAILED', 'DENIED') THEN 1 ELSE 0 END) AS failed_actions
         FROM audit_logs`,
      )
      .get() as any;
    return {
      total_activities: row.total_activities || 0,
      user_actions: row.user_actions || 0,
      system_actions: row.system_actions || 0,
      failed_actions: row.failed_actions || 0,
    };
  }

  @Get('categories')
  categories() {
    const counts: Record<string, number> = {};
    for (const row of this.db.connection
      .prepare('SELECT category, COUNT(*) AS n FROM audit_logs GROUP BY category')
      .all() as any[]) {
      counts[row.category] = row.n;
    }
    return {
      categories: CATEGORIES.map((code) => ({
        code,
        name: displayLabel(code),
        count: counts[code] || 0,
      })),
    };
  }

  @Get('export')
  export(@Query() q: any, @Res() res: Response) {
    const { where, params } = this.filters(q);
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM audit_logs WHERE ${where} ORDER BY timestamp DESC, id DESC`,
      )
      .all(...bind(params)) as any[];
    const items = rows.map((r) => this.listItem(r));
    const lines = [
      'Event ID,Timestamp,Actor,Role,Category,Action,Target,Outcome',
    ];
    for (const item of items) {
      lines.push(
        [
          item.eventId,
          item.timestamp,
          item.actor.name || '',
          item.actor.role || '',
          item.category || '',
          item.action || '',
          item.target == null ? '' : item.target.name || '',
          item.outcome || '',
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="activity-log.csv"',
    );
    res.send('\ufeff' + lines.join('\n') + '\n');
  }

  @Get('me')
  myLogs(@Req() request: Request, @Query() q: any) {
    const conn = this.db.connection;
    const actor = actorFromSession(conn, sessionToken(request));
    if (actor == null) throw new HttpException('authentication required', 401);
    const page = Math.max(Number(q.page || 1), 1);
    const limit = Math.min(Math.max(Number(q.limit || 20), 1), 100);
    const total = (
      conn
        .prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id = ?')
        .get(actor.id) as any
    ).n;
    const rows = conn
      .prepare(
        `SELECT * FROM audit_logs WHERE actor_id = ?
         ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(actor.id, limit, (page - 1) * limit) as any[];
    return {
      items: rows.map((r) => this.listItem(r)),
      total,
      page,
      limit,
    };
  }

  @Post()
  @HttpCode(201)
  ingest(@Body() body: any, @Req() request: Request) {
    const conn = this.db.connection;
    const actor = actorFromSession(conn, sessionToken(request));
    if (actor == null) throw new HttpException('authentication required', 401);
    const target = body.target ?? null;
    const eventId = insertAudit(conn, {
      actor,
      category: String(body.category || '')
        .trim()
        .toUpperCase()
        .replace(/ /g, '_'),
      event_type: String(body.event_type || '')
        .trim()
        .toUpperCase()
        .replace(/ /g, '_'),
      action: String(body.action || '')
        .trim()
        .toUpperCase()
        .replace(/ /g, '_'),
      target,
      outcome: String(body.outcome || 'SUCCESS')
        .trim()
        .toUpperCase(),
      description: body.description,
      request,
      metadata: body.metadata,
      session_id: sessionToken(request),
    });
    const row = conn
      .prepare('SELECT * FROM audit_logs WHERE event_id = ?')
      .get(eventId);
    return this.detail(row);
  }

  @Get(':eventId')
  detailById(@Param('eventId') eventId: string) {
    const row = this.db.connection
      .prepare('SELECT * FROM audit_logs WHERE event_id = ?')
      .get(eventId);
    if (row == null) throw new HttpException('audit log not found', 404);
    return this.detail(row);
  }

  @Delete(':eventId')
  deleteDisabled() {
    throw new HttpException('Method Not Allowed', 405);
  }
}
