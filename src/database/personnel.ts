import type { Database } from 'better-sqlite3';
import { bind } from '../common/sql';
import { utcNow } from '../common/records';

/** Resolve organizational group from Personnel master (not from wire packet). */
export function getGroupById(db: Database, groupId: number) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as any;
}

export function getGroupByName(db: Database, name: string) {
  return db
    .prepare('SELECT * FROM groups WHERE name = ? COLLATE NOCASE')
    .get(name) as any;
}

export function getPersonnelBySoldier(db: Database, soldierId: number) {
  return db
    .prepare('SELECT * FROM personnel WHERE soldier_id = ?')
    .get(soldierId) as any;
}

export function ensurePersonnel(db: Database, soldierId: number) {
  const existing = getPersonnelBySoldier(db, soldierId);
  if (existing) return existing;
  const now = utcNow();
  const info = db
    .prepare(
      `INSERT INTO personnel (soldier_id, name, group_id, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'ACTIVE', ?, ?)`,
    )
    .run(...bind([soldierId, `Soldier ${soldierId}`, now, now]));
  return db
    .prepare('SELECT * FROM personnel WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as any;
}

/**
 * Enrichment for explorer_records.group_id from Personnel master only.
 * Does NOT invent/create personnel — unknown soldier_id → null group.
 */
export function resolveGroupName(
  db: Database,
  soldierId: number | null | undefined,
): string | null {
  if (soldierId == null) return null;
  const person = getPersonnelBySoldier(db, soldierId);
  if (person == null || person.group_id == null) return null;
  const group = getGroupById(db, person.group_id);
  if (group == null || group.status !== 'ACTIVE') return null;
  return group.name ?? null;
}

/**
 * Retire a Settings group and wipe its label from domain records.
 * Explorer/History/Alerts store group as a name string — clear those too.
 */
export function retireGroup(db: Database, groupId: number): void {
  const group = getGroupById(db, groupId);
  if (group == null) return;
  const now = utcNow();
  const name = String(group.name || '').trim();

  db.prepare(
    `UPDATE groups SET status = 'INACTIVE', updated_at = ? WHERE id = ?`,
  ).run(...bind([now, groupId]));
  db.prepare('DELETE FROM operation_groups WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  db.prepare(
    'UPDATE personnel SET group_id = NULL, updated_at = ? WHERE group_id = ?',
  ).run(...bind([now, groupId]));

  if (name) {
    clearGroupLabelFromRecords(db, name);
  }
}

/** Clear stored group name on telemetry/alerts (Explorer GROUP column). */
export function clearGroupLabelFromRecords(db: Database, groupName: string): void {
  const name = String(groupName || '').trim();
  if (!name) return;
  db.prepare(
    `UPDATE explorer_records SET group_id = NULL WHERE group_id = ? COLLATE NOCASE`,
  ).run(name);
  db.prepare(
    `UPDATE alerts SET group_id = NULL, updated_at = ? WHERE group_id = ? COLLATE NOCASE`,
  ).run(...bind([utcNow(), name]));
}

/** Wipe Explorer/Alerts labels that no longer map to an ACTIVE group. */
export function purgeOrphanGroupLabels(db: Database): void {
  db.prepare(
    `
    UPDATE explorer_records
    SET group_id = NULL
    WHERE group_id IS NOT NULL
      AND group_id NOT IN (
        SELECT name FROM groups WHERE status = 'ACTIVE' AND name IS NOT NULL
      )
    `,
  ).run();
  db.prepare(
    `
    UPDATE alerts
    SET group_id = NULL, updated_at = ?
    WHERE group_id IS NOT NULL
      AND group_id NOT IN (
        SELECT name FROM groups WHERE status = 'ACTIVE' AND name IS NOT NULL
      )
    `,
  ).run(...bind([utcNow()]));
}

/** Optional personnel display name for Explorer enrichment (null if unknown). */
export function resolvePersonnelName(
  db: Database,
  soldierId: number | null | undefined,
): string | null {
  if (soldierId == null) return null;
  const person = getPersonnelBySoldier(db, soldierId);
  return person?.name ?? null;
}

/** Normalize "S-103" / "103" / 103 → number. */
export function normalizeSoldierId(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '')
    .trim()
    .replace(/^S-/i, '');
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid soldier_id: ${value}`);
  }
  return n;
}

/** Assign soldiers to a group via group_members and sync personnel.group_id. */
export function setGroupMembers(
  db: Database,
  groupId: number,
  soldierIds: number[],
  leaderSoldierId?: number | null,
) {
  const now = utcNow();
  const unique = [...new Set(soldierIds)];
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  const insert = db.prepare(
    'INSERT INTO group_members (group_id, soldier_id, created_at) VALUES (?, ?, ?)',
  );
  for (const soldierId of unique) {
    ensurePersonnel(db, soldierId);
    insert.run(...bind([groupId, soldierId, now]));
    db.prepare(
      'UPDATE personnel SET group_id = ?, updated_at = ? WHERE soldier_id = ?',
    ).run(...bind([groupId, now, soldierId]));
  }
  db.prepare(
    'UPDATE groups SET leader_soldier_id = ?, updated_at = ? WHERE id = ?',
  ).run(
    ...bind([
      leaderSoldierId != null ? leaderSoldierId : unique[0] ?? null,
      now,
      groupId,
    ]),
  );
}

export function addGroupMember(db: Database, groupId: number, soldierId: number) {
  const now = utcNow();
  ensurePersonnel(db, soldierId);
  db.prepare(
    'INSERT OR IGNORE INTO group_members (group_id, soldier_id, created_at) VALUES (?, ?, ?)',
  ).run(...bind([groupId, soldierId, now]));
  db.prepare(
    'UPDATE personnel SET group_id = ?, updated_at = ? WHERE soldier_id = ?',
  ).run(...bind([groupId, now, soldierId]));
}

export function groupMemberCount(db: Database, groupId: number): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?')
      .get(groupId) as any
  ).n as number;
}

/**
 * Groups/personnel are NOT seeded.
 * Settings stays empty until Operations (or Groups/Personnel APIs) create them.
 * Telemetry seed still works with group_id null until enrichment is assigned.
 */
export function seedPersonnelMaster(_db: Database) {
  // intentionally empty — org structure is created by operations / admin APIs
}
