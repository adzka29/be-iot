import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  displayName,
  effectiveAccess,
  getUser,
  isActiveBinding,
  loadBinding,
} from '../database/access';
import {
  actorForUser,
  actorFromSession,
  insertAudit,
  sessionToken,
} from '../common/audit';
import { TIME_RANGES, canonicalTime, timeRangeStart, utcNow } from '../common/records';
import { TicketRepository } from './tickets.repository';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const PRIORITY_FROM_SEVERITY: Record<string, string> = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  WARNING: 'HIGH',
  INFO: 'LOW',
};

type CurrentUser = {
  id: number;
  name: string;
  is_superadmin: boolean;
  row: any;
};

function title(alertType: string) {
  const parts = alertType
    .split('_')
    .map((part) => (part === 'SOS' ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()));
  return `${parts.join(' ')} Signal Received`;
}

@Injectable()
export class TicketsService {
  constructor(private readonly dbSvc: DatabaseService) {}

  private db() {
    return this.dbSvc.connection;
  }

  listTickets(request: Request, filters: any) {
    const conn = this.db();
    const user = this.reader(conn, request);
    const { where, params } = this.filters(user, filters);
    const repo = new TicketRepository(conn);
    const total = repo.countTickets(where, params);
    const rows = repo.listTickets(where, params, filters.limit, filters.offset);
    return {
      items: rows.map((row) => this.listItem(conn, row)),
      total,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  summary(request: Request, timeRange?: string) {
    const conn = this.db();
    const user = this.reader(conn, request);
    const { where, params } = this.filters(user, { time_range: timeRange });
    const repo = new TicketRepository(conn);
    const byStatus = repo.groupedCounts(where, params, 'status');
    const byPriority = repo.groupedCounts(where, params, 'priority');
    return {
      total: repo.countTickets(where, params),
      by_status: STATUSES.map((value) => ({ value, count: byStatus[value] || 0 })),
      by_priority: PRIORITIES.map((value) => ({
        value,
        count: byPriority[value] || 0,
      })),
    };
  }

  filterOptions(request: Request) {
    const conn = this.db();
    const user = this.reader(conn, request);
    const { where, params } = this.visibility(user);
    const repo = new TicketRepository(conn);
    return {
      statuses: [...STATUSES],
      priorities: [...PRIORITIES],
      alert_types: repo.visibleAlertTypes(where, params),
      groups: repo.visibleGroups(where, params),
      time_ranges: [...TIME_RANGES],
    };
  }

  detail(request: Request, ticketId: number) {
    const conn = this.db();
    const user = this.reader(conn, request);
    return this.detailPayload(conn, user, ticketId);
  }

  createFromAlert(request: Request, alertId: number) {
    const conn = this.db();
    const user = this.operator(conn, request);
    const repo = new TicketRepository(conn);
    const alert = repo.getAlert(alertId);
    if (alert == null) throw new HttpException('alert not found', 404);
    if (alert.status === 'RESOLVED' || alert.status === 'CLEARED') {
      throw new HttpException('alert is already closed', 409);
    }
    if (repo.ticketForAlert(alertId) != null) {
      throw new HttpException('alert already has a ticket', 409);
    }
    const now = utcNow();
    const priority = PRIORITY_FROM_SEVERITY[alert.severity] || 'HIGH';
    let ticketId: number;
    try {
      ticketId = repo.insertTicket({
        ticket_code: repo.nextCode(now),
        source_alert_id: alertId,
        status: 'OPEN',
        priority,
        created_by: user.id,
        assignee_id: null,
        response_plan: null,
        created_at: now,
        updated_at: now,
        started_at: null,
        resolved_at: null,
        closed_at: null,
      });
    } catch (exc: any) {
      if (/UNIQUE/i.test(String(exc?.message))) {
        throw new HttpException('alert already has a ticket', 409);
      }
      throw exc;
    }
    if (alert.status === 'ACTIVE') {
      repo.acknowledgeAlert(alertId, user.name, now);
    }
    const ticket = repo.getTicket(ticketId);
    this.audit(conn, user, request, {
      event_type: 'TICKET_CREATED',
      action: 'CREATE',
      ticket,
      description: 'Created a ticket from an alert.',
      metadata: { alert_id: alertId, alert_code: alert.alert_code },
    });
    return this.detailPayload(conn, user, ticketId);
  }

  updateTicket(request: Request, ticketId: number, body: any) {
    const allowedKeys = new Set(['response_plan', 'priority']);
    const extra = Object.keys(body || {}).filter((key) => !allowedKeys.has(key));
    if (extra.length) {
      throw new HttpException(`unexpected fields: ${extra.sort().join(', ')}`, 422);
    }
    const fields = { ...body };
    // only known keys
    const allowed: Record<string, unknown> = {};
    if ('response_plan' in fields) allowed.response_plan = fields.response_plan;
    if ('priority' in fields) allowed.priority = fields.priority;
    if (!Object.keys(allowed).length) {
      throw new HttpException('no ticket changes', 422);
    }
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    this.requireManager(user, ticket);
    const changes: Record<string, unknown> = {};
    if ('response_plan' in allowed) {
      const plan = String(allowed.response_plan ?? '').trim();
      changes.response_plan = plan || null;
    }
    if ('priority' in allowed && allowed.priority != null) {
      changes.priority = allowed.priority;
    }
    if (
      !Object.keys(changes).length ||
      Object.entries(changes).every(([c, v]) => ticket[c] === v)
    ) {
      throw new HttpException('no ticket changes', 422);
    }
    changes.updated_at = utcNow();
    const repo = new TicketRepository(conn);
    repo.updateTicket(ticketId, changes);
    const updated = repo.getTicket(ticketId);
    this.audit(conn, user, request, {
      event_type: 'TICKET_UPDATED',
      action: 'UPDATE',
      ticket: updated,
      description: 'Updated ticket details.',
      metadata: Object.fromEntries(
        Object.entries(changes).filter(([k]) => k !== 'updated_at'),
      ),
    });
    return this.detailPayload(conn, user, ticketId);
  }

  assign(request: Request, ticketId: number, userId: number) {
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    this.requireManager(user, ticket);
    if (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') {
      throw new HttpException('closed ticket cannot be assigned', 409);
    }
    const assignee = this.assignableUser(conn, userId);
    if (ticket.assignee_id === assignee.id) {
      return this.detailPayload(conn, user, ticketId);
    }
    const now = utcNow();
    new TicketRepository(conn).updateTicket(ticketId, {
      assignee_id: assignee.id,
      updated_at: now,
    });
    const updated = new TicketRepository(conn).getTicket(ticketId);
    this.audit(conn, user, request, {
      event_type: 'TICKET_ASSIGNED',
      action: 'ASSIGN',
      ticket: updated,
      description: 'Assigned the ticket.',
      metadata: { assignee_id: assignee.id, assignee: assignee.username },
    });
    return this.detailPayload(conn, user, ticketId);
  }

  startWorking(request: Request, ticketId: number) {
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    const repo = new TicketRepository(conn);
    if (ticket.status === 'WAITING') {
      this.requireAssignee(user, ticket);
      repo.updateTicket(ticketId, { status: 'IN_PROGRESS', updated_at: utcNow() });
    } else if (ticket.status === 'OPEN') {
      if (ticket.assignee_id != null && ticket.assignee_id !== user.id) {
        throw new HttpException('ticket is assigned to someone else', 403);
      }
      const now = utcNow();
      repo.updateTicket(ticketId, {
        assignee_id: user.id,
        status: 'IN_PROGRESS',
        started_at: ticket.started_at || now,
        updated_at: now,
      });
    } else {
      throw new HttpException('ticket cannot be started', 409);
    }
    const updated = repo.getTicket(ticketId);
    this.audit(conn, user, request, {
      event_type: 'TICKET_STARTED',
      action: 'UPDATE',
      ticket: updated,
      description: 'Started working on the ticket.',
    });
    return this.detailPayload(conn, user, ticketId);
  }

  markWaiting(request: Request, ticketId: number) {
    return this.transition(request, ticketId, {
      allowed: new Set(['IN_PROGRESS']),
      status: 'WAITING',
      event_type: 'TICKET_WAITING',
      description: 'Marked the ticket as waiting.',
      rejected: 'ticket must be in progress',
    });
  }

  resolve(request: Request, ticketId: number) {
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    this.requireAssignee(user, ticket);
    if (ticket.status !== 'IN_PROGRESS' && ticket.status !== 'WAITING') {
      throw new HttpException('ticket must be in progress or waiting', 409);
    }
    const now = utcNow();
    const repo = new TicketRepository(conn);
    repo.updateTicket(ticketId, {
      status: 'RESOLVED',
      resolved_at: now,
      updated_at: now,
    });
    repo.resolveAlert(ticket.source_alert_id, user.name, now);
    const updated = repo.getTicket(ticketId);
    this.audit(conn, user, request, {
      event_type: 'TICKET_RESOLVED',
      action: 'UPDATE',
      ticket: updated,
      description: 'Resolved the ticket and its source alert.',
    });
    return this.detailPayload(conn, user, ticketId);
  }

  close(request: Request, ticketId: number) {
    return this.transition(request, ticketId, {
      allowed: new Set(['RESOLVED']),
      status: 'CLOSED',
      event_type: 'TICKET_CLOSED',
      description: 'Closed the ticket.',
      rejected: 'ticket must be resolved before it can be closed',
      stamp: 'closed_at',
    });
  }

  addCollaborator(request: Request, ticketId: number, userId: number) {
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    const repo = new TicketRepository(conn);
    this.requireAccess(user, ticket, repo.collaborators(ticketId));
    const target = this.assignableUser(conn, userId);
    if (target.id === ticket.created_by) {
      throw new HttpException('creator cannot be a collaborator', 409);
    }
    if (target.id === ticket.assignee_id) {
      throw new HttpException('assignee cannot be a collaborator', 409);
    }
    if (repo.getCollaborator(ticketId, target.id) != null) {
      throw new HttpException('user is already a collaborator', 409);
    }
    const now = utcNow();
    repo.addCollaborator(ticketId, target.id, user.id, now);
    repo.updateTicket(ticketId, { updated_at: now });
    this.audit(conn, user, request, {
      event_type: 'COLLABORATOR_ADDED',
      action: 'ASSIGN',
      ticket: repo.getTicket(ticketId),
      description: 'Added a ticket collaborator.',
      metadata: { user_id: target.id, username: target.username },
    });
    return this.detailPayload(conn, user, ticketId);
  }

  removeCollaborator(request: Request, ticketId: number, userId: number) {
    const conn = this.db();
    const user = this.operator(conn, request);
    this.visibleRow(conn, user, ticketId);
    const repo = new TicketRepository(conn);
    if (repo.getCollaborator(ticketId, userId) == null) {
      throw new HttpException('collaborator not found', 404);
    }
    const now = utcNow();
    repo.removeCollaborator(ticketId, userId);
    repo.updateTicket(ticketId, { updated_at: now });
    this.audit(conn, user, request, {
      event_type: 'COLLABORATOR_REMOVED',
      action: 'DELETE',
      ticket: repo.getTicket(ticketId),
      description: 'Removed a ticket collaborator.',
      metadata: { user_id: userId },
    });
    return this.detailPayload(conn, user, ticketId);
  }

  addTask(request: Request, ticketId: number, body: any) {
    const titleText = String(body.title || '').trim();
    if (!titleText) throw new HttpException('title is required', 422);
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    this.requireManager(user, ticket);
    if (body.assignee_id != null) {
      this.requireParticipant(conn, ticket, body.assignee_id);
    }
    const now = utcNow();
    const description =
      body.description == null
        ? null
        : String(body.description).trim() || null;
    const repo = new TicketRepository(conn);
    const taskId = repo.insertTask({
      ticket_id: ticketId,
      title: titleText,
      description,
      assignee_id: body.assignee_id ?? null,
      priority: body.priority || 'MEDIUM',
      status: 'TODO',
      created_by: user.id,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
    repo.updateTicket(ticketId, { updated_at: now });
    this.audit(conn, user, request, {
      event_type: 'TASK_CREATED',
      action: 'CREATE',
      ticket: repo.getTicket(ticketId),
      description: 'Added a ticket task.',
      metadata: { task_id: taskId, title: titleText },
    });
    return this.task(conn, repo.getTask(ticketId, taskId));
  }

  updateTask(request: Request, ticketId: number, taskId: number, body: any) {
    const fields = { ...body };
    if (!Object.keys(fields).length) {
      throw new HttpException('no task changes', 422);
    }
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    const repo = new TicketRepository(conn);
    const task = repo.getTask(ticketId, taskId);
    if (task == null) throw new HttpException('task not found', 404);
    const manages = this.manages(user, ticket);
    const ownsTask = task.assignee_id === user.id;
    if (!manages && !ownsTask) {
      throw new HttpException('not allowed to update this task', 403);
    }
    if (!manages && 'assignee_id' in fields) {
      throw new HttpException('not allowed to reassign this task', 403);
    }
    const changes: Record<string, unknown> = {};
    if ('title' in fields) {
      const t = String(fields.title || '').trim();
      if (!t) throw new HttpException('title is required', 422);
      changes.title = t;
    }
    if ('description' in fields) {
      changes.description =
        fields.description == null
          ? null
          : String(fields.description).trim() || null;
    }
    if ('priority' in fields && fields.priority != null) {
      changes.priority = fields.priority;
    }
    if ('assignee_id' in fields) {
      if (fields.assignee_id != null) {
        this.requireParticipant(conn, ticket, fields.assignee_id);
      }
      changes.assignee_id = fields.assignee_id;
    }
    if ('status' in fields && fields.status != null) {
      changes.status = fields.status;
      changes.completed_at = fields.status === 'DONE' ? utcNow() : null;
    }
    if (!Object.keys(changes).length) {
      throw new HttpException('no task changes', 422);
    }
    changes.updated_at = utcNow();
    repo.updateTask(taskId, changes);
    repo.updateTicket(ticketId, { updated_at: changes.updated_at as string });
    this.audit(conn, user, request, {
      event_type: 'TASK_UPDATED',
      action: 'UPDATE',
      ticket: repo.getTicket(ticketId),
      description: 'Updated a ticket task.',
      metadata: { task_id: taskId, status: changes.status },
    });
    return this.task(conn, repo.getTask(ticketId, taskId));
  }

  addUpdate(request: Request, ticketId: number, body: any) {
    const allowedKeys = new Set(['message']);
    const extra = Object.keys(body || {}).filter((key) => !allowedKeys.has(key));
    if (extra.length) {
      throw new HttpException(`unexpected fields: ${extra.sort().join(', ')}`, 422);
    }
    const text = String(body?.message || '').trim();
    if (!text) throw new HttpException('message is required', 422);
    const conn = this.db();
    const user = this.operator(conn, request);
    this.visibleRow(conn, user, ticketId);
    const now = utcNow();
    const repo = new TicketRepository(conn);
    const updateId = repo.insertUpdate(ticketId, user.id, text, now);
    repo.updateTicket(ticketId, { updated_at: now });
    this.audit(conn, user, request, {
      event_type: 'TICKET_UPDATE_POSTED',
      action: 'CREATE',
      ticket: repo.getTicket(ticketId),
      description: 'Posted a ticket update.',
      metadata: { update_id: updateId },
    });
    return {
      id: updateId,
      message: text,
      created_at: now,
      author: this.person(conn, user.id),
    };
  }

  private transition(
    request: Request,
    ticketId: number,
    opts: {
      allowed: Set<string>;
      status: string;
      event_type: string;
      description: string;
      rejected: string;
      stamp?: string;
    },
  ) {
    const conn = this.db();
    const user = this.operator(conn, request);
    const ticket = this.visibleRow(conn, user, ticketId);
    this.requireAssignee(user, ticket);
    if (!opts.allowed.has(ticket.status)) {
      throw new HttpException(opts.rejected, 409);
    }
    const now = utcNow();
    const fields: Record<string, unknown> = {
      status: opts.status,
      updated_at: now,
    };
    if (opts.stamp) fields[opts.stamp] = now;
    new TicketRepository(conn).updateTicket(ticketId, fields);
    const updated = new TicketRepository(conn).getTicket(ticketId);
    this.audit(conn, user, request, {
      event_type: opts.event_type,
      action: 'UPDATE',
      ticket: updated,
      description: opts.description,
    });
    return this.detailPayload(conn, user, ticketId);
  }

  private filters(user: CurrentUser, filters: any) {
    const { where, params } = this.visibility(user);
    const conditions = [where];
    for (const [name, column] of [
      ['status', 't.status'],
      ['priority', 't.priority'],
      ['alert_type', 'a.alert_type'],
    ] as const) {
      const values = this.codes(
        filters[name],
        name === 'status' ? STATUSES : name === 'priority' ? PRIORITIES : null,
        name,
      );
      if (values.length) {
        conditions.push(`${column} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      }
    }
    const groups = (filters.group_id || [])
      .map((v: string) => String(v).trim())
      .filter(Boolean);
    if (groups.length) {
      conditions.push(
        `(${groups.map(() => 'a.group_id = ? COLLATE NOCASE').join(' OR ')})`,
      );
      params.push(...groups);
    }
    const rangeStart = this.rangeStart(filters.time_range ?? filters.timeRange);
    if (rangeStart) {
      conditions.push('t.created_at >= ?');
      params.push(rangeStart);
    }
    if (filters.from_time) {
      conditions.push('t.created_at >= ?');
      params.push(this.time(filters.from_time));
    }
    if (filters.to_time) {
      conditions.push('t.created_at <= ?');
      params.push(this.time(filters.to_time));
    }
    const query = String(filters.q || '').trim();
    if (query) {
      const needle = `%${query}%`;
      conditions.push(`(
        t.ticket_code LIKE ? COLLATE NOCASE OR
        a.alert_code LIKE ? COLLATE NOCASE OR
        a.alert_type LIKE ? COLLATE NOCASE OR
        a.message LIKE ? COLLATE NOCASE OR
        IFNULL(a.group_id, '') LIKE ? COLLATE NOCASE OR
        IFNULL(CAST(a.soldier_id AS TEXT), '') LIKE ?
      )`);
      for (let i = 0; i < 6; i++) params.push(needle);
    }
    return { where: conditions.join(' AND '), params };
  }

  private codes(
    values: string[] | undefined,
    allowed: readonly string[] | null,
    label: string,
  ) {
    const chosen: string[] = [];
    for (const value of values || []) {
      const text = String(value).trim().toUpperCase();
      if (!text) continue;
      if (allowed != null && !(allowed as readonly string[]).includes(text)) {
        throw new HttpException(`unknown ${label}`, 400);
      }
      chosen.push(text);
    }
    return chosen;
  }

  private time(value: string) {
    try {
      return canonicalTime(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private rangeStart(value?: string | null) {
    try {
      return timeRangeStart(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private visibility(user: CurrentUser): { where: string; params: unknown[] } {
    if (user.is_superadmin) return { where: '1 = 1', params: [] };
    return {
      where: `(
        t.created_by = ? OR t.assignee_id = ? OR EXISTS (
          SELECT 1 FROM ticket_collaborators c
          WHERE c.ticket_id = t.id AND c.user_id = ?
        )
      )`,
      params: [user.id, user.id, user.id],
    };
  }

  private reader(conn: any, request: Request): CurrentUser {
    const actor = actorFromSession(conn, sessionToken(request));
    if (actor == null) throw new HttpException('authentication required', 401);
    const row = getUser(conn, actor.id!);
    if (row == null) throw new HttpException('authentication required', 401);
    const access = effectiveAccess(conn, row.id);
    const role = access == null ? null : access.role;
    return {
      id: row.id,
      name: row.name,
      is_superadmin: role === 'superadmin',
      row,
    };
  }

  private operator(conn: any, request: Request): CurrentUser {
    const user = this.reader(conn, request);
    const row = user.row;
    if (row.identity_type !== 'HUMAN') {
      throw new HttpException('account is not human', 403);
    }
    if (row.verification !== 'VERIFIED') {
      throw new HttpException('account is not verified', 403);
    }
    if (row.status !== 'ACTIVE') {
      throw new HttpException('account is not active', 403);
    }
    if (!isActiveBinding(loadBinding(conn, user.id), utcNow())) {
      throw new HttpException('account is not active', 403);
    }
    return user;
  }

  private assignableUser(conn: any, userId: number) {
    const row = getUser(conn, userId);
    if (row == null) throw new HttpException('user not found', 404);
    if (
      row.identity_type !== 'HUMAN' ||
      row.verification !== 'VERIFIED' ||
      row.status !== 'ACTIVE'
    ) {
      throw new HttpException('user is not active', 409);
    }
    if (!isActiveBinding(loadBinding(conn, row.id), utcNow())) {
      throw new HttpException('user is not active', 409);
    }
    return row;
  }

  private visibleRow(conn: any, user: CurrentUser, ticketId: number) {
    const ticket = new TicketRepository(conn).getTicket(ticketId);
    if (ticket == null) throw new HttpException('ticket not found', 404);
    const collaborators = new TicketRepository(conn).collaborators(ticketId);
    if (!this.canSee(user, ticket, collaborators)) {
      throw new HttpException('ticket not found', 404);
    }
    return ticket;
  }

  private canSee(user: CurrentUser, ticket: any, collaborators: any[]) {
    if (user.is_superadmin) return true;
    if (ticket.created_by === user.id || ticket.assignee_id === user.id) return true;
    return collaborators.some((row) => row.user_id === user.id);
  }

  private requireAssignee(user: CurrentUser, ticket: any) {
    if (ticket.assignee_id !== user.id) {
      throw new HttpException('only the assignee can do this', 403);
    }
  }

  private manages(user: CurrentUser, ticket: any) {
    return (
      user.is_superadmin ||
      ticket.created_by === user.id ||
      ticket.assignee_id === user.id
    );
  }

  private requireManager(user: CurrentUser, ticket: any) {
    if (!this.manages(user, ticket)) {
      throw new HttpException('not allowed to manage this ticket', 403);
    }
  }

  private requireAccess(user: CurrentUser, ticket: any, collaborators: any[]) {
    if (!this.canSee(user, ticket, collaborators)) {
      throw new HttpException('ticket not found', 404);
    }
  }

  private requireParticipant(conn: any, ticket: any, userId: number) {
    const collaborators = new TicketRepository(conn).collaborators(ticket.id);
    const allowed = new Set<number | null>([
      ticket.created_by,
      ticket.assignee_id,
      ...collaborators.map((r: any) => r.user_id),
    ]);
    allowed.delete(null);
    if (!allowed.has(userId)) {
      throw new HttpException('assignee is not a ticket participant', 409);
    }
  }

  private detailPayload(conn: any, user: CurrentUser, ticketId: number) {
    const ticket = this.visibleRow(conn, user, ticketId);
    const repo = new TicketRepository(conn);
    return {
      id: ticket.id,
      ticket_code: ticket.ticket_code,
      status: ticket.status,
      priority: ticket.priority,
      source_alert: this.sourceAlert(ticket),
      created_by: this.person(conn, ticket.created_by),
      assignee: this.person(conn, ticket.assignee_id),
      collaborators: repo
        .collaborators(ticket.id)
        .map((row) => this.person(conn, row.user_id)),
      response_plan: ticket.response_plan,
      tasks: repo.tasks(ticket.id).map((row) => this.task(conn, row)),
      updates: repo.updates(ticket.id).map((row) => ({
        id: row.id,
        message: row.message,
        created_at: row.created_at,
        author: this.person(conn, row.author_id),
      })),
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      started_at: ticket.started_at,
      resolved_at: ticket.resolved_at,
      closed_at: ticket.closed_at,
    };
  }

  private listItem(conn: any, ticket: any) {
    return {
      id: ticket.id,
      ticket_code: ticket.ticket_code,
      source_alert_id: ticket.source_alert_id,
      source_alert_code: ticket.alert_code,
      alert_type: ticket.alert_type,
      title: title(ticket.alert_type),
      description: ticket.message,
      soldier_id: ticket.soldier_id,
      group_id: ticket.group_id,
      priority: ticket.priority,
      status: ticket.status,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      assignee: this.person(conn, ticket.assignee_id),
      created_by: this.person(conn, ticket.created_by),
    };
  }

  private sourceAlert(ticket: any) {
    return {
      id: ticket.source_alert_id,
      alert_code: ticket.alert_code,
      type: ticket.alert_type,
      severity: ticket.alert_severity,
      status: ticket.alert_status,
      soldier_id: ticket.soldier_id,
      group_id: ticket.group_id,
      event_time: ticket.event_time,
      position_source: ticket.position_source,
      latitude: ticket.latitude,
      longitude: ticket.longitude,
    };
  }

  private task(conn: any, task: any) {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      assignee: this.person(conn, task.assignee_id),
      priority: task.priority,
      status: task.status,
      created_by: this.person(conn, task.created_by),
      created_at: task.created_at,
      updated_at: task.updated_at,
      completed_at: task.completed_at,
    };
  }

  private person(conn: any, userId: number | null) {
    if (userId == null) return null;
    const row = conn
      .prepare('SELECT id, name, username FROM users WHERE id = ?')
      .get(userId) as any;
    if (row == null) return null;
    const access = effectiveAccess(conn, row.id);
    const role =
      access && access.role ? displayName(access.role) : null;
    return {
      id: row.id,
      full_name: row.name,
      username: row.username,
      role,
    };
  }

  private audit(
    conn: any,
    user: CurrentUser,
    request: Request,
    opts: {
      event_type: string;
      action: string;
      ticket: any;
      description: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    insertAudit(conn, {
      actor: actorForUser(conn, user.row),
      category: 'TICKETS',
      event_type: opts.event_type,
      action: opts.action,
      target: {
        id: opts.ticket.id,
        name: opts.ticket.ticket_code,
        type: 'TICKET',
      },
      description: opts.description,
      request,
      metadata: opts.metadata,
    });
  }
}
