import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  effectiveAccess,
  getUser,
  hasPermission,
  isActiveBinding,
  loadBinding,
} from '../database/access';
import {
  actorForUser,
  actorFromSession,
  insertAudit,
  sessionToken,
} from '../common/audit';
import { canonicalTime, utcNow } from '../common/records';
import { OperationRepository, positionOf } from './operations.repository';
import { normalizeSoldierId } from '../database/personnel';

const STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
const DELETABLE = new Set(['PLANNING', 'COMPLETED', 'CANCELLED']);

@Injectable()
export class OperationsService {
  constructor(private readonly dbSvc: DatabaseService) {}

  private db() {
    return this.dbSvc.connection;
  }

  listOperations(request: Request, filters: any) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    repo.syncGroups();
    const { where, params } = this.filters(filters);
    const total = repo.countOperations(where, params);
    const offset = (filters.page - 1) * filters.limit;
    const rows = repo.listOperations(where, params, filters.limit, offset);
    return {
      items: rows.map((row) => this.listItem(repo, row)),
      page: filters.page,
      limit: filters.limit,
      total,
    };
  }

  summary(request: Request) {
    const conn = this.db();
    this.reader(conn, request);
    const counts = new OperationRepository(conn).statusCounts();
    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      planning: counts.PLANNING || 0,
      active: counts.ACTIVE || 0,
      on_hold: counts.ON_HOLD || 0,
      completed: counts.COMPLETED || 0,
      cancelled: counts.CANCELLED || 0,
    };
  }

  filterOptions(request: Request) {
    const conn = this.db();
    this.reader(conn, request);
    const groups = new OperationRepository(conn).groups();
    return {
      statuses: [...STATUSES],
      groups: groups.map((row) => ({ id: row.id, name: row.name })),
    };
  }

  groupOptions(request: Request) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    return { items: repo.groups().map((row) => this.groupChoice(repo, row)) };
  }

  personnelOptions(request: Request, q?: string) {
    const conn = this.db();
    this.reader(conn, request);
    return { items: new OperationRepository(conn).personnelOptions(q) };
  }

  create(request: Request, body: any) {
    const allowed = new Set([
      'name',
      'description',
      'start_at',
      'end_at',
      'type',
      'group_ids',
      'groups',
      'geofence_ids',
      'new_geofences',
    ]);
    const extra = Object.keys(body || {}).filter((key) => !allowed.has(key));
    if (extra.length) {
      throw new HttpException(`unexpected fields: ${extra.sort().join(', ')}`, 422);
    }
    const name = this.name(body.name);
    if (name.length > 160) throw new HttpException('name is too long', 422);
    const description = this.optional(body.description);
    if (description && description.length > 2000) {
      throw new HttpException('description is too long', 422);
    }
    const opType = this.optional(body.type);
    const [startAt, endAt] = this.window(body.start_at, body.end_at);
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);

    const run = conn.transaction(() => {
      const existingGroupIds = this.resolveGroups(repo, body.group_ids || []);
      const createdGroupIds: number[] = [];
      for (const g of body.groups || []) {
        createdGroupIds.push(this.createInlineGroup(repo, g));
      }
      const existingGeofenceIds = this.resolveGeofences(repo, body.geofence_ids || []);
      const createdGeofenceIds: number[] = [];
      for (const fence of body.new_geofences || []) {
        createdGeofenceIds.push(this.createInlineGeofence(repo, fence));
      }
      const now = utcNow();
      const operationId = repo.insertOperation({
        operation_code: repo.nextCode(now),
        name,
        description,
        type: opType,
        status: 'PLANNING',
        start_at: startAt,
        end_at: endAt,
        created_by: user.id,
        created_at: now,
        updated_at: now,
        completed_at: null,
        deleted_at: null,
      });
      for (const groupId of [...existingGroupIds, ...createdGroupIds]) {
        if (!repo.hasGroup(operationId, groupId)) repo.linkGroup(operationId, groupId);
      }
      for (const geofenceId of [...existingGeofenceIds, ...createdGeofenceIds]) {
        if (!repo.hasGeofence(operationId, geofenceId)) {
          repo.linkGeofence(operationId, geofenceId);
        }
      }
      return operationId;
    });

    const operationId = run();
    const operation = repo.getOperation(operationId);
    this.audit(conn, user, request, operation, 'OPERATION_CREATED', 'CREATE', 'Created an operation.');
    return this.detailPayload(conn, repo, operation);
  }

  detail(request: Request, operationId: number) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    return this.detailPayload(conn, repo, this.operation(repo, operationId));
  }

  update(request: Request, operationId: number, body: any) {
    const allowed = new Set([
      'name',
      'description',
      'start_at',
      'end_at',
      'type',
      'group_ids',
      'geofence_ids',
    ]);
    const extra = Object.keys(body || {}).filter((key) => !allowed.has(key));
    if (extra.length) {
      throw new HttpException(`unexpected fields: ${extra.sort().join(', ')}`, 422);
    }
    const fields = { ...body };
    if (!Object.keys(fields).length) {
      throw new HttpException('no operation changes', 422);
    }
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    const changes: Record<string, unknown> = {};
    let startAt = fields.start_at ?? operation.start_at;
    let endAt = fields.end_at ?? operation.end_at;
    if ('start_at' in fields || 'end_at' in fields) {
      [startAt, endAt] = this.window(startAt, endAt);
      changes.start_at = startAt;
      changes.end_at = endAt;
    }
    if ('name' in fields) changes.name = this.name(fields.name);
    if ('description' in fields) changes.description = this.optional(fields.description);
    if ('type' in fields) changes.type = this.optional(fields.type);
    if ('group_ids' in fields) {
      const previous = repo.linkedGroups(operationId).map((row) => row.id as number);
      const next = this.resolveGroups(repo, fields.group_ids || []);
      repo.replaceGroups(operationId, next);
      for (const groupId of previous) {
        if (!next.includes(groupId) && repo.operationLinkCount(groupId) === 0) {
          repo.deactivateGroup(groupId);
        }
      }
    }
    if ('geofence_ids' in fields) {
      repo.replaceGeofences(
        operationId,
        this.resolveGeofences(repo, fields.geofence_ids || []),
      );
    }
    if (
      !Object.keys(changes).length &&
      !('group_ids' in fields) &&
      !('geofence_ids' in fields)
    ) {
      throw new HttpException('no operation changes', 422);
    }
    changes.updated_at = utcNow();
    repo.updateOperation(operationId, changes);
    const updated = repo.getOperation(operationId);
    this.audit(conn, user, request, updated, 'OPERATION_UPDATED', 'UPDATE', 'Updated an operation.');
    return this.detailPayload(conn, repo, updated);
  }

  delete(request: Request, operationId: number) {
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    if (!DELETABLE.has(operation.status)) {
      throw new HttpException(
        'Active/on-hold operations cannot be deleted; complete or cancel them first.',
        409,
      );
    }
    const linkedGroupIds = repo.linkedGroups(operationId).map((row) => row.id as number);
    const now = utcNow();
    repo.updateOperation(operationId, { deleted_at: now, updated_at: now });
    // Soft-deleted ops no longer count as links — retire orphan groups and
    // clear their names from Explorer/Alerts (GROUP column).
    for (const groupId of linkedGroupIds) {
      if (repo.operationLinkCount(groupId) === 0) {
        repo.deactivateGroup(groupId);
      }
    }
    this.audit(conn, user, request, operation, 'OPERATION_DELETED', 'DELETE', 'Deleted an operation.');
  }

  activate(request: Request, operationId: number) {
    return this.transition(request, operationId, new Set(['PLANNING']), 'ACTIVE', 'OPERATION_ACTIVATED', 'Activated an operation.');
  }

  hold(request: Request, operationId: number) {
    return this.transition(request, operationId, new Set(['ACTIVE']), 'ON_HOLD', 'OPERATION_HELD', 'Put an operation on hold.');
  }

  resume(request: Request, operationId: number) {
    return this.transition(request, operationId, new Set(['ON_HOLD']), 'ACTIVE', 'OPERATION_RESUMED', 'Resumed an operation.');
  }

  complete(request: Request, operationId: number) {
    return this.transition(
      request,
      operationId,
      new Set(['ACTIVE', 'ON_HOLD']),
      'COMPLETED',
      'OPERATION_COMPLETED',
      'Completed an operation.',
      'completed_at',
    );
  }

  cancel(request: Request, operationId: number) {
    return this.transition(
      request,
      operationId,
      new Set(['PLANNING', 'ACTIVE', 'ON_HOLD']),
      'CANCELLED',
      'OPERATION_CANCELLED',
      'Cancelled an operation.',
    );
  }

  addGroup(request: Request, operationId: number, body: any) {
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    let groupId: number;
    if (body?.group_id != null && body.group_id !== '') {
      groupId = Number(body.group_id);
      if (repo.getGroup(groupId) == null) {
        throw new HttpException('group not found', 404);
      }
    } else if (body?.name && Array.isArray(body.member_soldier_ids)) {
      groupId = this.createInlineGroup(repo, body);
    } else {
      throw new HttpException('group_id or new group payload required', 422);
    }
    if (repo.hasGroup(operationId, groupId)) {
      throw new HttpException('group is already assigned', 409);
    }
    repo.linkGroup(operationId, groupId);
    repo.updateOperation(operationId, { updated_at: utcNow() });
    this.audit(conn, user, request, operation, 'OPERATION_GROUP_ADDED', 'ASSIGN', 'Assigned a group to an operation.', {
      group_id: groupId,
    });
    return this.detailPayload(conn, repo, repo.getOperation(operationId));
  }

  removeGroup(request: Request, operationId: number, groupId: number) {
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    if (repo.unlinkGroup(operationId, groupId) === 0) {
      throw new HttpException('group is not assigned', 404);
    }
    // If no other live operation uses this group, retire it so picker/detail
    // no longer show a dangling group field after remove.
    if (repo.operationLinkCount(groupId) === 0) {
      repo.deactivateGroup(groupId);
    }
    repo.updateOperation(operationId, { updated_at: utcNow() });
    this.audit(conn, user, request, operation, 'OPERATION_GROUP_REMOVED', 'DELETE', 'Removed a group from an operation.', {
      group_id: groupId,
    });
    return this.detailPayload(conn, repo, repo.getOperation(operationId));
  }

  addGeofence(request: Request, operationId: number, body: any) {
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    let geofenceId: number;
    if (body?.geofence_id != null && body.geofence_id !== '') {
      geofenceId = Number(body.geofence_id);
      if (repo.getGeofence(geofenceId) == null) {
        throw new HttpException('geofence not found', 404);
      }
    } else if (body?.name) {
      geofenceId = this.createInlineGeofence(repo, body);
    } else {
      throw new HttpException('geofence_id or new geofence payload required', 422);
    }
    if (repo.hasGeofence(operationId, geofenceId)) {
      throw new HttpException('geofence is already assigned', 409);
    }
    repo.linkGeofence(operationId, geofenceId);
    repo.updateOperation(operationId, { updated_at: utcNow() });
    this.audit(conn, user, request, operation, 'OPERATION_GEOFENCE_ADDED', 'ASSIGN', 'Assigned a geofence to an operation.', {
      geofence_id: geofenceId,
    });
    return this.detailPayload(conn, repo, repo.getOperation(operationId));
  }

  removeGeofence(request: Request, operationId: number, geofenceId: number) {
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    if (repo.unlinkGeofence(operationId, geofenceId) === 0) {
      throw new HttpException('geofence is not assigned', 404);
    }
    repo.updateOperation(operationId, { updated_at: utcNow() });
    this.audit(conn, user, request, operation, 'OPERATION_GEOFENCE_REMOVED', 'DELETE', 'Removed a geofence from an operation.', {
      geofence_id: geofenceId,
    });
    return this.detailPayload(conn, repo, repo.getOperation(operationId));
  }

  groups(request: Request, operationId: number) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    this.operation(repo, operationId);
    return {
      items: repo.linkedGroups(operationId).map((row) => this.groupItem(repo, row)),
    };
  }

  personnel(request: Request, operationId: number) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    this.operation(repo, operationId);
    return { items: this.personnelList(repo, operationId) };
  }

  mapView(request: Request, operationId: number) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    const groups = repo.linkedGroups(operationId);
    const people = this.personnelList(repo, operationId);
    const positions = people.map((person) => {
      const [lat, lon, eventTime] = positionOf(
        repo.latestPosition(person.soldier_id, person.group_name),
      );
      return { ...person, latitude: lat, longitude: lon, event_time: eventTime };
    });
    return {
      operation: { id: operation.id, name: operation.name },
      groups: groups.map((row) => this.groupRef(repo, row)),
      personnel: people,
      geofences: repo.linkedGeofences(operationId).map((row) => this.mapGeofence(row)),
      positions,
    };
  }

  alerts(request: Request, operationId: number) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    this.operation(repo, operationId);
    const [names, soldierIds, groupIds] = this.scope(repo, operationId);
    return {
      items: repo.alertsFor(names, soldierIds).map((row) => ({
        id: row.id,
        type: row.alert_type,
        severity: row.severity,
        soldier_id: row.soldier_id,
        group_id: groupIds[row.group_id] ?? null,
        status: row.status,
        event_time: row.event_time,
      })),
    };
  }

  tickets(request: Request, operationId: number) {
    const conn = this.db();
    this.reader(conn, request);
    const repo = new OperationRepository(conn);
    this.operation(repo, operationId);
    const [names, soldierIds] = this.scope(repo, operationId);
    const alertIds = repo.alertsFor(names, soldierIds).map((row) => row.id);
    return {
      items: repo.ticketsForAlerts(alertIds).map((row) => ({
        id: row.id,
        ticket_code: row.ticket_code,
        status: row.status,
        priority: row.priority,
        source_alert_id: row.source_alert_id,
        alert_type: row.alert_type,
      })),
    };
  }

  private transition(
    request: Request,
    operationId: number,
    allowed: Set<string>,
    status: string,
    eventType: string,
    description: string,
    stamp?: string,
  ) {
    const conn = this.db();
    const user = this.writer(conn, request);
    const repo = new OperationRepository(conn);
    const operation = this.operation(repo, operationId);
    if (!allowed.has(operation.status)) {
      throw new HttpException(
        `operation cannot move from ${operation.status} to ${status}`,
        409,
      );
    }
    if (status === 'ACTIVE') {
      this.window(operation.start_at, operation.end_at);
    }
    const now = utcNow();
    const fields: Record<string, unknown> = { status, updated_at: now };
    if (stamp) fields[stamp] = now;
    repo.updateOperation(operationId, fields);
    const updated = repo.getOperation(operationId);
    this.audit(conn, user, request, updated, eventType, 'UPDATE', description);
    return this.detailPayload(conn, repo, updated);
  }

  private filters(filters: any) {
    const conditions = ['o.deleted_at IS NULL'];
    const params: unknown[] = [];
    const status = String(filters.status || '')
      .trim()
      .toUpperCase();
    if (status) {
      if (!(STATUSES as readonly string[]).includes(status)) {
        throw new HttpException('unknown status', 400);
      }
      conditions.push('o.status = ?');
      params.push(status);
    }
    if (filters.group_id != null && filters.group_id !== '') {
      conditions.push(`EXISTS (
        SELECT 1 FROM operation_groups og
        WHERE og.operation_id = o.id AND og.group_id = ?
      )`);
      params.push(Number(filters.group_id));
    }
    if (filters.start_from) {
      conditions.push('o.start_at >= ?');
      params.push(this.time(filters.start_from));
    }
    if (filters.start_to) {
      conditions.push('o.start_at <= ?');
      params.push(this.time(filters.start_to));
    }
    const query = String(filters.q || '').trim();
    if (query) {
      const needle = `%${query}%`;
      conditions.push(
        '(o.name LIKE ? COLLATE NOCASE OR o.operation_code LIKE ? COLLATE NOCASE)',
      );
      params.push(needle, needle);
    }
    return { where: conditions.join(' AND '), params };
  }

  private reader(conn: any, request: Request) {
    return this.user(conn, request, false);
  }

  private writer(conn: any, request: Request) {
    const user = this.user(conn, request, true);
    if (
      user.identity_type !== 'HUMAN' ||
      user.verification !== 'VERIFIED' ||
      user.status !== 'ACTIVE'
    ) {
      throw new HttpException('account is not active', 403);
    }
    if (!isActiveBinding(loadBinding(conn, user.id), utcNow())) {
      throw new HttpException('account is not active', 403);
    }
    return user;
  }

  private user(conn: any, request: Request, write: boolean) {
    const actor = actorFromSession(conn, sessionToken(request));
    if (actor == null) throw new HttpException('authentication required', 401);
    const user = getUser(conn, actor.id!);
    if (user == null) throw new HttpException('authentication required', 401);
    const access = effectiveAccess(conn, user.id);
    const granted = new Set(access?.permissions ?? []);
    if (!hasPermission(granted, 'operations', write ? 'write' : 'read')) {
      throw new HttpException('permission denied', 403);
    }
    return user;
  }

  private operation(repo: OperationRepository, operationId: number) {
    const operation = repo.getOperation(operationId);
    if (operation == null) throw new HttpException('operation not found', 404);
    return operation;
  }

  private resolveGroups(repo: OperationRepository, groupIds: number[]) {
    const unique = [...new Set(groupIds)];
    for (const groupId of unique) {
      if (repo.getGroup(groupId) == null) {
        throw new HttpException('group not found', 404);
      }
    }
    return unique;
  }

  private resolveGeofences(repo: OperationRepository, geofenceIds: number[]) {
    const unique = [...new Set(geofenceIds)];
    for (const geofenceId of unique) {
      if (repo.getGeofence(geofenceId) == null) {
        throw new HttpException('geofence not found', 404);
      }
    }
    return unique;
  }

  private name(value: string) {
    const name = String(value || '').trim();
    if (!name) throw new HttpException('name is required', 422);
    return name;
  }

  private optional(value?: string | null) {
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
  }

  private window(startAt: string, endAt: string): [string, string] {
    const start = this.time(startAt);
    const end = this.time(endAt);
    if (end <= start) {
      throw new HttpException('end_at must be after start_at', 422);
    }
    return [start, end];
  }

  private time(value: string) {
    try {
      return canonicalTime(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private personnelCount(repo: OperationRepository, groupNames: string[]) {
    return new Set(repo.personnel(groupNames).map((r) => r.soldier_id)).size;
  }

  private listItem(repo: OperationRepository, operation: any) {
    const groups = repo.linkedGroups(operation.id);
    const names = groups.map((row) => row.name);
    return {
      id: operation.id,
      operation_code: operation.operation_code,
      name: operation.name,
      description: operation.description,
      type: operation.type ?? null,
      status: operation.status,
      start_at: operation.start_at,
      end_at: operation.end_at,
      group_count: groups.length,
      personnel_count: this.personnelCount(repo, names),
      geofence_count: repo.linkedGeofences(operation.id).length,
      created_at: operation.created_at,
    };
  }

  private detailPayload(conn: any, repo: OperationRepository, operation: any) {
    const groups = repo.linkedGroups(operation.id);
    const geofences = repo.linkedGeofences(operation.id);
    const names = groups.map((row) => row.name);
    const creator = conn
      .prepare('SELECT id, name FROM users WHERE id = ?')
      .get(operation.created_by) as any;
    return {
      id: operation.id,
      operation_code: operation.operation_code,
      name: operation.name,
      description: operation.description,
      type: operation.type ?? null,
      status: operation.status,
      start_at: operation.start_at,
      end_at: operation.end_at,
      groups: groups.map((row) => this.groupRef(repo, row)),
      geofences: geofences.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind ?? null,
        color: row.color ?? null,
        area_km2: row.area_km2,
      })),
      summary: {
        group_count: groups.length,
        personnel_count: this.personnelCount(repo, names),
        geofence_count: geofences.length,
      },
      counts: {
        groups: groups.length,
        personnel: this.personnelCount(repo, names),
        geofences: geofences.length,
      },
      created_by: { id: creator.id, name: creator.name },
      created_at: operation.created_at,
    };
  }

  private groupRef(repo: OperationRepository, row: any) {
    return {
      id: row.id,
      name: row.name,
      leader_soldier_id: row.leader_soldier_id ?? null,
      personnel_count: repo.memberCount(row.id) || this.personnelCount(repo, [row.name]),
    };
  }

  private groupChoice(repo: OperationRepository, row: any) {
    return {
      ...this.groupRef(repo, row),
      // Keep commander_name null until a dedicated commander name field exists.
      commander_name: null,
    };
  }

  private groupItem(repo: OperationRepository, row: any) {
    return {
      id: row.id,
      name: row.name,
      leader_soldier_id: row.leader_soldier_id ?? null,
      commander:
        row.leader_soldier_id != null
          ? { soldier_id: row.leader_soldier_id }
          : null,
      personnel_count: repo.memberCount(row.id) || this.personnelCount(repo, [row.name]),
      status: row.status,
    };
  }

  private createInlineGroup(repo: OperationRepository, g: any): number {
    const name = this.name(g.name);
    let members: number[];
    try {
      const normalized = (g.member_soldier_ids || []).map((id: unknown) =>
        normalizeSoldierId(id),
      ) as number[];
      members = [...new Set(normalized)];
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 422);
    }
    if (!members.length) {
      throw new HttpException('member_soldier_ids is required', 422);
    }
    let leader: number | null = null;
    if (g.leader_soldier_id != null && g.leader_soldier_id !== '') {
      try {
        leader = normalizeSoldierId(g.leader_soldier_id);
      } catch (exc: any) {
        throw new HttpException(String(exc.message || exc), 422);
      }
      if (!members.includes(leader)) members.unshift(leader);
    }
    try {
      return repo.createGroup({
        name,
        description: this.optional(g.description),
        leaderSoldierId: leader,
        memberSoldierIds: members,
      });
    } catch (exc: any) {
      if (/UNIQUE/i.test(String(exc?.message))) {
        throw new HttpException('group already exists', 409);
      }
      throw exc;
    }
  }

  private createInlineGeofence(repo: OperationRepository, fence: any): number {
    const name = this.name(fence.name);
    const polygon = this.resolvePolygon(fence);
    const area =
      fence.area_km2 != null && Number.isFinite(Number(fence.area_km2))
        ? Number(fence.area_km2)
        : this.areaKm2(polygon);
    return repo.createGeofence({
      name,
      description: this.optional(fence.description),
      kind: this.optional(fence.kind),
      color: this.optional(fence.color),
      polygon,
      areaKm2: area,
    });
  }

  private resolvePolygon(fence: any): number[][] {
    if (Array.isArray(fence.polygon)) {
      return this.cleanPolygon(fence.polygon);
    }
    if (fence.geometry_json) {
      let geometry: any;
      try {
        geometry =
          typeof fence.geometry_json === 'string'
            ? JSON.parse(fence.geometry_json)
            : fence.geometry_json;
      } catch {
        throw new HttpException('geometry_json is invalid', 422);
      }
      const coords = geometry?.coordinates?.[0];
      if (!Array.isArray(coords) || coords.length < 3) {
        throw new HttpException('geometry_json must be a Polygon', 422);
      }
      // Drop closing ring point if present
      const ring = [...coords];
      if (
        ring.length > 3 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
      ) {
        ring.pop();
      }
      return this.cleanPolygon(ring);
    }
    throw new HttpException('polygon or geometry_json is required', 422);
  }

  private cleanPolygon(polygon: any[]): number[][] {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      throw new HttpException('polygon must have at least 3 corners', 422);
    }
    // Existing geofences API historically required exactly 3; wizard may send more.
    // Store first 3 for compatibility with current geofence consumers, or all if >3?
    // Plan: accept >=3, store as-is for wizard (operations map reads polygon_json).
    const points: number[][] = [];
    for (const point of polygon) {
      if (!Array.isArray(point) || point.length !== 2) {
        throw new HttpException('each corner needs longitude and latitude', 422);
      }
      const lng = Number(point[0]);
      const lat = Number(point[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw new HttpException('corner is not a number', 422);
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new HttpException('corner is outside the map', 422);
      }
      points.push([lng, lat]);
    }
    return points;
  }

  private areaKm2(points: number[][]): number {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const [lng, lat] = points[index];
      const [nextLng, nextLat] = points[(index + 1) % points.length];
      area += lng * nextLat - nextLng * lat;
    }
    area = Math.abs(area) / 2;
    const meanLat = points.reduce((s, p) => s + p[1], 0) / points.length;
    const kmLat = 111.32;
    const kmLng = 111.32 * Math.cos((meanLat * Math.PI) / 180);
    return Math.round(area * kmLat * kmLng * 10) / 10;
  }

  private personnelList(repo: OperationRepository, operationId: number) {
    const groups = Object.fromEntries(
      repo.linkedGroups(operationId).map((row) => [row.name, row]),
    );
    const items: any[] = [];
    for (const row of repo.personnel(Object.keys(groups))) {
      const group = groups[row.group_id];
      items.push({
        soldier_id: row.soldier_id,
        group_id: group.id,
        group_name: group.name,
      });
    }
    return items;
  }

  private scope(repo: OperationRepository, operationId: number): [string[], number[], Record<string, number>] {
    const groups = repo.linkedGroups(operationId);
    const names = groups.map((row) => row.name);
    const groupIds = Object.fromEntries(groups.map((row) => [row.name, row.id]));
    const soldierIds = [
      ...new Set(repo.personnel(names).map((row) => row.soldier_id)),
    ].sort((a, b) => a - b);
    return [names, soldierIds, groupIds];
  }

  private mapGeofence(row: any) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind ?? null,
      color: row.color ?? null,
      polygon: JSON.parse(row.polygon_json),
    };
  }

  private audit(
    conn: any,
    user: any,
    request: Request,
    operation: any,
    eventType: string,
    action: string,
    description: string,
    metadata?: Record<string, unknown>,
  ) {
    insertAudit(conn, {
      actor: actorForUser(conn, user),
      category: 'OPERATIONS',
      event_type: eventType,
      action,
      target: {
        id: operation.id,
        name: operation.operation_code,
        type: 'OPERATION',
      },
      description,
      request,
      metadata,
    });
  }
}
