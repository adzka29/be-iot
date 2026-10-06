import type { Database } from 'better-sqlite3';
import { bind } from '../common/sql';

export class OperationRepository {
  constructor(private readonly db: Database) {}

  syncGroups() {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT group_id AS name FROM explorer_records
         WHERE group_id IS NOT NULL AND group_id != ''`,
      )
      .all() as any[];
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO groups (name, status) VALUES (?, 'ACTIVE')",
    );
    for (const row of rows) insert.run(row.name);
  }

  groups() {
    this.syncGroups();
    return this.db
      .prepare('SELECT id, name, status FROM groups ORDER BY name COLLATE NOCASE')
      .all() as any[];
  }

  getGroup(groupId: number) {
    this.syncGroups();
    return this.db
      .prepare('SELECT id, name, status FROM groups WHERE id = ?')
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
        `SELECT g.id, g.name, g.status FROM operation_groups og
         JOIN groups g ON g.id = og.group_id
         WHERE og.operation_id = ? ORDER BY g.name COLLATE NOCASE`,
      )
      .all(operationId) as any[];
  }

  linkedGeofences(operationId: number) {
    return this.db
      .prepare(
        `SELECT f.id, f.name, f.polygon_json, f.status FROM operation_geofences og
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

  personnel(groupNames: string[]) {
    if (!groupNames.length) return [];
    const marks = groupNames.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT DISTINCT soldier_id, group_id FROM explorer_records
         WHERE is_sos = 0 AND soldier_id IS NOT NULL AND group_id IN (${marks})
         ORDER BY group_id COLLATE NOCASE, soldier_id`,
      )
      .all(...groupNames) as any[];
  }

  latestPosition(soldierId: number, groupName: string) {
    return this.db
      .prepare(
        `SELECT event_time, data_json FROM explorer_records
         WHERE is_sos = 0 AND category = 'TELEMETRY' AND soldier_id = ? AND group_id = ?
         ORDER BY event_time DESC, id DESC LIMIT 1`,
      )
      .get(soldierId, groupName) as any;
  }

  alertsFor(groupNames: string[], soldierIds: number[]) {
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
    return this.db
      .prepare(
        `SELECT * FROM alerts WHERE ${clauses.join(' OR ')}
         ORDER BY event_time DESC, id DESC`,
      )
      .all(...bind(params)) as any[];
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
