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
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  getGroupById,
  getGroupByName,
  getPersonnelBySoldier,
} from '../database/personnel';
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

  // ── Groups master ──────────────────────────────────────────

  @Get('api/groups')
  listGroups() {
    const rows = this.db.connection
      .prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE')
      .all() as any[];
    return { items: rows.map((row) => this.groupItem(row)) };
  }

  @Post('api/groups')
  @HttpCode(201)
  createGroup(@Body() body: any) {
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
  getGroup(@Param('groupId', ParseIntPipe) groupId: number) {
    const row = getGroupById(this.db.connection, groupId);
    if (row == null) throw new HttpException('group not found', 404);
    return this.groupItem(row);
  }

  @Patch('api/groups/:groupId')
  updateGroup(
    @Param('groupId', ParseIntPipe) groupId: number,
    @Body() body: any,
  ) {
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
  listPersonnel(@Query() q: any) {
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
  getPersonnel(@Param('personnelId', ParseIntPipe) personnelId: number) {
    const row = this.db.connection
      .prepare('SELECT * FROM personnel WHERE id = ?')
      .get(personnelId) as any;
    if (row == null) throw new HttpException('personnel not found', 404);
    return this.personnelItem(row);
  }

  @Post('api/personnel')
  @HttpCode(201)
  createPersonnel(@Body() body: any) {
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
    @Param('personnelId', ParseIntPipe) personnelId: number,
    @Body() body: any,
  ) {
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
    @Param('soldierId', ParseIntPipe) soldierId: number,
    @Body() body: any,
  ) {
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
