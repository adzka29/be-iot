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
  getRole,
  getUser,
  isActiveBinding,
  loadBinding,
  recalculateUserStatus,
} from '../database/access';
import { insertAudit, recordAudit } from '../common/audit';
import { canonicalTime, utcNow } from '../common/records';
import { bind } from '../common/sql';

@Controller('user-roles')
export class BindingsController {
  constructor(private readonly db: DatabaseService) {}

  private time(value?: string | null) {
    if (value == null || !String(value).trim()) return null;
    try {
      return canonicalTime(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
  }

  private bindingItem(binding: any, user: any, now: string) {
    const role = getRole(this.db.connection, binding.role_id);
    return {
      id: binding.id,
      user_id: binding.user_id,
      role_id: binding.role_id,
      role: role == null ? null : role.name,
      status: binding.status,
      valid_from: binding.valid_from,
      valid_until: binding.valid_until,
      description: binding.description,
      access_binding: bindingLabel(binding, now),
      user_status: user.status,
    };
  }

  @Get()
  list(@Query('user_id') userIdRaw?: string) {
    const now = utcNow();
    const conn = this.db.connection;
    let rows: any[];
    if (userIdRaw == null || userIdRaw === '') {
      rows = conn.prepare('SELECT * FROM user_role_bindings ORDER BY id ASC').all() as any[];
    } else {
      rows = conn
        .prepare('SELECT * FROM user_role_bindings WHERE user_id = ? ORDER BY id ASC')
        .all(Number(userIdRaw)) as any[];
    }
    const items: ReturnType<BindingsController['bindingItem']>[] = [];
    for (const binding of rows) {
      const user = getUser(conn, binding.user_id);
      if (user == null) continue;
      items.push(this.bindingItem(binding, user, now));
    }
    return { items };
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: any, @Req() request: Request) {
    const validFrom = this.time(body.valid_from);
    const validUntil = this.time(body.valid_until);
    if (validFrom && validUntil && validUntil < validFrom) {
      throw new HttpException('valid_until is before valid_from', 400);
    }
    const description = body.description ? String(body.description).trim() : null;
    const now = utcNow();
    const conn = this.db.connection;
    try {
      const user = getUser(conn, body.user_id);
      if (user == null) throw new HttpException('user not found', 404);
      const role = getRole(conn, body.role_id);
      if (role == null) throw new HttpException('role not found', 404);
      const existing = loadBinding(conn, body.user_id);
      if (existing != null && isActiveBinding(existing, now)) {
        throw new HttpException('user already has an active binding', 409);
      }
      let previousRole = null;
      if (existing != null) {
        const previous = getRole(conn, existing.role_id);
        previousRole = previous == null ? null : previous.name;
      }
      let bindingId: number;
      if (existing == null) {
        const info = conn
          .prepare(
            `INSERT INTO user_role_bindings (
              user_id, role_id, status, valid_from, valid_until, description, created_at, updated_at
            ) VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
          )
          .run(
            ...bind([
              body.user_id,
              body.role_id,
              validFrom,
              validUntil,
              description || null,
              now,
              now,
            ]),
          );
        bindingId = Number(info.lastInsertRowid);
      } else {
        conn
          .prepare(
            `UPDATE user_role_bindings
             SET role_id = ?, status = 'ACTIVE', valid_from = ?, valid_until = ?,
                 description = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            ...bind([
              body.role_id,
              validFrom,
              validUntil,
              description || null,
              now,
              existing.id,
            ]),
          );
        bindingId = existing.id;
      }
      const updatedUser = recalculateUserStatus(conn, body.user_id);
      const binding = conn
        .prepare('SELECT * FROM user_role_bindings WHERE id = ?')
        .get(bindingId) as any;
      insertAudit(conn, {
        category: 'USER_ACCESS',
        event_type: 'ROLE_ASSIGNED',
        action: 'ASSIGN',
        target: { id: updatedUser.id, name: updatedUser.name, type: 'USER' },
        description: 'Assigned role to user.',
        request,
        metadata: { previous_role: previousRole, new_role: role.name },
      });
      return this.bindingItem(binding, updatedUser, utcNow());
    } catch (exc: any) {
      if (exc instanceof HttpException && exc.getStatus() === 409) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'ROLE_ASSIGNED',
          action: 'ASSIGN',
          outcome: 'FAILED',
          target: { id: String(body.user_id), type: 'USER' },
          description: 'Failed to assign role.',
          request,
          metadata: { reason: exc.getResponse(), role_id: body.role_id },
        });
      }
      throw exc;
    }
  }

  @Patch(':bindingId/status')
  updateStatus(
    @Param('bindingId', ParseIntPipe) bindingId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    const now = utcNow();
    const conn = this.db.connection;
    const binding = conn
      .prepare('SELECT * FROM user_role_bindings WHERE id = ?')
      .get(bindingId) as any;
    if (binding == null || getUser(conn, binding.user_id) == null) {
      throw new HttpException('binding not found', 404);
    }
    conn
      .prepare('UPDATE user_role_bindings SET status = ?, updated_at = ? WHERE id = ?')
      .run(...bind([body.status, now, bindingId]));
    const user = recalculateUserStatus(conn, binding.user_id);
    const updated = conn
      .prepare('SELECT * FROM user_role_bindings WHERE id = ?')
      .get(bindingId) as any;
    const role = getRole(conn, updated.role_id);
    const eventType =
      body.status === 'REVOKED' || body.status === 'SUSPENDED'
        ? 'ROLE_REVOKED'
        : 'ROLE_ASSIGNED';
    const action = eventType === 'ROLE_REVOKED' ? 'REVOKE' : 'ASSIGN';
    insertAudit(conn, {
      category: 'USER_ACCESS',
      event_type: eventType,
      action,
      target: { id: user.id, name: user.name, type: 'USER' },
      description: 'Updated role assignment.',
      request,
      metadata: { status: body.status, role: role == null ? null : role.name },
    });
    return this.bindingItem(updated, user, utcNow());
  }
}
