import type { Database } from 'better-sqlite3';
import { bind } from '../common/sql';

const TICKET_COLUMNS = `
  t.id, t.ticket_code, t.source_alert_id, t.status, t.priority, t.created_by, t.assignee_id,
  t.response_plan, t.created_at, t.updated_at, t.started_at, t.resolved_at, t.closed_at,
  a.alert_code, a.alert_type, a.severity AS alert_severity, a.status AS alert_status,
  a.soldier_id, a.group_id, a.event_time, a.position_source, a.latitude, a.longitude, a.message
`;

const FROM = `
  FROM tickets t
  JOIN alerts a ON a.id = t.source_alert_id
`;

export class TicketRepository {
  constructor(private readonly db: Database) {}

  getAlert(alertId: number) {
    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as any;
  }

  ticketForAlert(alertId: number) {
    return this.db
      .prepare('SELECT id FROM tickets WHERE source_alert_id = ?')
      .get(alertId) as any;
  }

  nextCode(now: string) {
    const prefix = `TK-${now.slice(0, 10).replace(/-/g, '')}-`;
    const row = this.db
      .prepare(
        `SELECT ticket_code FROM tickets WHERE ticket_code LIKE ?
         ORDER BY ticket_code DESC LIMIT 1`,
      )
      .get(`${prefix}%`) as any;
    const sequence =
      row == null ? 1 : Number(String(row.ticket_code).split('-').pop()) + 1;
    return `${prefix}${String(sequence).padStart(3, '0')}`;
  }

  insertTicket(values: Record<string, unknown>) {
    const columns = Object.keys(values).join(', ');
    const marks = Object.keys(values)
      .map(() => '?')
      .join(', ');
    const info = this.db
      .prepare(`INSERT INTO tickets (${columns}) VALUES (${marks})`)
      .run(...bind(Object.values(values)));
    return Number(info.lastInsertRowid);
  }

  acknowledgeAlert(alertId: number, actorName: string, now: string) {
    this.db
      .prepare(
        `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE'`,
      )
      .run(...bind([now, actorName, now, alertId]));
  }

  resolveAlert(alertId: number, actorName: string, now: string) {
    this.db
      .prepare(
        `UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`,
      )
      .run(...bind([now, actorName, now, alertId]));
  }

  getTicket(ticketId: number) {
    return this.db
      .prepare(`SELECT ${TICKET_COLUMNS} ${FROM} WHERE t.id = ?`)
      .get(ticketId) as any;
  }

  countTickets(where: string, params: unknown[]) {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n ${FROM} WHERE ${where}`)
        .get(...bind(params)) as any
    ).n as number;
  }

  listTickets(where: string, params: unknown[], limit: number, offset: number) {
    return this.db
      .prepare(
        `SELECT ${TICKET_COLUMNS} ${FROM} WHERE ${where}
         ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...bind([...params, limit, offset])) as any[];
  }

  groupedCounts(where: string, params: unknown[], column: string) {
    const rows = this.db
      .prepare(
        `SELECT t.${column} AS value, COUNT(*) AS n ${FROM} WHERE ${where} GROUP BY t.${column}`,
      )
      .all(...bind(params)) as any[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.value] = row.n;
    return out;
  }

  visibleAlertTypes(where: string, params: unknown[]) {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT a.alert_type AS value ${FROM}
           WHERE ${where} AND a.alert_type IS NOT NULL ORDER BY a.alert_type ASC`,
        )
        .all(...bind(params)) as any[]
    ).map((r) => r.value as string);
  }

  visibleGroups(where: string, params: unknown[]) {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT a.group_id AS value ${FROM}
           WHERE ${where} AND a.group_id IS NOT NULL AND a.group_id != ''
           ORDER BY a.group_id COLLATE NOCASE ASC`,
        )
        .all(...bind(params)) as any[]
    ).map((r) => r.value as string);
  }

  updateTicket(ticketId: number, fields: Record<string, unknown>) {
    const assignments = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.db
      .prepare(`UPDATE tickets SET ${assignments} WHERE id = ?`)
      .run(...bind([...Object.values(fields), ticketId]));
  }

  collaborators(ticketId: number) {
    return this.db
      .prepare(
        `SELECT ticket_id, user_id, added_by, added_at FROM ticket_collaborators
         WHERE ticket_id = ? ORDER BY added_at ASC, user_id ASC`,
      )
      .all(ticketId) as any[];
  }

  getCollaborator(ticketId: number, userId: number) {
    return this.db
      .prepare(
        `SELECT ticket_id, user_id, added_by, added_at FROM ticket_collaborators
         WHERE ticket_id = ? AND user_id = ?`,
      )
      .get(ticketId, userId) as any;
  }

  addCollaborator(ticketId: number, userId: number, addedBy: number, addedAt: string) {
    this.db
      .prepare(
        `INSERT INTO ticket_collaborators (ticket_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)`,
      )
      .run(...bind([ticketId, userId, addedBy, addedAt]));
  }

  removeCollaborator(ticketId: number, userId: number) {
    this.db
      .prepare('DELETE FROM ticket_collaborators WHERE ticket_id = ? AND user_id = ?')
      .run(ticketId, userId);
  }

  tasks(ticketId: number) {
    return this.db
      .prepare('SELECT * FROM ticket_tasks WHERE ticket_id = ? ORDER BY id ASC')
      .all(ticketId) as any[];
  }

  getTask(ticketId: number, taskId: number) {
    return this.db
      .prepare('SELECT * FROM ticket_tasks WHERE ticket_id = ? AND id = ?')
      .get(ticketId, taskId) as any;
  }

  insertTask(values: Record<string, unknown>) {
    const columns = Object.keys(values).join(', ');
    const marks = Object.keys(values)
      .map(() => '?')
      .join(', ');
    const info = this.db
      .prepare(`INSERT INTO ticket_tasks (${columns}) VALUES (${marks})`)
      .run(...bind(Object.values(values)));
    return Number(info.lastInsertRowid);
  }

  updateTask(taskId: number, fields: Record<string, unknown>) {
    const assignments = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.db
      .prepare(`UPDATE ticket_tasks SET ${assignments} WHERE id = ?`)
      .run(...bind([...Object.values(fields), taskId]));
  }

  updates(ticketId: number) {
    return this.db
      .prepare(
        `SELECT id, ticket_id, author_id, message, created_at FROM ticket_updates
         WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(ticketId) as any[];
  }

  insertUpdate(ticketId: number, authorId: number, message: string, createdAt: string) {
    const info = this.db
      .prepare(
        `INSERT INTO ticket_updates (ticket_id, author_id, message, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(...bind([ticketId, authorId, message, createdAt]));
    return Number(info.lastInsertRowid);
  }
}
