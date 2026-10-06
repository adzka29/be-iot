import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  bindingLabel,
  effectiveAccess,
  getUser,
  hashPassword,
  loadBinding,
  recalculateUserStatus,
  userItem,
  verifyPassword,
} from '../database/access';
import {
  actorForUser,
  actorFromSession,
  createSession,
  insertAudit,
  recordAudit,
  sessionToken,
} from '../common/audit';
import { utcNow } from '../common/records';
import { bind } from '../common/sql';

const IDENTITY_TYPES = new Set(['HUMAN', 'SERVICE']);
const STATUSES = new Set(['INACTIVE', 'ACTIVE', 'SUSPENDED', 'DISABLED']);
const VERIFICATIONS = new Set(['PENDING', 'VERIFIED']);
const BINDINGS = new Set(['BOUND', 'NO_BINDING']);

@Controller('users')
export class UsersController {
  constructor(private readonly db: DatabaseService) {}

  private required(value: string, field: string) {
    const text = value.trim();
    if (!text) throw new HttpException(`${field} is required`, 422);
    return text;
  }

  private email(value: string) {
    const text = this.required(value, 'email').toLowerCase();
    if (!text.includes('@') || text.startsWith('@') || text.endsWith('@')) {
      throw new HttpException('email is invalid', 422);
    }
    return text;
  }

  private optional(value?: string | null) {
    if (value == null) return null;
    const text = value.trim();
    return text || null;
  }

  private bindingExists(now: string): [string, unknown[]] {
    return [
      `EXISTS (
        SELECT 1 FROM user_role_bindings b
        WHERE b.user_id = users.id
          AND b.status = 'ACTIVE'
          AND (b.valid_from IS NULL OR b.valid_from <= ?)
          AND (b.valid_until IS NULL OR b.valid_until >= ?)
      )`,
      [now, now],
    ];
  }

  @Get()
  list(@Query() q: any) {
    if (q.identity_type && !IDENTITY_TYPES.has(q.identity_type)) {
      throw new HttpException('unknown identity_type', 400);
    }
    if (q.status && !STATUSES.has(q.status)) {
      throw new HttpException('unknown status', 400);
    }
    if (q.verification && !VERIFICATIONS.has(q.verification)) {
      throw new HttpException('unknown verification', 400);
    }
    if (q.access_binding && !BINDINGS.has(q.access_binding)) {
      throw new HttpException('unknown access_binding', 400);
    }
    const now = utcNow();
    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (q.identity_type) {
      conditions.push('identity_type = ?');
      params.push(q.identity_type);
    }
    if (q.status) {
      conditions.push('status = ?');
      params.push(q.status);
    }
    if (q.verification) {
      conditions.push('verification = ?');
      params.push(q.verification);
    }
    if (q.access_binding) {
      const [clause, clauseParams] = this.bindingExists(now);
      conditions.push(q.access_binding === 'BOUND' ? clause : `NOT ${clause}`);
      params.push(...clauseParams);
    }
    if (q.q && String(q.q).trim()) {
      const needle = `%${String(q.q).trim()}%`;
      conditions.push(
        `(name LIKE ? OR IFNULL(username, '') LIKE ? OR IFNULL(email, '') LIKE ?)`,
      );
      params.push(needle, needle, needle);
    }
    const where = conditions.join(' AND ');
    const page = Math.max(Number(q.page || 1), 1);
    const limit = Math.min(Math.max(Number(q.limit || 20), 1), 100);
    const conn = this.db.connection;
    const total = (
      conn.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get(...bind(params)) as any
    ).n;
    const rows = conn
      .prepare(
        `SELECT id, identity_type, name, username, email, department, verification, status
         FROM users WHERE ${where} ORDER BY id ASC LIMIT ? OFFSET ?`,
      )
      .all(...bind([...params, limit, (page - 1) * limit])) as any[];
    const items = rows.map((row) =>
      userItem(row, bindingLabel(loadBinding(conn, row.id), now)),
    );
    return { items, total, page, limit };
  }

  @Get('summary')
  summary() {
    const row = this.db.connection
      .prepare(
        `SELECT
          SUM(CASE WHEN identity_type = 'HUMAN' THEN 1 ELSE 0 END) AS total_humans,
          SUM(CASE WHEN identity_type = 'HUMAN' AND status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_humans,
          SUM(CASE WHEN identity_type = 'HUMAN' AND status = 'INACTIVE' THEN 1 ELSE 0 END) AS inactive_humans,
          SUM(CASE WHEN identity_type = 'SERVICE' THEN 1 ELSE 0 END) AS total_services,
          SUM(CASE WHEN identity_type = 'HUMAN' AND verification = 'PENDING' THEN 1 ELSE 0 END) AS pending_verification
         FROM users WHERE deleted_at IS NULL`,
      )
      .get() as any;
    return {
      total_humans: row.total_humans || 0,
      active_humans: row.active_humans || 0,
      inactive_humans: row.inactive_humans || 0,
      total_services: row.total_services || 0,
      pending_verification: row.pending_verification || 0,
    };
  }

  @Post('human')
  @HttpCode(201)
  createHuman(@Body() body: any, @Req() request: Request) {
    const name = this.required(body.name || '', 'name');
    const username = this.required(body.username || '', 'username');
    const email = this.email(body.email || '');
    const password = String(body.password || '').trim();
    if (password.length < 8) {
      throw new HttpException('password must be at least 8 characters', 422);
    }
    const now = utcNow();
    const metadata = {
      username,
      email,
      department: this.optional(body.department),
    };
    const conn = this.db.connection;
    try {
      let info;
      try {
        info = conn
          .prepare(
            `INSERT INTO users (
              identity_type, name, username, email, password_hash, department, title,
              verification, status, created_at, updated_at
            ) VALUES ('HUMAN', ?, ?, ?, ?, ?, ?, 'VERIFIED', 'INACTIVE', ?, ?)`,
          )
          .run(
            ...bind([
              name,
              username,
              email,
              hashPassword(password),
              this.optional(body.department),
              this.optional(body.title),
              now,
              now,
            ]),
          );
      } catch (exc: any) {
        if (/UNIQUE/i.test(String(exc?.message))) {
          throw new HttpException('username or email already exists', 409);
        }
        throw exc;
      }
      const user = getUser(conn, Number(info.lastInsertRowid));
      insertAudit(conn, {
        category: 'USER_ACCESS',
        event_type: 'USER_CREATED',
        action: 'CREATE',
        target: { id: user.id, name: user.name, type: 'USER' },
        description: 'Created new human identity.',
        request,
        metadata,
      });
      return {
        id: user.id,
        name: user.name,
        verification: user.verification,
        access_binding: 'NO_BINDING',
        status: user.status,
      };
    } catch (exc: any) {
      if (exc instanceof HttpException && exc.getStatus() === 409) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'USER_CREATED',
          action: 'CREATE',
          outcome: 'FAILED',
          target: { name, type: 'USER' },
          description: 'Failed to create human identity.',
          request,
          metadata: { ...metadata, reason: (exc.getResponse() as any) },
        });
      }
      throw exc;
    }
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: any, @Req() request: Request) {
    const account = String(body.account || '').trim();
    const password = String(body.password || '').trim();
    if (!account || !password) {
      throw new HttpException('invalid account or password', 401);
    }
    let failureActor: any = null;
    let failureEvent = 'LOGIN_FAILED';
    let failureOutcome = 'FAILED';
    let failureDescription = 'Login failed.';
    const conn = this.db.connection;
    try {
      let user = conn
        .prepare(
          `SELECT * FROM users WHERE deleted_at IS NULL AND username = ? COLLATE NOCASE`,
        )
        .get(account) as any;
      if (user == null) {
        user = conn
          .prepare(`SELECT * FROM users WHERE deleted_at IS NULL AND email = ?`)
          .get(account.toLowerCase()) as any;
      }
      if (user == null || !verifyPassword(password, user.password_hash)) {
        if (user != null) failureActor = actorForUser(conn, user);
        throw new HttpException('invalid account or password', 401);
      }
      failureActor = actorForUser(conn, user);
      if (user.identity_type !== 'HUMAN') {
        failureEvent = 'ACCESS_DENIED';
        failureOutcome = 'DENIED';
        failureDescription = 'Account is not human.';
        throw new HttpException('account is not human', 403);
      }
      if (user.verification !== 'VERIFIED') {
        failureEvent = 'ACCESS_DENIED';
        failureOutcome = 'DENIED';
        failureDescription = 'Account is not verified.';
        throw new HttpException('account is not verified', 403);
      }
      if (user.status !== 'ACTIVE') {
        failureEvent = 'ACCESS_DENIED';
        failureOutcome = 'DENIED';
        failureDescription = 'Account is not active.';
        throw new HttpException('account is not active', 403);
      }
      const sessionId = createSession(conn, user.id);
      const actor = actorForUser(conn, user);
      insertAudit(conn, {
        actor,
        category: 'AUTHENTICATION',
        event_type: 'USER_LOGIN',
        action: 'LOGIN',
        target: { id: user.id, name: user.name, type: 'USER' },
        description: 'Signed in.',
        request,
        session_id: sessionId,
      });
      return {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        department: user.department,
        verification: user.verification,
        status: user.status,
        access: effectiveAccess(conn, user.id),
        session_id: sessionId,
      };
    } catch (exc: any) {
      if (
        exc instanceof HttpException &&
        (exc.getStatus() === 401 || exc.getStatus() === 403)
      ) {
        recordAudit(this.db, {
          actor: failureActor,
          category: 'AUTHENTICATION',
          event_type: failureEvent,
          action: failureEvent === 'LOGIN_FAILED' ? 'LOGIN' : 'ACCESS',
          outcome: failureOutcome,
          target: { name: account, type: 'USER' },
          description: failureDescription,
          request,
          metadata: { account },
        });
      }
      throw exc;
    }
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Req() request: Request) {
    const token = sessionToken(request);
    const conn = this.db.connection;
    const actor = actorFromSession(conn, token);
    if (actor == null) throw new HttpException('authentication required', 401);
    conn.prepare('DELETE FROM user_sessions WHERE id = ?').run(token);
    insertAudit(conn, {
      actor,
      category: 'AUTHENTICATION',
      event_type: 'USER_LOGOUT',
      action: 'LOGOUT',
      target: { id: actor.id, name: actor.name, type: 'USER' },
      description: 'Signed out.',
      request,
      session_id: token,
    });
  }

  @Get(':userId/permissions')
  permissions(@Param('userId', ParseIntPipe) userId: number) {
    const access = effectiveAccess(this.db.connection, userId);
    if (access == null) throw new HttpException('user not found', 404);
    return access;
  }

  @Patch(':userId/human')
  updateHuman(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    const conn = this.db.connection;
    try {
      const user = getUser(conn, userId);
      if (user == null) throw new HttpException('user not found', 404);
      const fields: Record<string, unknown> = {};
      if (body.name != null) fields.name = this.required(body.name, 'name');
      if (body.username != null) fields.username = this.required(body.username, 'username');
      if (body.email != null) fields.email = this.email(body.email);
      if (body.department != null) fields.department = this.optional(body.department);
      if (body.title != null) fields.title = this.optional(body.title);
      if (body.sponsor != null) fields.sponsor = this.optional(body.sponsor);
      if (body.verification != null) fields.verification = body.verification;
      if (Object.keys(fields).length) {
        fields.updated_at = utcNow();
        const assignments = Object.keys(fields)
          .map((c) => `${c} = ?`)
          .join(', ');
        try {
          conn
            .prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
            .run(...bind([...Object.values(fields), userId]));
        } catch (exc: any) {
          if (/UNIQUE/i.test(String(exc?.message))) {
            throw new HttpException('username or email already exists', 409);
          }
          throw exc;
        }
      }
      const updated = recalculateUserStatus(conn, userId);
      const now = utcNow();
      const item: any = userItem(updated, bindingLabel(loadBinding(conn, userId), now));
      item.title = updated.title;
      item.sponsor = updated.sponsor;
      if (Object.keys(fields).length) {
        insertAudit(conn, {
          category: 'USER_ACCESS',
          event_type: 'USER_UPDATED',
          action: 'UPDATE',
          target: { id: updated.id, name: updated.name, type: 'USER' },
          description: 'Updated human identity.',
          request,
          metadata: {
            changed_fields: Object.keys(fields).filter((k) => k !== 'updated_at'),
          },
        });
      }
      return item;
    } catch (exc: any) {
      if (exc instanceof HttpException && exc.getStatus() === 409) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'USER_UPDATED',
          action: 'UPDATE',
          outcome: 'FAILED',
          target: { id: String(userId), type: 'USER' },
          description: 'Failed to update human identity.',
          request,
          metadata: { reason: exc.getResponse() },
        });
      }
      throw exc;
    }
  }
}
