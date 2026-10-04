import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CATEGORIES = ("TELEMETRY", "MESH", "UPLINK", "BEACON", "SPECIAL", "SYSTEM")

_COLUMNS = (
    "category",
    "data_type",
    "entity_type",
    "entity_id",
    "soldier_id",
    "group_id",
    "gateway_id",
    "beacon_id",
    "event_time",
    "received_at",
    "position_source",
    "transport",
    "freshness",
    "severity",
    "record_origin",
    "raw_format",
    "raw_hex",
    "raw_bytes_length",
    "data_json",
    "is_sos",
    "created_at",
)

_PUBLIC_FIELDS = (
    "id",
    "category",
    "data_type",
    "entity_type",
    "entity_id",
    "soldier_id",
    "group_id",
    "gateway_id",
    "event_time",
    "received_at",
    "position_source",
    "transport",
    "freshness",
    "severity",
    "record_origin",
    "raw_format",
    "raw_hex",
    "raw_bytes_length",
    "created_at",
)


def db_path() -> Path:
    override = os.environ.get("TRACKFORGE_DB")
    return Path(override) if override else ROOT / "data" / "trackforge.db"


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    category_check = ", ".join(f"'{category}'" for category in CATEGORIES)
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'explorer_records'"
        ).fetchone()
        if existing is not None:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(explorer_records)")}
            if "entity_type" not in columns or "record_origin" not in columns:
                conn.execute("DROP TABLE explorer_records")
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS explorer_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL CHECK (category IN ({category_check})),
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
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_explorer_list
            ON explorer_records (is_sos, event_time, id)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_explorer_category
            ON explorer_records (is_sos, category, data_type)
            """
        )
        count = conn.execute("SELECT COUNT(*) AS n FROM explorer_records").fetchone()["n"]
        if count == 0 and os.environ.get("TRACKFORGE_SEED", "1") != "0":
            from .seed import seed

            seed(conn)
        existing_alerts = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alerts'"
        ).fetchone()
        if existing_alerts is not None:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(alerts)")}
            if "alert_code" not in columns or "first_seen_at" not in columns:
                conn.execute("DROP TABLE alerts")
        conn.execute("DROP INDEX IF EXISTS idx_alerts_dedupe")
        conn.execute(
            """
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
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_alerts_open
            ON alerts (soldier_id, alert_type, status)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_alerts_list
            ON alerts (event_time, id)
            """
        )
        alert_count = conn.execute("SELECT COUNT(*) AS n FROM alerts").fetchone()["n"]
        explorer_count = conn.execute("SELECT COUNT(*) AS n FROM explorer_records").fetchone()["n"]
        if alert_count == 0 and explorer_count and os.environ.get("TRACKFORGE_SEED", "1") != "0":
            from .alert_rules import seed_alerts

            seed_alerts(conn)
        conn.execute(
            """
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
            )
            """
        )


def insert_record(conn: sqlite3.Connection, record: dict) -> int:
    placeholders = ", ".join("?" for _ in _COLUMNS)
    columns = ", ".join(_COLUMNS)
    cursor = conn.execute(
        f"INSERT INTO explorer_records ({columns}) VALUES ({placeholders})",
        tuple(record[column] for column in _COLUMNS),
    )
    return int(cursor.lastrowid)


def get_record(conn: sqlite3.Connection, record_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM explorer_records WHERE id = ?",
        (record_id,),
    ).fetchone()


def record_to_api(row: sqlite3.Row) -> dict:
    item = {field: row[field] for field in _PUBLIC_FIELDS}
    item["data"] = json.loads(row["data_json"])
    return item
