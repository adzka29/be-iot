import sqlite3

_TICKET_COLUMNS = """
    t.id, t.ticket_code, t.source_alert_id, t.status, t.priority, t.created_by, t.assignee_id,
    t.response_plan, t.created_at, t.updated_at, t.started_at, t.resolved_at, t.closed_at,
    a.alert_code, a.alert_type, a.severity AS alert_severity, a.status AS alert_status,
    a.soldier_id, a.group_id, a.event_time, a.position_source, a.latitude, a.longitude, a.message
"""

_FROM = """
    FROM tickets t
    JOIN alerts a ON a.id = t.source_alert_id
"""


class TicketRepository:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def get_alert(self, alert_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()

    def ticket_for_alert(self, alert_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT id FROM tickets WHERE source_alert_id = ?",
            (alert_id,),
        ).fetchone()

    def next_code(self, now: str) -> str:
        prefix = f"TK-{now[:10].replace('-', '')}-"
        row = self.conn.execute(
            """
            SELECT ticket_code FROM tickets
            WHERE ticket_code LIKE ?
            ORDER BY ticket_code DESC
            LIMIT 1
            """,
            (f"{prefix}%",),
        ).fetchone()
        sequence = 1 if row is None else int(row["ticket_code"].rsplit("-", 1)[-1]) + 1
        return f"{prefix}{sequence:03d}"

    def insert_ticket(self, **values) -> int:
        columns = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cursor = self.conn.execute(
            f"INSERT INTO tickets ({columns}) VALUES ({marks})",
            tuple(values.values()),
        )
        return int(cursor.lastrowid)

    def acknowledge_alert(self, alert_id: int, actor_name: str, now: str) -> None:
        self.conn.execute(
            """
            UPDATE alerts
            SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
            WHERE id = ? AND status = 'ACTIVE'
            """,
            (now, actor_name, now, alert_id),
        )

    def resolve_alert(self, alert_id: int, actor_name: str, now: str) -> None:
        self.conn.execute(
            """
            UPDATE alerts
            SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, updated_at = ?
            WHERE id = ?
            """,
            (now, actor_name, now, alert_id),
        )

    def get_ticket(self, ticket_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            f"SELECT {_TICKET_COLUMNS} {_FROM} WHERE t.id = ?",
            (ticket_id,),
        ).fetchone()

    def count_tickets(self, where: str, params: list) -> int:
        return self.conn.execute(
            f"SELECT COUNT(*) AS n {_FROM} WHERE {where}",
            params,
        ).fetchone()["n"]

    def list_tickets(self, where: str, params: list, limit: int, offset: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            f"""
            SELECT {_TICKET_COLUMNS}
            {_FROM}
            WHERE {where}
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()

    def grouped_counts(self, where: str, params: list, column: str) -> dict[str, int]:
        rows = self.conn.execute(
            f"SELECT t.{column} AS value, COUNT(*) AS n {_FROM} WHERE {where} GROUP BY t.{column}",
            params,
        ).fetchall()
        return {row["value"]: row["n"] for row in rows}

    def visible_alert_types(self, where: str, params: list) -> list[str]:
        rows = self.conn.execute(
            f"""
            SELECT DISTINCT a.alert_type AS value
            {_FROM}
            WHERE {where} AND a.alert_type IS NOT NULL
            ORDER BY a.alert_type ASC
            """,
            params,
        ).fetchall()
        return [row["value"] for row in rows]

    def visible_groups(self, where: str, params: list) -> list[str]:
        rows = self.conn.execute(
            f"""
            SELECT DISTINCT a.group_id AS value
            {_FROM}
            WHERE {where} AND a.group_id IS NOT NULL AND a.group_id != ''
            ORDER BY a.group_id COLLATE NOCASE ASC
            """,
            params,
        ).fetchall()
        return [row["value"] for row in rows]

    def update_ticket(self, ticket_id: int, fields: dict) -> None:
        assignments = ", ".join(f"{column} = ?" for column in fields)
        self.conn.execute(
            f"UPDATE tickets SET {assignments} WHERE id = ?",
            [*fields.values(), ticket_id],
        )

    def collaborators(self, ticket_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT ticket_id, user_id, added_by, added_at
            FROM ticket_collaborators
            WHERE ticket_id = ?
            ORDER BY added_at ASC, user_id ASC
            """,
            (ticket_id,),
        ).fetchall()

    def get_collaborator(self, ticket_id: int, user_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            """
            SELECT ticket_id, user_id, added_by, added_at
            FROM ticket_collaborators
            WHERE ticket_id = ? AND user_id = ?
            """,
            (ticket_id, user_id),
        ).fetchone()

    def add_collaborator(self, ticket_id: int, user_id: int, added_by: int, added_at: str) -> None:
        self.conn.execute(
            """
            INSERT INTO ticket_collaborators (ticket_id, user_id, added_by, added_at)
            VALUES (?, ?, ?, ?)
            """,
            (ticket_id, user_id, added_by, added_at),
        )

    def remove_collaborator(self, ticket_id: int, user_id: int) -> None:
        self.conn.execute(
            "DELETE FROM ticket_collaborators WHERE ticket_id = ? AND user_id = ?",
            (ticket_id, user_id),
        )

    def tasks(self, ticket_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT *
            FROM ticket_tasks
            WHERE ticket_id = ?
            ORDER BY id ASC
            """,
            (ticket_id,),
        ).fetchall()

    def get_task(self, ticket_id: int, task_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM ticket_tasks WHERE ticket_id = ? AND id = ?",
            (ticket_id, task_id),
        ).fetchone()

    def insert_task(self, **values) -> int:
        columns = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cursor = self.conn.execute(
            f"INSERT INTO ticket_tasks ({columns}) VALUES ({marks})",
            tuple(values.values()),
        )
        return int(cursor.lastrowid)

    def update_task(self, task_id: int, fields: dict) -> None:
        assignments = ", ".join(f"{column} = ?" for column in fields)
        self.conn.execute(
            f"UPDATE ticket_tasks SET {assignments} WHERE id = ?",
            [*fields.values(), task_id],
        )

    def updates(self, ticket_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT id, ticket_id, author_id, message, created_at
            FROM ticket_updates
            WHERE ticket_id = ?
            ORDER BY created_at ASC, id ASC
            """,
            (ticket_id,),
        ).fetchall()

    def insert_update(self, ticket_id: int, author_id: int, message: str, created_at: str) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO ticket_updates (ticket_id, author_id, message, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (ticket_id, author_id, message, created_at),
        )
        return int(cursor.lastrowid)
