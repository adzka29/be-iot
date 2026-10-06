import * as crypto from 'crypto';
import type { Database } from 'better-sqlite3';
import { HttpException } from '@nestjs/common';
import { bind } from '../common/sql';
import { utcNow } from '../common/records';

// Port of app/access.py

export const DOMAINS = [
  'overview',
  'groups',
  'personal',
  'weapons',
  'operations',
  'geofences',
  'explorer',
  'alerts',
  'history',
  'reports',
  'lora_mesh',
  'gateways',
  'user_access',
  'activity_log',
  'settings',
] as const;

export const OPERATIONAL_DOMAINS = [
  'overview',
  'groups',
  'personal',
  'weapons',
  'operations',
  'geofences',
  'explorer',
  'alerts',
  'history',
  'reports',
] as const;

type SeedRole = {
  name: string;
  duty_category: string;
  description: string;
  privilege_narrative: string;
  least_privilege_baseline: string;
  grants: readonly string[];
};

const SEED_ROLES: readonly SeedRole[] = [
  {
    name: 'superadmin',
    duty_category: 'Platform Administration',
    description: 'Full platform administration.',
    privilege_narrative: 'Full authority across the TrackForge platform.',
    least_privilege_baseline: 'Reserved for platform administration.',
    grants: DOMAINS,
  },
  {
    name: 'operations commander',
    duty_category: 'Command Operations',
    description: 'Operational command and oversight.',
    privilege_narrative:
      'Provides broad operational visibility and command authority.',
    least_privilege_baseline:
      'Only operational authority required for command.',
    grants: [...OPERATIONAL_DOMAINS, 'lora_mesh.read', 'gateways.read', 'activity_log.read'],
  },
  {
    name: 'operations officer',
    duty_category: 'Operations Control',
    description: 'Operational monitoring and coordination.',
    privilege_narrative: 'Handles day-to-day operational workflows.',
    least_privilege_baseline: 'Only operational workflows required by duty.',
    grants: [
      'overview',
      'groups',
      'personal',
      'operations',
      'geofences',
      'explorer',
      'alerts',
      'history',
      'weapons.read',
      'reports.read',
    ],
  },
  {
    name: 'field operator',
    duty_category: 'Field Operations',
    description: 'Field personnel monitoring.',
    privilege_narrative: 'Monitors personnel, alerts, and operational history.',
    least_privilege_baseline: 'Limit access to field monitoring capabilities.',
    grants: [
      'overview.read',
      'groups.read',
      'personal.read',
      'operations.read',
      'alerts.read',
      'history.read',
    ],
  },
  {
    name: 'device & fleet admin',
    duty_category: 'Fleet & Communications',
    description: 'Device and communication management.',
    privilege_narrative:
      'Manages tracking devices, gateways, and communication infrastructure.',
    least_privilege_baseline:
      'Restrict authority to fleet and communication functions.',
    grants: ['lora_mesh', 'gateways', 'overview.read'],
  },
  {
    name: 'viewer',
    duty_category: 'Read Only',
    description: 'Read-only operational visibility.',
    privilege_narrative: 'Provides visibility without modification authority.',
    least_privilege_baseline: 'No write capabilities.',
    grants: OPERATIONAL_DOMAINS.map((domain) => `${domain}.read`),
  },
];

export function hasPermission(
  granted: Set<string>,
  domain: string,
  action: string,
): boolean {
  if (granted.has(domain)) return true;
  if (action === 'read') return granted.has(`${domain}.read`);
  return false;
}

export function displayName(name: string): string {
  return name
    .split(' ')
    .map((part) => (part === '&' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto
    .pbkdf2Sync(password, salt, 120_000, 32, 'sha256')
    .toString('hex');
  return `pbkdf2_sha256$120000$${salt}$${digest}`;
}

export function verifyPassword(
  password: string,
  passwordHash: string | null | undefined,
): boolean {
  if (!password || !passwordHash) return false;
  const parts = passwordHash.split('$');
  if (parts.length !== 4) return false;
  const [algorithm, rounds, salt, digest] = parts;
  if (algorithm !== 'pbkdf2_sha256' || !/^\d+$/.test(rounds)) return false;
  const check = crypto
    .pbkdf2Sync(password, salt, Number(rounds), 32, 'sha256')
    .toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function expandPermissionCodes(codes: Iterable<string>): Set<string> {
  const values = Array.from(codes);
  const expanded = new Set(values);
  const domainSet: Set<string> = new Set(DOMAINS);
  for (const code of values) {
    if (domainSet.has(code)) expanded.add(`${code}.read`);
  }
  return expanded;
}

export interface BindingRow {
  id: number;
  user_id: number;
  role_id: number;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export function isActiveBinding(
  row: BindingRow | undefined | null,
  now: string,
): boolean {
  if (row == null || row.status !== 'ACTIVE') return false;
  if (row.valid_from && row.valid_from > now) return false;
  if (row.valid_until && row.valid_until < now) return false;
  return true;
}

export function getUser(db: Database, userId: number): any | undefined {
  return db
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(userId);
}

export function getRole(db: Database, roleId: number): any | undefined {
  return db
    .prepare('SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL')
    .get(roleId);
}

export function loadBinding(db: Database, userId: number): BindingRow | undefined {
  return db
    .prepare('SELECT * FROM user_role_bindings WHERE user_id = ?')
    .get(userId) as BindingRow | undefined;
}

export function bindingLabel(
  row: BindingRow | undefined | null,
  now: string,
): 'BOUND' | 'NO_BINDING' {
  return isActiveBinding(row, now) ? 'BOUND' : 'NO_BINDING';
}

export function recalculateUserStatus(db: Database, userId: number): any {
  let user = getUser(db, userId);
  if (user == null) {
    throw new HttpException('user not found', 404);
  }
  if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
    return user;
  }
  const now = utcNow();
  const active =
    user.verification === 'VERIFIED' && isActiveBinding(loadBinding(db, userId), now);
  const status = active ? 'ACTIVE' : 'INACTIVE';
  if (status !== user.status) {
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(
      ...bind([status, now, userId]),
    );
    user = getUser(db, userId);
  }
  return user;
}

export function userItem(row: any, accessBinding: string): Record<string, unknown> {
  return {
    id: row.id,
    identity_type: row.identity_type,
    name: row.name,
    username: row.username,
    email: row.email,
    department: row.department,
    verification: row.verification,
    status: row.status,
    access_binding: accessBinding,
  };
}

export function permissionCatalog(db: Database): any[] {
  return db
    .prepare(
      `
      SELECT id, code, name, domain, action_type, description
      FROM permissions
      ORDER BY domain ASC,
               CASE action_type WHEN 'ALL_ACTIONS' THEN 0 ELSE 1 END ASC,
               code ASC
      `,
    )
    .all();
}

export function rolePermissionItems(db: Database, roleId: number): any[] {
  return db
    .prepare(
      `
      SELECT p.id, p.code, p.name, p.domain, p.action_type, p.description
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?
      ORDER BY p.domain ASC,
               CASE p.action_type WHEN 'ALL_ACTIONS' THEN 0 ELSE 1 END ASC,
               p.code ASC
      `,
    )
    .all(roleId);
}

export function resolvePermissionIds(
  db: Database,
  permissionIds: number[],
): number[] {
  const unique = Array.from(new Set(permissionIds));
  if (unique.length === 0) return [];
  const marks = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, code FROM permissions WHERE id IN (${marks})`)
    .all(...unique) as any[];
  if (rows.length !== unique.length) {
    throw new Error('unknown permission id');
  }
  const codes = expandPermissionCodes(rows.map((row) => row.code as string));
  const codeMarks = Array.from(codes)
    .map(() => '?')
    .join(', ');
  const resolved = db
    .prepare(`SELECT id FROM permissions WHERE code IN (${codeMarks}) ORDER BY id ASC`)
    .all(...Array.from(codes)) as any[];
  if (resolved.length !== codes.size) {
    throw new Error('permission catalog is incomplete');
  }
  return resolved.map((row) => row.id as number);
}

export function replaceRolePermissions(
  db: Database,
  roleId: number,
  permissionIds: number[],
): any[] {
  const resolved = resolvePermissionIds(db, permissionIds);
  const now = utcNow();
  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
  const insert = db.prepare(
    'INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)',
  );
  for (const permissionId of resolved) {
    insert.run(...bind([roleId, permissionId, now]));
  }
  db.prepare('UPDATE roles SET updated_at = ? WHERE id = ?').run(now, roleId);
  return rolePermissionItems(db, roleId);
}

export function assignedUsers(db: Database, roleId: number, now: string): number {
  const rows = db
    .prepare("SELECT * FROM user_role_bindings WHERE role_id = ? AND status = 'ACTIVE'")
    .all(roleId) as BindingRow[];
  return rows.filter((row) => isActiveBinding(row, now)).length;
}

export function roleItem(db: Database, row: any, now: string): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    display_name: displayName(row.name),
    duty_category: row.duty_category,
    description: row.description,
    privilege_narrative: row.privilege_narrative,
    least_privilege_baseline: row.least_privilege_baseline,
    is_system: Boolean(row.is_system),
    is_protected: Boolean(row.is_protected),
    assigned_users: assignedUsers(db, row.id, now),
  };
}

export interface EffectiveAccess {
  user_id: number;
  binding_id: number | null;
  binding_status: string | null;
  role_id: number | null;
  role: string | null;
  permissions: string[];
}

export function effectiveAccess(
  db: Database,
  userId: number,
): EffectiveAccess | null {
  const user = getUser(db, userId);
  if (user == null) return null;
  const binding = loadBinding(db, userId);
  const now = utcNow();
  const active = isActiveBinding(binding, now);
  const payload: EffectiveAccess = {
    user_id: userId,
    binding_id: binding == null ? null : binding.id,
    binding_status: binding == null ? null : binding.status,
    role_id: null,
    role: null,
    permissions: [],
  };
  if (!active || binding == null) {
    return payload;
  }
  const role = getRole(db, binding.role_id);
  if (role == null) {
    return payload;
  }
  payload.role_id = role.id;
  payload.role = role.name;
  payload.permissions = rolePermissionItems(db, role.id).map((item) => item.code as string);
  return payload;
}

const SUPERADMIN_USERNAME = 'superadmin';
const SUPERADMIN_EMAIL = 'superadmin@trackforge.id';
const SUPERADMIN_PASSWORD = 'superadmin';

function grantCodes(
  db: Database,
  roleId: number,
  codes: Iterable<string>,
  now: string,
): void {
  const expanded = Array.from(expandPermissionCodes(codes));
  const marks = expanded.map(() => '?').join(', ');
  const permissions = db
    .prepare(`SELECT id FROM permissions WHERE code IN (${marks})`)
    .all(...expanded) as any[];
  if (permissions.length !== expanded.length) {
    throw new Error('permission catalog is missing a grant');
  }
  const wanted = new Set<number>(permissions.map((row) => row.id as number));
  const current = new Set<number>(
    (
      db
        .prepare('SELECT permission_id FROM role_permissions WHERE role_id = ?')
        .all(roleId) as any[]
    ).map((row) => row.permission_id as number),
  );
  if (wanted.size === current.size && [...wanted].every((id) => current.has(id))) {
    return;
  }
  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
  const insert = db.prepare(
    'INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)',
  );
  for (const permissionId of Array.from(wanted).sort((a, b) => a - b)) {
    insert.run(...bind([roleId, permissionId, now]));
  }
}

export function ensureSuperadminAccount(db: Database): void {
  const now = utcNow();
  const role = db
    .prepare("SELECT id FROM roles WHERE name = 'superadmin' AND deleted_at IS NULL")
    .get() as any;
  if (role == null) return;
  grantCodes(db, role.id, DOMAINS, now);
  let user = db
    .prepare(
      `
      SELECT * FROM users
      WHERE deleted_at IS NULL AND username = ? COLLATE NOCASE
      `,
    )
    .get(SUPERADMIN_USERNAME) as any;
  let userId: number;
  if (user == null) {
    const info = db
      .prepare(
        `
        INSERT INTO users (
          identity_type, name, username, email, password_hash, department, title,
          verification, status, created_at, updated_at
        )
        VALUES ('HUMAN', 'Superadmin', ?, ?, ?, 'Platform Administration', 'Superadmin', 'VERIFIED', 'ACTIVE', ?, ?)
        `,
      )
      .run(
        ...bind([
          SUPERADMIN_USERNAME,
          SUPERADMIN_EMAIL,
          hashPassword(SUPERADMIN_PASSWORD),
          now,
          now,
        ]),
      );
    userId = Number(info.lastInsertRowid);
  } else {
    userId = user.id;
    db.prepare(
      `
      UPDATE users
      SET password_hash = ?,
          email = ?,
          verification = 'VERIFIED',
          status = CASE WHEN status IN ('SUSPENDED', 'DISABLED') THEN 'INACTIVE' ELSE status END,
          updated_at = ?
      WHERE id = ?
      `,
    ).run(...bind([hashPassword(SUPERADMIN_PASSWORD), SUPERADMIN_EMAIL, now, userId]));
  }
  const binding = loadBinding(db, userId);
  if (binding == null) {
    db.prepare(
      `
      INSERT INTO user_role_bindings (
        user_id, role_id, status, description, created_at, updated_at
      )
      VALUES (?, ?, 'ACTIVE', 'Platform administration', ?, ?)
      `,
    ).run(...bind([userId, role.id, now, now]));
  } else if (binding.role_id !== role.id || binding.status !== 'ACTIVE') {
    db.prepare(
      `
      UPDATE user_role_bindings
      SET role_id = ?, status = 'ACTIVE', updated_at = ?
      WHERE id = ?
      `,
    ).run(...bind([role.id, now, binding.id]));
  }
  recalculateUserStatus(db, userId);
}

export function seedAccess(db: Database): void {
  const now = utcNow();
  const permissionCount = (
    db.prepare('SELECT COUNT(*) AS n FROM permissions').get() as any
  ).n as number;
  if (permissionCount === 0) {
    const insertAll = db.prepare(
      `INSERT INTO permissions (code, name, domain, action_type, description, created_at)
       VALUES (?, ?, ?, 'ALL_ACTIONS', ?, ?)`,
    );
    const insertRead = db.prepare(
      `INSERT INTO permissions (code, name, domain, action_type, description, created_at)
       VALUES (?, ?, ?, 'READ', ?, ?)`,
    );
    for (const domain of DOMAINS) {
      const label = domain
        .replace(/_/g, ' ')
        .split(' ')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      insertAll.run(...bind([domain, label, domain, `All actions on ${label}.`, now]));
      insertRead.run(
        ...bind([`${domain}.read`, `${label} Read`, domain, `Read ${label}.`, now]),
      );
    }
  }
  const roleCount = (db.prepare('SELECT COUNT(*) AS n FROM roles').get() as any)
    .n as number;
  if (roleCount === 0) {
    seedRoles(db, now);
  }
  ensureSuperadminAccount(db);
}

function seedRoles(db: Database, now: string): void {
  const insertRole = db.prepare(
    `
    INSERT INTO roles (
      name, duty_category, description, privilege_narrative, least_privilege_baseline,
      is_system, is_protected, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
    `,
  );
  for (const role of SEED_ROLES) {
    const info = insertRole.run(
      ...bind([
        role.name,
        role.duty_category,
        role.description,
        role.privilege_narrative,
        role.least_privilege_baseline,
        now,
        now,
      ]),
    );
    grantCodes(db, Number(info.lastInsertRowid), role.grants, now);
  }
}
