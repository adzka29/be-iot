import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the sqlite database file path, mirroring app/database.py's
 * db_path(). Honours the TRACKFORGE_DB override and otherwise stores the
 * database under <project root>/data/trackforge.db. Ensures the parent
 * directory exists (sqlite cannot create missing directories).
 */
export function resolveDbPath(): string {
  const override = process.env.TRACKFORGE_DB;
  const dbPath =
    override && override.trim().length > 0
      ? override
      : path.join(process.cwd(), 'data', 'trackforge.db');
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  return dbPath;
}
