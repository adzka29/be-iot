import type { Database } from 'better-sqlite3';
import { bind } from '../common/sql';
import { utcNow } from '../common/records';
import {
  groupMemberCount,
  setGroupMembers,
} from '../database/personnel';

export class OperationRepository {
  constructor(private readonly db: Database) {}

  syncGroups() {
    // no-op — groups are master data
  }

  groups() {
    return this.db
      .prepare(
        `SELECT id, name, description, leader_soldier_id, status, created_at, updated_at
         FROM groups WHERE status = 'ACTIVE' ORDER BY name COLLATE NOCASE`,
      )
      .all() as any[];
  }

  getGroup(groupId: number) {
    return this.db
      .prepare(
        `SELECT id, name, description, leader_soldier_id, status, created_at, updated_at
         FROM groups WHERE id = ?`,
      )
      .get(groupId) as any;
  }

  getGeofence(geofenceId: number) {
    return this.db.prepare('SELECT * FROM geofences WHERE id = ?').get(geofenceId) as any;
  }

  nextCode(now: string) {
    const prefix = `OP-${now.slice(0, 4)}-`;
    const row = this.db
      .prepare(
        `SELECT operation_code FROM operations WHERE operation_code LIKE ?
         ORDER BY operation_code DESC LIMIT 1`,
      )
      .get(`${prefix}%`) as any;
    const sequence =
      row == null ? 1 : Number(String(row.operation_code).split('-').pop()) + 1;
    return `${prefix}${String(sequence).padStart(3, '0')}`;
  }

  insertOperation(values: Record<string, unknown>) {
    const columns = Object.keys(values).join(', ');
    const marks = Object.keys(values)
      .map(() => '?')
      .join(', ');
    const info = this.db
      .prepare(`INSERT INTO operations (${columns}) VALUES (${marks})`)
      .run(...bind(Object.values(values)));
    return Number(info.lastInsertRowid);
  }

  getOperation(operationId: number) {
    return this.db
      .prepare('SELECT * FROM operations WHERE id = ? AND deleted_at IS NULL')
      .get(operationId) as any;
  }

  updateOperation(operationId: number, fields: Record<string, unknown>) {
    const assignments = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.db
      .prepare(`UPDATE operations SET ${assignments} WHERE id = ?`)
      .run(...bind([...Object.values(fields), operationId]));
  }

  countOperations(where: string, params: unknown[]) {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM operations o WHERE ${where}`)
        .get(...bind(params)) as any
    ).n as number;
  }

  listOperations(where: string, params: unknown[], limit: number, offset: number) {
    return this.db
      .prepare(
        `SELECT * FROM operations o WHERE ${where}
         ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...bind([...params, limit, offset])) as any[];
  }

  statusCounts() {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM operations WHERE deleted_at IS NULL GROUP BY status`,
      )
      .all() as any[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  linkedGroups(operationId: number) {
    return this.db
      .prepare(
        `SELECT g.id, g.name, g.description, g.leader_soldier_id, g.status
         FROM operation_groups og
         JOIN groups g ON g.id = og.group_id
         WHERE og.operation_id = ? ORDER BY g.name COLLATE NOCASE`,
      )
      .all(operationId) as any[];
  }

  linkedGeofences(operationId: number) {
    return this.db
      .prepare(
        `SELECT f.id, f.name, f.polygon_json, f.status, f.kind, f.color, f.area_km2, f.description
         FROM operation_geofences og
         JOIN geofences f ON f.id = og.geofence_id
         WHERE og.operation_id = ? ORDER BY f.name COLLATE NOCASE`,
      )
      .all(operationId) as any[];
  }

  replaceGroups(operationId: number, groupIds: number[]) {
    this.db.prepare('DELETE FROM operation_groups WHERE operation_id = ?').run(operationId);
    const insert = this.db.prepare(
      'INSERT INTO operation_groups (operation_id, group_id) VALUES (?, ?)',
    );
    for (const groupId of groupIds) insert.run(operationId, groupId);
  }

  replaceGeofences(operationId: number, geofenceIds: number[]) {
    this.db
      .prepare('DELETE FROM operation_geofences WHERE operation_id = ?')
      .run(operationId);
    const insert = this.db.prepare(
      'INSERT INTO operation_geofences (operation_id, geofence_id) VALUES (?, ?)',
    );
    for (const geofenceId of geofenceIds) insert.run(operationId, geofenceId);
  }

  linkGroup(operationId: number, groupId: number) {
    this.db
      .prepare('INSERT INTO operation_groups (operation_id, group_id) VALUES (?, ?)')
      .run(operationId, groupId);
  }

  unlinkGroup(operationId: number, groupId: number) {
    return this.db
      .prepare('DELETE FROM operation_groups WHERE operation_id = ? AND group_id = ?')
      .run(operationId, groupId).changes;
  }

  hasGroup(operationId: number, groupId: number) {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM operation_groups WHERE operation_id = ? AND group_id = ?',
        )
        .get(operationId, groupId) != null
    );
  }

  linkGeofence(operationId: number, geofenceId: number) {
    this.db
      .prepare(
        'INSERT INTO operation_geofences (operation_id, geofence_id) VALUES (?, ?)',
      )
      .run(operationId, geofenceId);
  }

  unlinkGeofence(operationId: number, geofenceId: number) {
    return this.db
      .prepare(
        'DELETE FROM operation_geofences WHERE operation_id = ? AND geofence_id = ?',
      )
      .run(operationId, geofenceId).changes;
  }

  hasGeofence(operationId: number, geofenceId: number) {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM operation_geofences WHERE operation_id = ? AND geofence_id = ?',
        )
        .get(operationId, geofenceId) != null
    );
  }

  createGroup(input: {
    name: string;
    description?: string | null;
    leaderSoldierId?: number | null;
    memberSoldierIds: number[];
  }): number {
    const now = utcNow();
    const info = this.db
      .prepare(
        `INSERT INTO groups (name, description, leader_soldier_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .run(
        ...bind([
          input.name,
          input.description ?? null,
          input.leaderSoldierId ?? input.memberSoldierIds[0] ?? null,
          now,
          now,
        ]),
      );
    const groupId = Number(info.lastInsertRowid);
    setGroupMembers(
      this.db,
      groupId,
      input.memberSoldierIds,
      input.leaderSoldierId ?? null,
    );
    return groupId;
  }

  createGeofence(input: {
    name: string;
    description?: string | null;
    kind?: string | null;
    color?: string | null;
    polygon: number[][];
    areaKm2: number;
  }): number {
    const now = utcNow();
    const info = this.db
      .prepare(
        `INSERT INTO geofences
         (name, description, type, status, groups_json, polygon_json, area_km2, created_at, kind, color)
         VALUES (?, ?, 'silent', 'active', '[]', ?, ?, ?, ?, ?)`,
      )
      .run(
        ...bind([
          input.name,
          input.description ?? '',
          JSON.stringify(input.polygon),
          input.areaKm2,
          now,
          input.kind ?? null,
          input.color ?? null,
        ]),
      );
    return Number(info.lastInsertRowid);
  }

  memberCount(groupId: number) {
    return groupMemberCount(this.db, groupId);
  }

  /** Personnel via group_members (preferred) with personnel fallback. */
  personnel(groupNames: string[]) {
    if (!groupNames.length) return [];
    const marks = groupNames.map(() => '?').join(', ');
    const fromMembers = this.db
      .prepare(
        `SELECT gm.soldier_id, g.name AS group_id, p.name AS soldier_name, g.id AS group_pk
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         LEFT JOIN personnel p ON p.soldier_id = gm.soldier_id
         WHERE g.name IN (${marks})
         ORDER BY g.name COLLATE NOCASE, gm.soldier_id`,
      )
      .all(...groupNames) as any[];
    if (fromMembers.length) return fromMembers;
    return this.db
      .prepare(
        `SELECT p.soldier_id, g.name AS group_id, p.name AS soldier_name, g.id AS group_pk
         FROM personnel p
         JOIN groups g ON g.id = p.group_id
         WHERE p.status = 'ACTIVE' AND g.name IN (${marks})
         ORDER BY g.name COLLATE NOCASE, p.soldier_id`,
      )
      .all(...groupNames) as any[];
  }

  personnelOptions(q?: string) {
    const needle = q?.trim() ? `%${q.trim()}%` : null;
    const rows = this.db
      .prepare(
        `
        SELECT
          p.soldier_id,
          p.name,
          p.group_id,
          g.name AS group_name,
          g.leader_soldier_id,
          (
            SELECT er.event_time FROM explorer_records er
            WHERE er.category = 'TELEMETRY' AND er.soldier_id = p.soldier_id
            ORDER BY er.event_time DESC, er.id DESC LIMIT 1
          ) AS last_seen,
          (
            SELECT er.data_json FROM explorer_records er
            WHERE er.category = 'TELEMETRY' AND er.soldier_id = p.soldier_id
            ORDER BY er.event_time DESC, er.id DESC LIMIT 1
          ) AS data_json
        FROM personnel p
        LEFT JOIN groups g ON g.id = p.group_id
        WHERE p.status = 'ACTIVE'
          ${needle ? 'AND (p.name LIKE ? OR CAST(p.soldier_id AS TEXT) LIKE ?)' : ''}
        ORDER BY p.soldier_id ASC
        `,
      )
      .all(...(needle ? [needle, needle] : [])) as any[];
    return rows.map((row) => {
      let lat: number | null = null;
      let lon: number | null = null;
      if (row.data_json) {
        try {
          const data = JSON.parse(row.data_json);
          lat = data.lat ?? null;
          lon = data.lon ?? null;
        } catch {
          /* ignore */
        }
      }
      return {
        soldier_id: row.soldier_id,
        name: row.name,
        group_id: row.group_id,
        group_name: row.group_name,
        access_group: row.group_name ?? 'UNASSIGNED',
        last_seen: row.last_seen,
        lat,
        lon,
      };
    });
  }

  latestPosition(soldierId: number, _groupName?: string) {
    return this.db
      .prepare(
        `SELECT event_time, data_json FROM explorer_records
         WHERE category = 'TELEMETRY' AND soldier_id = ?
         ORDER BY event_time DESC, id DESC LIMIT 1`,
      )
      .get(soldierId) as any;
  }

  alertsFor(
    groupNames: string[],
    soldierIds: number[],
    window?: { startAt?: string; endAt?: string },
  ) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (groupNames.length) {
      clauses.push(`group_id IN (${groupNames.map(() => '?').join(', ')})`);
      params.push(...groupNames);
    }
    if (soldierIds.length) {
      clauses.push(`soldier_id IN (${soldierIds.map(() => '?').join(', ')})`);
      params.push(...soldierIds);
    }
    if (!clauses.length) return [];
    let sql = `SELECT * FROM alerts WHERE (${clauses.join(' OR ')})`;
    if (window?.startAt) {
      sql += ' AND event_time >= ?';
      params.push(window.startAt);
    }
    if (window?.endAt) {
      sql += ' AND event_time <= ?';
      params.push(window.endAt);
    }
    sql += ' ORDER BY event_time DESC, id DESC';
    return this.db.prepare(sql).all(...bind(params)) as any[];
  }

  ticketsForAlerts(alertIds: number[]) {
    if (!alertIds.length) return [];
    const marks = alertIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT t.id, t.ticket_code, t.status, t.priority, t.source_alert_id, a.alert_type
         FROM tickets t JOIN alerts a ON a.id = t.source_alert_id
         WHERE t.source_alert_id IN (${marks})
         ORDER BY t.created_at DESC, t.id DESC`,
      )
      .all(...alertIds) as any[];
  }
}

export function positionOf(
  row: any | null | undefined,
): [number | null, number | null, string | null] {
  if (row == null) return [null, null, null];
  const payload = JSON.parse(row.data_json);
  return [payload.lat ?? null, payload.lon ?? null, row.event_time];
}
