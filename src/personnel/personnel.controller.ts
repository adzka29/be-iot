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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import {
  effectiveAccess,
  getUser,
  hasPermission,
  isActiveBinding,
  loadBinding,
} from '../database/access';
import {
  clearGroupLabelFromRecords,
  getGroupById,
  getGroupByName,
  getPersonnelBySoldier,
  retireGroup,
} from '../database/personnel';
import { actorFromSession, sessionToken } from '../common/audit';
import { utcNow } from '../common/records';
import { bind } from '../common/sql';

@Controller()
export class PersonnelController {
  constructor(private readonly db: DatabaseService) {}

  private groupItem(row: any) {
    const count = (
      this.db.connection
        .prepare(
          `SELECT COUNT(*) AS n FROM personnel WHERE group_id = ? AND status = 'ACTIVE'`,
        )
        .get(row.id) as any
    ).n;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      personnel_count: count,
    };
  }

  private personnelItem(row: any) {
    const group =
      row.group_id == null ? null : getGroupById(this.db.connection, row.group_id);
    return {
      id: row.id,
      soldier_id: row.soldier_id,
      name: row.name,
      status: row.status,
      group_id: row.group_id,
      group_name: group?.name ?? null,
      access_group: group == null ? 'UNASSIGNED' : group.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Domain `groups` — Settings Groups / master org. */
  private requireGroups(request: Request, write: boolean) {
    return this.requireDomain(request, 'groups', write);
  }

  /** Domain `personal` — Personnel master (roster names/status). */
  private requirePersonal(request: Request, write: boolean) {
    return this.requireDomain(request, 'personal', write);
  }

  private requireDomain(request: Request, domain: string, write: boolean) {
    const conn = this.db.connection;
    const actor = actorFromSession(conn, sessionToken(request));
    if (actor == null) throw new HttpException('authentication required', 401);
    const user = getUser(conn, actor.id!);
    if (user == null) throw new HttpException('authentication required', 401);
    const access = effectiveAccess(conn, user.id);
    const granted = new Set(access?.permissions ?? []);
    if (!hasPermission(granted, domain, write ? 'write' : 'read')) {
      throw new HttpException('permission denied', 403);
    }
    if (write) {
      if (
        user.identity_type !== 'HUMAN' ||
        user.verification !== 'VERIFIED' ||
        user.status !== 'ACTIVE'
      ) {
        throw new HttpException('account is not active', 403);
      }
      if (!isActiveBinding(loadBinding(conn, user.id), utcNow())) {
        throw new HttpException('account is not active', 403);
      }
    }
    return user;
  }

  // ── Groups master ──────────────────────────────────────────

  @Get('api/groups')
  listGroups(@Req() request: Request) {
    this.requireGroups(request, false);
    const rows = this.db.connection
      .prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE')
      .all() as any[];
    return { items: rows.map((row) => this.groupItem(row)) };
  }

  @Post('api/groups')
  @HttpCode(201)
  createGroup(@Req() request: Request, @Body() body: any) {
    this.requireGroups(request, true);
    const name = String(body.name || '').trim();
    if (!name) throw new HttpException('name is required', 422);
    const description = body.description
      ? String(body.description).trim()
      : null;
    try {
      const info = this.db.connection
        .prepare(
          `INSERT INTO groups (name, description, status) VALUES (?, ?, 'ACTIVE')`,
        )
        .run(...bind([name, description]));
      const row = getGroupById(this.db.connection, Number(info.lastInsertRowid));
      return this.groupItem(row);
    } catch (exc: any) {
      if (/UNIQUE/i.test(String(exc?.message))) {
        throw new HttpException('group already exists', 409);
      }
      throw exc;
    }
  }

  @Get('api/groups/:groupId')
  getGroup(
    @Req() request: Request,
    @Param('groupId', ParseIntPipe) groupId: number,
  ) {
    this.requireGroups(request, false);
    const row = getGroupById(this.db.connection, groupId);
    if (row == null) throw new HttpException('group not found', 404);
    return this.groupItem(row);
  }

  @Patch('api/groups/:groupId')
  updateGroup(
    @Req() request: Request,
    @Param('groupId', ParseIntPipe) groupId: number,
    @Body() body: any,
  ) {
    this.requireGroups(request, true);
    const row = getGroupById(this.db.connection, groupId);
    if (row == null) throw new HttpException('group not found', 404);
    const fields: Record<string, unknown> = {};
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) throw new HttpException('name is required', 422);
      fields.name = name;
    }
    if (body.description !== undefined) {
      fields.description = body.description
        ? String(body.description).trim()
        : null;
    }
    if (body.status != null) {
      if (!['ACTIVE', 'INACTIVE'].includes(body.status)) {
        throw new HttpException('unknown status', 422);
      }
      fields.status = body.status;
    }
    if (!Object.keys(fields).length) {
      throw new HttpException('no group changes', 422);
    }
    const previousName = row.name as string;
    // Retire before rename so Explorer labels under the old name are cleared.
    if (fields.status === 'INACTIVE') {
      retireGroup(this.db.connection, groupId);
      if (fields.name && String(fields.name) !== previousName) {
        clearGroupLabelFromRecords(this.db.connection, previousName);
      }
      // Apply remaining non-status fields (name/description) after retire.
      const rest: Record<string, unknown> = { ...fields };
      delete rest.status;
      if (Object.keys(rest).length) {
        try {
          const assignments = Object.keys(rest)
            .map((c) => `${c} = ?`)
            .join(', ');
          this.db.connection
            .prepare(`UPDATE groups SET ${assignments} WHERE id = ?`)
            .run(...bind([...Object.values(rest), groupId]));
        } catch (exc: any) {
          if (/UNIQUE/i.test(String(exc?.message))) {
            throw new HttpException('group already exists', 409);
          }
          throw exc;
        }
      }
      return this.groupItem(getGroupById(this.db.connection, groupId));
    }
    try {
      const assignments = Object.keys(fields)
        .map((c) => `${c} = ?`)
        .join(', ');
      this.db.connection
        .prepare(`UPDATE groups SET ${assignments} WHERE id = ?`)
        .run(...bind([...Object.values(fields), groupId]));
    } catch (exc: any) {
      if (/UNIQUE/i.test(String(exc?.message))) {
        throw new HttpException('group already exists', 409);
      }
      throw exc;
    }
    return this.groupItem(getGroupById(this.db.connection, groupId));
  }

  // ── Personnel master ───────────────────────────────────────

  @Get('api/personnel')
  listPersonnel(@Req() request: Request, @Query() q: any) {
    this.requirePersonal(request, false);
    const conditions = ['1 = 1'];
    const params: unknown[] = [];
    if (q.status) {
      conditions.push('status = ?');
      params.push(q.status);
    }
    if (q.group_id === 'null' || q.unassigned === '1' || q.unassigned === 'true') {
      conditions.push('group_id IS NULL');
    } else if (q.group_id != null && q.group_id !== '') {
      conditions.push('group_id = ?');
      params.push(Number(q.group_id));
    }
    if (q.q && String(q.q).trim()) {
      const needle = `%${String(q.q).trim()}%`;
      conditions.push('(name LIKE ? OR CAST(soldier_id AS TEXT) LIKE ?)');
      params.push(needle, needle);
    }
    const page = Math.max(Number(q.page || 1), 1);
    const limit = Math.min(Math.max(Number(q.limit || 50), 1), 200);
    const where = conditions.join(' AND ');
    const total = (
      this.db.connection
        .prepare(`SELECT COUNT(*) AS n FROM personnel WHERE ${where}`)
        .get(...bind(params)) as any
    ).n;
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM personnel WHERE ${where}
         ORDER BY soldier_id ASC LIMIT ? OFFSET ?`,
      )
      .all(...bind([...params, limit, (page - 1) * limit])) as any[];
    return {
      items: rows.map((row) => this.personnelItem(row)),
      total,
      page,
      limit,
    };
  }

  @Get('api/personnel/:personnelId')
  getPersonnel(
    @Req() request: Request,
    @Param('personnelId', ParseIntPipe) personnelId: number,
  ) {
    this.requirePersonal(request, false);
    const row = this.db.connection
      .prepare('SELECT * FROM personnel WHERE id = ?')
      .get(personnelId) as any;
    if (row == null) throw new HttpException('personnel not found', 404);
    return this.personnelItem(row);
  }

  @Post('api/personnel')
  @HttpCode(201)
  createPersonnel(@Req() request: Request, @Body() body: any) {
    this.requirePersonal(request, true);
    const soldierId = Number(body.soldier_id);
    if (!Number.isFinite(soldierId)) {
      throw new HttpException('soldier_id is required', 422);
    }
    const name = String(body.name || `Soldier ${soldierId}`).trim();
    if (!name) throw new HttpException('name is required', 422);
    let groupId: number | null = null;
    if (body.group_id != null && body.group_id !== '') {
      const group = getGroupById(this.db.connection, Number(body.group_id));
      if (group == null) throw new HttpException('group not found', 404);
      groupId = group.id;
    } else if (body.group_name) {
      const group = getGroupByName(this.db.connection, String(body.group_name));
      if (group == null) throw new HttpException('group not found', 404);
      groupId = group.id;
    }
    const now = utcNow();
    try {
      const info = this.db.connection
        .prepare(
          `INSERT INTO personnel (soldier_id, name, group_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .run(...bind([soldierId, name, groupId, now, now]));
      const row = this.db.connection
        .prepare('SELECT * FROM personnel WHERE id = ?')
        .get(Number(info.lastInsertRowid));
      return this.personnelItem(row);
    } catch (exc: any) {
      if (/UNIQUE/i.test(String(exc?.message))) {
        throw new HttpException('soldier_id already exists', 409);
      }
      throw exc;
    }
  }

  @Patch('api/personnel/:personnelId')
  updatePersonnel(
    @Req() request: Request,
    @Param('personnelId', ParseIntPipe) personnelId: number,
    @Body() body: any,
  ) {
    this.requirePersonal(request, true);
    const row = this.db.connection
      .prepare('SELECT * FROM personnel WHERE id = ?')
      .get(personnelId) as any;
    if (row == null) throw new HttpException('personnel not found', 404);
    const fields: Record<string, unknown> = {};
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) throw new HttpException('name is required', 422);
      fields.name = name;
    }
    if (body.status != null) {
      if (!['ACTIVE', 'INACTIVE'].includes(body.status)) {
        throw new HttpException('unknown status', 422);
      }
      fields.status = body.status;
    }
    if ('group_id' in (body || {})) {
      if (body.group_id == null || body.group_id === '') {
        fields.group_id = null;
      } else {
        const group = getGroupById(this.db.connection, Number(body.group_id));
        if (group == null) throw new HttpException('group not found', 404);
        fields.group_id = group.id;
      }
    }
    if (!Object.keys(fields).length) {
      throw new HttpException('no personnel changes', 422);
    }
    fields.updated_at = utcNow();
    const assignments = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.db.connection
      .prepare(`UPDATE personnel SET ${assignments} WHERE id = ?`)
      .run(...bind([...Object.values(fields), personnelId]));
    const updated = this.db.connection
      .prepare('SELECT * FROM personnel WHERE id = ?')
      .get(personnelId);
    return this.personnelItem(updated);
  }

  @Put('api/personnel/by-soldier/:soldierId/group')
  assignGroupBySoldier(
    @Req() request: Request,
    @Param('soldierId', ParseIntPipe) soldierId: number,
    @Body() body: any,
  ) {
    // Assign touches both domains; require write on personal (roster) + groups.
    this.requirePersonal(request, true);
    this.requireGroups(request, true);
    let person = getPersonnelBySoldier(this.db.connection, soldierId);
    if (person == null) {
      const now = utcNow();
      const info = this.db.connection
        .prepare(
          `INSERT INTO personnel (soldier_id, name, group_id, status, created_at, updated_at)
           VALUES (?, ?, NULL, 'ACTIVE', ?, ?)`,
        )
        .run(...bind([soldierId, `Soldier ${soldierId}`, now, now]));
      person = this.db.connection
        .prepare('SELECT * FROM personnel WHERE id = ?')
        .get(Number(info.lastInsertRowid));
    }
    let groupId: number | null = null;
    if (body.group_id != null && body.group_id !== '') {
      const group = getGroupById(this.db.connection, Number(body.group_id));
      if (group == null) throw new HttpException('group not found', 404);
      groupId = group.id;
    } else if (body.group_name) {
      const group = getGroupByName(this.db.connection, String(body.group_name));
      if (group == null) throw new HttpException('group not found', 404);
      groupId = group.id;
    }
    // body.group_id === null → unassign
    this.db.connection
      .prepare('UPDATE personnel SET group_id = ?, updated_at = ? WHERE id = ?')
      .run(...bind([groupId, utcNow(), person.id]));
    const updated = this.db.connection
      .prepare('SELECT * FROM personnel WHERE id = ?')
      .get(person.id);
    return this.personnelItem(updated);
  }
}
