import json
import sqlite3


class OperationRepository:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def sync_groups(self) -> None:
        rows = self.conn.execute(
            """
            SELECT DISTINCT group_id AS name
            FROM explorer_records
            WHERE group_id IS NOT NULL AND group_id != ''
            """
        ).fetchall()
        for row in rows:
            self.conn.execute(
                "INSERT OR IGNORE INTO groups (name, status) VALUES (?, 'ACTIVE')",
                (row["name"],),
            )

    def groups(self) -> list[sqlite3.Row]:
        self.sync_groups()
        return self.conn.execute("SELECT id, name, status FROM groups ORDER BY name COLLATE NOCASE").fetchall()

    def get_group(self, group_id: int) -> sqlite3.Row | None:
        self.sync_groups()
        return self.conn.execute("SELECT id, name, status FROM groups WHERE id = ?", (group_id,)).fetchone()

    def get_geofence(self, geofence_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM geofences WHERE id = ?", (geofence_id,)).fetchone()

    def next_code(self, now: str) -> str:
        prefix = f"OP-{now[:4]}-"
        row = self.conn.execute(
            """
            SELECT operation_code FROM operations
            WHERE operation_code LIKE ?
            ORDER BY operation_code DESC
            LIMIT 1
            """,
            (f"{prefix}%",),
        ).fetchone()
        sequence = 1 if row is None else int(row["operation_code"].rsplit("-", 1)[-1]) + 1
        return f"{prefix}{sequence:03d}"

    def insert_operation(self, **values) -> int:
        columns = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cursor = self.conn.execute(
            f"INSERT INTO operations ({columns}) VALUES ({marks})",
            tuple(values.values()),
        )
        return int(cursor.lastrowid)

    def get_operation(self, operation_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM operations WHERE id = ? AND deleted_at IS NULL",
            (operation_id,),
        ).fetchone()

    def update_operation(self, operation_id: int, fields: dict) -> None:
        assignments = ", ".join(f"{column} = ?" for column in fields)
        self.conn.execute(
            f"UPDATE operations SET {assignments} WHERE id = ?",
            [*fields.values(), operation_id],
        )

    def count_operations(self, where: str, params: list) -> int:
        return self.conn.execute(
            f"SELECT COUNT(*) AS n FROM operations o WHERE {where}",
            params,
        ).fetchone()["n"]

    def list_operations(self, where: str, params: list, limit: int, offset: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            f"""
            SELECT * FROM operations o
            WHERE {where}
            ORDER BY o.created_at DESC, o.id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()

    def status_counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT status, COUNT(*) AS n
            FROM operations
            WHERE deleted_at IS NULL
            GROUP BY status
            """
        ).fetchall()
        return {row["status"]: row["n"] for row in rows}

    def linked_groups(self, operation_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT g.id, g.name, g.status
            FROM operation_groups og
            JOIN groups g ON g.id = og.group_id
            WHERE og.operation_id = ?
            ORDER BY g.name COLLATE NOCASE
            """,
            (operation_id,),
        ).fetchall()

    def linked_geofences(self, operation_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT f.id, f.name, f.polygon_json, f.status
            FROM operation_geofences og
            JOIN geofences f ON f.id = og.geofence_id
            WHERE og.operation_id = ?
            ORDER BY f.name COLLATE NOCASE
            """,
            (operation_id,),
        ).fetchall()

    def replace_groups(self, operation_id: int, group_ids: list[int]) -> None:
        self.conn.execute("DELETE FROM operation_groups WHERE operation_id = ?", (operation_id,))
        for group_id in group_ids:
            self.conn.execute(
                "INSERT INTO operation_groups (operation_id, group_id) VALUES (?, ?)",
                (operation_id, group_id),
            )

    def replace_geofences(self, operation_id: int, geofence_ids: list[int]) -> None:
        self.conn.execute("DELETE FROM operation_geofences WHERE operation_id = ?", (operation_id,))
        for geofence_id in geofence_ids:
            self.conn.execute(
                "INSERT INTO operation_geofences (operation_id, geofence_id) VALUES (?, ?)",
                (operation_id, geofence_id),
            )

    def link_group(self, operation_id: int, group_id: int) -> None:
        self.conn.execute(
            "INSERT INTO operation_groups (operation_id, group_id) VALUES (?, ?)",
            (operation_id, group_id),
        )

    def unlink_group(self, operation_id: int, group_id: int) -> int:
        cursor = self.conn.execute(
            "DELETE FROM operation_groups WHERE operation_id = ? AND group_id = ?",
            (operation_id, group_id),
        )
        return cursor.rowcount

    def has_group(self, operation_id: int, group_id: int) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM operation_groups WHERE operation_id = ? AND group_id = ?",
            (operation_id, group_id),
        ).fetchone()
        return row is not None

    def link_geofence(self, operation_id: int, geofence_id: int) -> None:
        self.conn.execute(
            "INSERT INTO operation_geofences (operation_id, geofence_id) VALUES (?, ?)",
            (operation_id, geofence_id),
        )

    def unlink_geofence(self, operation_id: int, geofence_id: int) -> int:
        cursor = self.conn.execute(
            "DELETE FROM operation_geofences WHERE operation_id = ? AND geofence_id = ?",
            (operation_id, geofence_id),
        )
        return cursor.rowcount

    def has_geofence(self, operation_id: int, geofence_id: int) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM operation_geofences WHERE operation_id = ? AND geofence_id = ?",
            (operation_id, geofence_id),
        ).fetchone()
        return row is not None

    def personnel(self, group_names: list[str]) -> list[sqlite3.Row]:
        if not group_names:
            return []
        marks = ", ".join("?" for _ in group_names)
        return self.conn.execute(
            f"""
            SELECT DISTINCT soldier_id, group_id
            FROM explorer_records
            WHERE is_sos = 0
              AND soldier_id IS NOT NULL
              AND group_id IN ({marks})
            ORDER BY group_id COLLATE NOCASE, soldier_id
            """,
            group_names,
        ).fetchall()

    def latest_position(self, soldier_id: int, group_name: str) -> sqlite3.Row | None:
        return self.conn.execute(
            """
            SELECT event_time, data_json
            FROM explorer_records
            WHERE is_sos = 0
              AND category = 'TELEMETRY'
              AND soldier_id = ?
              AND group_id = ?
            ORDER BY event_time DESC, id DESC
            LIMIT 1
            """,
            (soldier_id, group_name),
        ).fetchone()

    def alerts_for(self, group_names: list[str], soldier_ids: list[int]) -> list[sqlite3.Row]:
        clauses = []
        params: list = []
        if group_names:
            marks = ", ".join("?" for _ in group_names)
            clauses.append(f"group_id IN ({marks})")
            params.extend(group_names)
        if soldier_ids:
            marks = ", ".join("?" for _ in soldier_ids)
            clauses.append(f"soldier_id IN ({marks})")
            params.extend(soldier_ids)
        if not clauses:
            return []
        return self.conn.execute(
            f"""
            SELECT * FROM alerts
            WHERE {" OR ".join(clauses)}
            ORDER BY event_time DESC, id DESC
            """,
            params,
        ).fetchall()

    def tickets_for_alerts(self, alert_ids: list[int]) -> list[sqlite3.Row]:
        if not alert_ids:
            return []
        marks = ", ".join("?" for _ in alert_ids)
        return self.conn.execute(
            f"""
            SELECT t.id, t.ticket_code, t.status, t.priority, t.source_alert_id, a.alert_type
            FROM tickets t
            JOIN alerts a ON a.id = t.source_alert_id
            WHERE t.source_alert_id IN ({marks})
            ORDER BY t.created_at DESC, t.id DESC
            """,
            alert_ids,
        ).fetchall()


def position_of(row: sqlite3.Row | None) -> tuple[float | None, float | None, str | None]:
    if row is None:
        return None, None, None
    payload = json.loads(row["data_json"])
    return payload.get("lat"), payload.get("lon"), row["event_time"]
