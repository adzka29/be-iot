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
 * Enrichment for explorer_records.group_id:
 * - looks up personnel by soldier_id
 * - auto-registers unknown soldiers as UNASSIGNED (group_id NULL)
 * - returns group name string for denormalized storage, or null
 */
export function resolveGroupName(
  db: Database,
  soldierId: number | null | undefined,
): string | null {
  if (soldierId == null) return null;
  const person = ensurePersonnel(db, soldierId);
  if (person.group_id == null) return null;
  const group = getGroupById(db, person.group_id);
  return group?.name ?? null;
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

export function seedPersonnelMaster(db: Database) {
  if (process.env.TRACKFORGE_SEED === '0') return;
  const now = utcNow();
  const groupCount = (
    db.prepare('SELECT COUNT(*) AS n FROM groups').get() as any
  ).n;
  if (groupCount === 0) {
    db.prepare(
      `INSERT INTO groups (name, description, leader_soldier_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).run('Alpha', 'Seeded Alpha squad', 101, now, now);
  }
  const alpha = getGroupByName(db, 'Alpha');
  if (alpha == null) return;

  // Backfill timestamps / leader on existing Alpha
  db.prepare(
    `UPDATE groups SET
       leader_soldier_id = COALESCE(leader_soldier_id, ?),
       created_at = COALESCE(created_at, ?),
       updated_at = COALESCE(updated_at, ?)
     WHERE id = ?`,
  ).run(101, now, now, alpha.id);

  const personCount = (
    db.prepare('SELECT COUNT(*) AS n FROM personnel').get() as any
  ).n;
  if (personCount === 0) {
    const insert = db.prepare(
      `INSERT INTO personnel (soldier_id, name, group_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    );
    for (let soldierId = 101; soldierId <= 108; soldierId++) {
      insert.run(
        ...bind([soldierId, `Soldier ${soldierId}`, alpha.id, now, now]),
      );
    }
  }

  const memberCount = (
    db
      .prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?')
      .get(alpha.id) as any
  ).n;
  if (memberCount === 0) {
    const soldiers = db
      .prepare('SELECT soldier_id FROM personnel WHERE group_id = ? ORDER BY soldier_id')
      .all(alpha.id) as { soldier_id: number }[];
    const ids =
      soldiers.length > 0
        ? soldiers.map((s) => s.soldier_id)
        : [101, 102, 103, 104, 105, 106, 107, 108];
    setGroupMembers(db, alpha.id, ids, 101);
  }
}
