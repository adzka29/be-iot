import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import { getRole, roleItem } from '../database/access';
import { insertAudit, recordAudit } from '../common/audit';
import { utcNow } from '../common/records';
import { bind } from '../common/sql';

@Controller()
export class RolesController {
  constructor(private readonly db: DatabaseService) {}

  private cleanRole(body: any) {
    const name = String(body.name || '')
      .trim()
      .toLowerCase();
    const duty = String(body.duty_category || '').trim();
    const description = String(body.description || '').trim();
    if (!name || !duty || !description) {
      throw new HttpException(
        'name, duty_category, and description are required',
        422,
      );
    }
    const narrative = body.privilege_narrative
      ? String(body.privilege_narrative).trim()
      : null;
    const baseline = body.least_privilege_baseline
      ? String(body.least_privilege_baseline).trim()
      : null;
    return {
      name,
      duty_category: duty,
      description,
      privilege_narrative: narrative || null,
      least_privilege_baseline: baseline || null,
    };
  }

  @Get('roles')
  listRoles() {
    const now = utcNow();
    const rows = this.db.connection
      .prepare('SELECT * FROM roles WHERE deleted_at IS NULL ORDER BY id ASC')
      .all() as any[];
    return {
      items: rows.map((row) => roleItem(this.db.connection, row, now)),
    };
  }

  @Get('roles/summary')
  roleSummary() {
    const row = this.db.connection
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN is_system = 1 THEN 1 ELSE 0 END) AS system_roles,
          SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END) AS protected_roles,
          SUM(CASE WHEN is_system = 0 THEN 1 ELSE 0 END) AS custom_roles
         FROM roles WHERE deleted_at IS NULL`,
      )
      .get() as any;
    return {
      total: row.total || 0,
      system_roles: row.system_roles || 0,
      protected_roles: row.protected_roles || 0,
      custom_roles: row.custom_roles || 0,
    };
  }

  @Post('roles')
  @HttpCode(201)
  createRole(@Body() body: any, @Req() request: Request) {
    const fields = this.cleanRole(body);
    const now = utcNow();
    const conn = this.db.connection;
    try {
      let info;
      try {
        info = conn
          .prepare(
            `INSERT INTO roles (
              name, duty_category, description, privilege_narrative, least_privilege_baseline,
              is_system, is_protected, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          )
          .run(
            ...bind([
              fields.name,
              fields.duty_category,
              fields.description,
              fields.privilege_narrative,
              fields.least_privilege_baseline,
              now,
              now,
            ]),
          );
      } catch (exc: any) {
        if (/UNIQUE/i.test(String(exc?.message))) {
          throw new HttpException('role already exists', 409);
        }
        throw exc;
      }
      const role = getRole(conn, Number(info.lastInsertRowid));
      const item = roleItem(conn, role, now);
      insertAudit(conn, {
        category: 'USER_ACCESS',
        event_type: 'ROLE_CREATED',
        action: 'CREATE',
        target: { id: role.id, name: role.name, type: 'ROLE' },
        description: 'Created role.',
        request,
        metadata: { duty_category: fields.duty_category },
      });
      return item;
    } catch (exc: any) {
      if (exc instanceof HttpException && exc.getStatus() === 409) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'ROLE_CREATED',
          action: 'CREATE',
          outcome: 'FAILED',
          target: { name: fields.name, type: 'ROLE' },
          description: 'Failed to create role.',
          request,
          metadata: { reason: exc.getResponse() },
        });
      }
      throw exc;
    }
  }

  @Get('roles/:roleId/detail')
  roleDetail(@Param('roleId', ParseIntPipe) roleId: number) {
    const now = utcNow();
    const conn = this.db.connection;
    const role = getRole(conn, roleId);
    if (role == null) throw new HttpException('role not found', 404);
    return roleItem(conn, role, now);
  }

  @Put('roles/:roleId')
  updateRole(
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    const fields = this.cleanRole(body);
    const now = utcNow();
    const conn = this.db.connection;
    try {
      const role = getRole(conn, roleId);
      if (role == null) throw new HttpException('role not found', 404);
      if (role.is_protected) {
        throw new HttpException('protected role cannot be modified', 403);
      }
      try {
        conn
          .prepare(
            `UPDATE roles SET name = ?, duty_category = ?, description = ?, privilege_narrative = ?,
             least_privilege_baseline = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            ...bind([
              fields.name,
              fields.duty_category,
              fields.description,
              fields.privilege_narrative,
              fields.least_privilege_baseline,
              now,
              roleId,
            ]),
          );
      } catch (exc: any) {
        if (/UNIQUE/i.test(String(exc?.message))) {
          throw new HttpException('role already exists', 409);
        }
        throw exc;
      }
      const updated = getRole(conn, roleId);
      const item = roleItem(conn, updated, now);
      insertAudit(conn, {
        category: 'USER_ACCESS',
        event_type: 'ROLE_UPDATED',
        action: 'UPDATE',
        target: { id: updated.id, name: updated.name, type: 'ROLE' },
        description: 'Updated role.',
        request,
      });
      return item;
    } catch (exc: any) {
      if (exc instanceof HttpException && exc.getStatus() === 403) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'ACCESS_DENIED',
          action: 'ACCESS',
          outcome: 'DENIED',
          target: { id: String(roleId), type: 'ROLE' },
          description: String(exc.getResponse()),
          request,
        });
      } else if (exc instanceof HttpException && exc.getStatus() === 409) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'ROLE_UPDATED',
          action: 'UPDATE',
          outcome: 'FAILED',
          target: { id: String(roleId), name: fields.name, type: 'ROLE' },
          description: 'Failed to update role.',
          request,
          metadata: { reason: exc.getResponse() },
        });
      }
      throw exc;
    }
  }

  @Delete('roles/:roleId')
  @HttpCode(204)
  deleteRole(@Param('roleId', ParseIntPipe) roleId: number, @Req() request: Request) {
    const now = utcNow();
    const conn = this.db.connection;
    try {
      const role = getRole(conn, roleId);
      if (role == null) throw new HttpException('role not found', 404);
      if (role.is_protected) {
        throw new HttpException('protected role cannot be deleted', 403);
      }
      const active = conn
        .prepare(
          `SELECT 1 FROM user_role_bindings WHERE role_id = ? AND status = 'ACTIVE'`,
        )
        .get(roleId);
      if (active != null) {
        throw new HttpException('role still has an active binding', 409);
      }
      conn
        .prepare('UPDATE roles SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(...bind([now, now, roleId]));
      insertAudit(conn, {
        category: 'USER_ACCESS',
        event_type: 'ROLE_DELETED',
        action: 'DELETE',
        target: { id: role.id, name: role.name, type: 'ROLE' },
        description: 'Deleted role.',
        request,
      });
    } catch (exc: any) {
      if (exc instanceof HttpException && exc.getStatus() === 403) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'ACCESS_DENIED',
          action: 'ACCESS',
          outcome: 'DENIED',
          target: { id: String(roleId), type: 'ROLE' },
          description: String(exc.getResponse()),
          request,
        });
      } else if (exc instanceof HttpException && exc.getStatus() === 409) {
        recordAudit(this.db, {
          category: 'USER_ACCESS',
          event_type: 'ROLE_DELETED',
          action: 'DELETE',
          outcome: 'FAILED',
          target: { id: String(roleId), type: 'ROLE' },
          description: 'Failed to delete role.',
          request,
          metadata: { reason: exc.getResponse() },
        });
      }
      throw exc;
    }
  }
}
