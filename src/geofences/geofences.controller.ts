import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseIntPipe,
  Post,
  Body,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { bind } from '../common/sql';
import { utcNow } from '../common/records';

@Controller('api/geofences')
export class GeofencesController {
  constructor(private readonly db: DatabaseService) {}

  private areaKm2(points: number[][]): number {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const [lng, lat] = points[index];
      const [nextLng, nextLat] = points[(index + 1) % points.length];
      area += lng * nextLat - nextLng * lat;
    }
    area = Math.abs(area) / 2;
    const meanLat = points.reduce((s, p) => s + p[1], 0) / points.length;
    const kmLat = 111.32;
    const kmLng = 111.32 * Math.cos((meanLat * Math.PI) / 180);
    return Math.round(area * kmLat * kmLng * 10) / 10;
  }

  private rowToApi(row: any) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      status: row.status,
      groups: JSON.parse(row.groups_json),
      polygon: JSON.parse(row.polygon_json),
      area_km2: row.area_km2,
      triggered_24h: 0,
      last_triggered: null,
      created_at: row.created_at,
    };
  }

  private cleanBody(body: any) {
    const name = String(body.name || '').trim();
    if (!name) throw new HttpException('name is required', 422);
    if (name.length > 80) throw new HttpException('name is too long', 422);
    const description = String(body.description ?? '').trim().slice(0, 200);
    const status = body.status ?? 'active';
    if (status !== 'active' && status !== 'inactive') {
      throw new HttpException({ message: ['status must be active or inactive'] }, 400);
    }
    const groups: string[] = [];
    for (const item of body.groups || []) {
      const g = String(item).trim().slice(0, 40);
      if (g && !groups.includes(g)) groups.push(g);
    }
    if (groups.length > 8) throw new HttpException('too many groups', 422);
    const polygon = body.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 3) {
      throw new HttpException('polygon must have 3 corners', 422);
    }
    const points: number[][] = [];
    for (const point of polygon) {
      if (!Array.isArray(point) || point.length !== 2) {
        throw new HttpException('each corner needs longitude and latitude', 422);
      }
      const lng = Number(point[0]);
      const lat = Number(point[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw new HttpException('corner is not a number', 422);
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new HttpException('corner is outside the map', 422);
      }
      points.push([lng, lat]);
    }
    return { name, description, status, groups, polygon: points };
  }

  @Get()
  list() {
    const rows = this.db.connection
      .prepare('SELECT * FROM geofences ORDER BY id DESC')
      .all() as any[];
    return { items: rows.map((r) => this.rowToApi(r)) };
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: any) {
    const cleaned = this.cleanBody(body);
    const createdAt = utcNow();
    const area = this.areaKm2(cleaned.polygon);
    const info = this.db.connection
      .prepare(
        `INSERT INTO geofences (name, description, type, status, groups_json, polygon_json, area_km2, created_at)
         VALUES (?, ?, 'silent', ?, ?, ?, ?, ?)`,
      )
      .run(
        ...bind([
          cleaned.name,
          cleaned.description,
          cleaned.status,
          JSON.stringify(cleaned.groups),
          JSON.stringify(cleaned.polygon),
          area,
          createdAt,
        ]),
      );
    const row = this.db.connection
      .prepare('SELECT * FROM geofences WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    return this.rowToApi(row);
  }

  @Delete(':geofenceId')
  @HttpCode(204)
  remove(@Param('geofenceId', ParseIntPipe) geofenceId: number) {
    const info = this.db.connection
      .prepare('DELETE FROM geofences WHERE id = ?')
      .run(geofenceId);
    if (info.changes === 0) throw new HttpException('Geofence not found', 404);
  }
}
