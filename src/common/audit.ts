import { HttpException } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import * as crypto from 'crypto';
import { Request } from 'express';
import { displayName, effectiveAccess } from '../database/access';
import { bind } from './sql';
import { canonicalTime, utcNow } from './records';

export const CATEGORIES = [
  'AUTHENTICATION',
  'PERSONNEL',
  'GROUPS',
  'WEAPONS',
  'OPERATIONS',
  'ALERTS',
  'TICKETS',
  'HISTORY',
  'COMMUNICATION',
  'USER_ACCESS',
  'SETTINGS',
  'REPORTS',
  'SYSTEM',
] as const;

export const ACTIONS = [
  'VIEW',
  'CREATE',
  'UPDATE',
  'DELETE',
  'ASSIGN',
  'REVOKE',
  'ACKNOWLEDGE',
  'RESOLVE',
  'EXPORT',
  'LOGIN',
  'LOGOUT',
  'ACCESS',
] as const;

export const OUTCOMES = ['SUCCESS', 'FAILED', 'DENIED'] as const;

const SECRET_PARTS = ['password', 'token', 'secret', 'jwt', 'api_key', 'authorization'];

export type AuditActor = {
  id?: number | null;
  name?: string | null;
  role?: string | null;
  type?: string;
};

export function displayLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return code
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function cleanMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SECRET_PARTS.some((part) => key.toLowerCase().includes(part))) {
      cleaned[key] = value;
    }
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

export function sessionToken(req?: Request | null): string | null {
  if (!req) return null;
  const header = (req.headers['authorization'] as string) || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const sid = ((req.headers['x-session-id'] as string) || '').trim();
  return sid || null;
}

export function createSession(db: Database, userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const created = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(...bind([token, userId, created, expires]));
  return token;
}

export function actorFromSession(
  db: Database,
  token: string | null | undefined,
): AuditActor | null {
  if (!token) return null;
  const row = db
    .prepare(
      `
      SELECT u.id, u.name
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ? AND u.deleted_at IS NULL
      `,
    )
    .get(token, utcNow()) as any;
  if (row == null) return null;
  const access = effectiveAccess(db, row.id);
  const role = access?.role ? displayName(access.role) : null;
  return { id: row.id, name: row.name, role, type: 'USER' };
}

export function actorForUser(db: Database, user: any): AuditActor {
  const access = effectiveAccess(db, user.id);
  const role = access?.role ? displayName(access.role) : null;
  return { id: user.id, name: user.name, role, type: 'USER' };
}

function clientIp(req?: Request | null): string | null {
  if (!req) return null;
  return (req.ip || req.socket?.remoteAddress || null) as string | null;
}

function nextEventId(db: Database, now: string): string {
  const prefix = `EVT-${now.slice(0, 10).replace(/-/g, '')}-`;
  const row = db
    .prepare(
      `
      SELECT event_id FROM audit_logs
      WHERE event_id LIKE ?
      ORDER BY event_id DESC
      LIMIT 1
      `,
    )
    .get(`${prefix}%`) as any;
  let sequence = 1;
  if (row != null) {
    sequence = Number(String(row.event_id).split('-').pop()) + 1;
  }
  return `${prefix}${String(sequence).padStart(6, '0')}`;
}

export type InsertAuditArgs = {
  category: string;
  event_type: string;
  action: string;
  actor?: AuditActor | null;
  target?: Record<string, unknown> | null;
  outcome?: string;
  description?: string | null;
  request?: Request | null;
  metadata?: Record<string, unknown> | null;
  session_id?: string | null;
};

export function insertAudit(db: Database, args: InsertAuditArgs): string {
  const category = args.category;
  const action = args.action;
  const outcome = args.outcome ?? 'SUCCESS';
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new HttpException('unknown category', 400);
  }
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new HttpException('unknown action', 400);
  }
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new HttpException('unknown outcome', 400);
  }
  const now = utcNow();
  const token =
    args.session_id !== undefined && args.session_id !== null
      ? args.session_id
      : sessionToken(args.request);
  let actor = args.actor;
  if (actor === undefined) {
    actor = actorFromSession(db, token);
  }
  const resolvedType = actor?.type || (actor ? 'USER' : 'SYSTEM');
  const target = args.target || {};
  const safeMetadata = cleanMetadata(args.metadata);
  const eventId = nextEventId(db, now);
  for (let offset = 0; offset < 5; offset += 1) {
    const candidate =
      offset === 0
        ? eventId
        : `${eventId.slice(0, -6)}${String(Number(eventId.slice(-6)) + offset).padStart(6, '0')}`;
    try {
      db.prepare(
        `
        INSERT INTO audit_logs (
          event_id, timestamp, actor_id, actor_name, actor_role, actor_type,
          category, action, event_type, target_id, target_name, target_type,
          outcome, description, ip_address, user_agent, session_id, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        ...bind([
          candidate,
          now,
          actor == null ? null : actor.id ?? null,
          actor == null ? null : actor.name ?? null,
          actor == null ? null : actor.role ?? null,
          resolvedType,
          category,
          action,
          args.event_type,
          target.id == null ? null : String(target.id),
          (target.name as string) ?? null,
          (target.type as string) ?? null,
          outcome,
          args.description ?? null,
          clientIp(args.request),
          args.request
            ? ((args.request.headers['user-agent'] as string) ?? null)
            : null,
          token,
          safeMetadata == null ? null : JSON.stringify(safeMetadata),
          now,
        ]),
      );
      return candidate;
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(String(err?.message))) {
        continue;
      }
      throw err;
    }
  }
  throw new HttpException('could not write audit log', 500);
}

export function recordAudit(
  dbService: { connection: Database },
  args: InsertAuditArgs,
): void {
  const db = dbService.connection;
  const payload = { ...args };
  if (payload.actor == null) {
    payload.actor = actorFromSession(db, sessionToken(payload.request));
  }
  insertAudit(db, payload);
}

export function normalizeAuditCode(
  value: string | null | undefined,
  allowed: readonly string[],
  label: string,
): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase().replace(/ /g, '_');
  if (!allowed.includes(code)) {
    throw new HttpException(`unknown ${label}`, 400);
  }
  return code;
}

export function auditTimeBound(value: string): string {
  try {
    return canonicalTime(value);
  } catch (exc: any) {
    throw new HttpException(String(exc.message || exc), 400);
  }
}
