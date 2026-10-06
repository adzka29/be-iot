import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { bind } from '../common/sql';
import { seedExplorer } from './seed-explorer';
import { seedAlerts } from './alert-rules';
import { seedAccess } from './access';

export const CATEGORIES = [
  'TELEMETRY',
  'MESH',
  'UPLINK',
  'BEACON',
  'SPECIAL',
  'SYSTEM',
] as const;

const COLUMNS = [
  'category',
  'data_type',
  'entity_type',
  'entity_id',
  'soldier_id',
  'group_id',
  'gateway_id',
  'beacon_id',
  'event_time',
  'received_at',
  'position_source',
  'transport',
  'freshness',
  'severity',
  'record_origin',
  'raw_format',
  'raw_hex',
  'raw_bytes_length',
  'data_json',
  'is_sos',
  'created_at',
] as const;

const PUBLIC_FIELDS = [
  'id',
  'category',
  'data_type',
  'entity_type',
  'entity_id',
  'soldier_id',
  'group_id',
  'gateway_id',
  'event_time',
  'received_at',
  'position_source',
  'transport',
  'freshness',
  'severity',
  'record_origin',
  'raw_format',
  'raw_hex',
  'raw_bytes_length',
  'created_at',
] as const;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: Database.Database;

  onModuleInit() {
    this.open();
    this.initDb();
  }

  onModuleDestroy() {
    this.close();
  }

  get connection(): Database.Database {
    return this.db;
  }

  dbPath(): string {
    const override = process.env.TRACKFORGE_DB;
    if (override) return override;
    return path.join(process.cwd(), 'data', 'trackforge.db');
  }

  open(dbFile?: string) {
    const file = dbFile ?? this.dbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
    }
    this.db = new Database(file, { timeout: 5000 });
    this.db.pragma('foreign_keys = ON');
  }

  close() {
    if (this.db) this.db.close();
  }

  initDb() {
    const conn = this.db;
    const categoryCheck = CATEGORIES.map((c) => `'${c}'`).join(', ');

    const existing = conn
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'explorer_records'",
      )
      .get() as { name: string } | undefined;
    if (existing) {
      const columns = new Set(
        (
          conn.prepare('PRAGMA table_info(explorer_records)').all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      if (!columns.has('entity_type') || !columns.has('record_origin')) {
        conn.exec('DROP TABLE explorer_records');
      }
    }

    conn.exec(`
      CREATE TABLE IF NOT EXISTS explorer_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN (${categoryCheck})),
        data_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        soldier_id INTEGER,
        group_id TEXT,
        gateway_id TEXT,
        beacon_id TEXT,
        event_time TEXT NOT NULL,
        received_at TEXT NOT NULL,
        position_source TEXT,
        transport TEXT,
        freshness TEXT,
        severity TEXT,
        record_origin TEXT,
        raw_format TEXT,
        raw_hex TEXT,
        raw_bytes_length INTEGER,
        data_json TEXT NOT NULL,
        is_sos INTEGER NOT NULL DEFAULT 0 CHECK (is_sos IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_explorer_list
        ON explorer_records (is_sos, event_time, id);
      CREATE INDEX IF NOT EXISTS idx_explorer_category
        ON explorer_records (is_sos, category, data_type);
    `);

    const count = (
      conn.prepare('SELECT COUNT(*) AS n FROM explorer_records').get() as {
        n: number;
      }
    ).n;
    if (count === 0 && process.env.TRACKFORGE_SEED !== '0') {
      seedExplorer(conn);
    }

    const existingAlerts = conn
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alerts'",
      )
      .get() as { name: string } | undefined;
    if (existingAlerts) {
      const columns = new Set(
        (
          conn.prepare('PRAGMA table_info(alerts)').all() as { name: string }[]
        ).map((r) => r.name),
      );
      if (!columns.has('alert_code') || !columns.has('first_seen_at')) {
        conn.exec('DROP TABLE alerts');
      }
    }
    conn.exec('DROP INDEX IF EXISTS idx_alerts_dedupe');
    conn.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_code TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        soldier_id INTEGER,
        group_id TEXT,
        gateway_id TEXT,
        source_record_id INTEGER,
        event_time TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        position_source TEXT,
        latitude REAL,
        longitude REAL,
        message TEXT NOT NULL,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        derived_from TEXT NOT NULL,
        record_origin TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_open
        ON alerts (soldier_id, alert_type, status);
      CREATE INDEX IF NOT EXISTS idx_alerts_list
        ON alerts (event_time, id);
    `);

    const alertCount = (
      conn.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }
    ).n;
    const explorerCount = (
      conn.prepare('SELECT COUNT(*) AS n FROM explorer_records').get() as {
        n: number;
      }
    ).n;
    if (
      alertCount === 0 &&
      explorerCount &&
      process.env.TRACKFORGE_SEED !== '0'
    ) {
      seedAlerts(conn);
    }

    conn.exec(`
      CREATE TABLE IF NOT EXISTS geofences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'silent',
        status TEXT NOT NULL DEFAULT 'active',
        groups_json TEXT NOT NULL DEFAULT '[]',
        polygon_json TEXT NOT NULL,
        area_km2 REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_type TEXT NOT NULL CHECK (identity_type IN ('HUMAN', 'SERVICE')),
        name TEXT NOT NULL,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        department TEXT,
        title TEXT,
        sponsor TEXT,
        verification TEXT NOT NULL DEFAULT 'VERIFIED'
          CHECK (verification IN ('PENDING', 'VERIFIED')),
        status TEXT NOT NULL DEFAULT 'INACTIVE'
          CHECK (status IN ('INACTIVE', 'ACTIVE', 'SUSPENDED', 'DISABLED')),
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const userColumns = new Set(
      (conn.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    if (!userColumns.has('profile_image')) {
      conn.exec('ALTER TABLE users ADD COLUMN profile_image BLOB');
    }
    if (!userColumns.has('profile_image_mime')) {
      conn.exec('ALTER TABLE users ADD COLUMN profile_image_mime TEXT');
    }

    conn.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        duty_category TEXT NOT NULL,
        description TEXT NOT NULL,
        privilege_narrative TEXT,
        least_privilege_baseline TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        is_protected INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN ('READ', 'ALL_ACTIONS')),
        description TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER NOT NULL,
        permission_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (role_id, permission_id),
        FOREIGN KEY (role_id) REFERENCES roles(id),
        FOREIGN KEY (permission_id) REFERENCES permissions(id)
      );
      CREATE TABLE IF NOT EXISTS user_role_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
        valid_from TEXT,
        valid_until TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (role_id) REFERENCES roles(id)
      );
      CREATE INDEX IF NOT EXISTS idx_bindings_role
        ON user_role_bindings (role_id, status);
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        actor_id INTEGER,
        actor_name TEXT,
        actor_role TEXT,
        actor_type TEXT NOT NULL DEFAULT 'USER',
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        event_type TEXT NOT NULL,
        target_id TEXT,
        target_name TEXT,
        target_type TEXT,
        outcome TEXT NOT NULL,
        description TEXT,
        ip_address TEXT,
        user_agent TEXT,
        session_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_list ON audit_logs (timestamp, id);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, timestamp);
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_code TEXT NOT NULL UNIQUE,
        source_alert_id INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL
          CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED')),
        priority TEXT NOT NULL
          CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
        created_by INTEGER NOT NULL,
        assignee_id INTEGER,
        response_plan TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        resolved_at TEXT,
        closed_at TEXT,
        FOREIGN KEY (source_alert_id) REFERENCES alerts(id),
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (assignee_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_list ON tickets (created_at, id);
      CREATE TABLE IF NOT EXISTS ticket_collaborators (
        ticket_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        added_by INTEGER NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, user_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (added_by) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS ticket_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        assignee_id INTEGER,
        priority TEXT NOT NULL
          CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
        status TEXT NOT NULL DEFAULT 'TODO'
          CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id),
        FOREIGN KEY (assignee_id) REFERENCES users(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS ticket_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id),
        FOREIGN KEY (author_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
      );
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        deleted_at TEXT,
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS operation_groups (
        operation_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        PRIMARY KEY (operation_id, group_id),
        FOREIGN KEY (operation_id) REFERENCES operations(id),
        FOREIGN KEY (group_id) REFERENCES groups(id)
      );
      CREATE TABLE IF NOT EXISTS operation_geofences (
        operation_id INTEGER NOT NULL,
        geofence_id INTEGER NOT NULL,
        PRIMARY KEY (operation_id, geofence_id),
        FOREIGN KEY (operation_id) REFERENCES operations(id),
        FOREIGN KEY (geofence_id) REFERENCES geofences(id)
      );
    `);

    seedAccess(conn);
  }

  insertRecord(record: Record<string, unknown>): number {
    const placeholders = COLUMNS.map(() => '?').join(', ');
    const columns = COLUMNS.join(', ');
    const stmt = this.db.prepare(
      `INSERT INTO explorer_records (${columns}) VALUES (${placeholders})`,
    );
    const result = stmt.run(...bind(COLUMNS.map((c) => record[c])));
    return Number(result.lastInsertRowid);
  }

  getRecord(recordId: number): Record<string, unknown> | undefined {
    return this.db
      .prepare('SELECT * FROM explorer_records WHERE id = ?')
      .get(recordId) as Record<string, unknown> | undefined;
  }

  recordToApi(row: Record<string, unknown>): Record<string, unknown> {
    const item: Record<string, unknown> = {};
    for (const field of PUBLIC_FIELDS) {
      item[field] = row[field];
    }
    item.data = JSON.parse(String(row.data_json));
    return item;
  }
}
