import csv
import io
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from .database import get_connection

router = APIRouter(prefix="/api/alerts", tags=["Alerts"])

_PUBLIC = (
    "id",
    "alert_type",
    "severity",
    "status",
    "soldier_id",
    "group_id",
    "gateway_id",
    "event_time",
    "received_at",
    "position_source",
    "lat",
    "lon",
    "details",
    "source_record_id",
    "record_origin",
    "created_at",
)


def alert_to_api(row) -> dict:
    item = {field: row[field] for field in _PUBLIC}
    item["data"] = json.loads(row["data_json"])
    return item


def _filters(
    q: str | None,
    alert_type: list[str] | None,
    severity: list[str] | None,
    status: str | None,
    soldier_id: int | None,
    group_id: str | None,
    gateway_id: str | None,
    from_time: str | None,
    to_time: str | None,
) -> tuple[str, list]:
    conditions = ["1 = 1"]
    params: list = []
    for column, values in (("alert_type", alert_type), ("severity", severity)):
        if values:
            marks = ", ".join("?" for _ in values)
            conditions.append(f"{column} IN ({marks})")
            params.extend(values)
    for column, value in (
        ("status", status),
        ("group_id", group_id),
        ("gateway_id", gateway_id),
    ):
        if value:
            conditions.append(f"{column} = ?")
            params.append(value)
    if soldier_id is not None:
        conditions.append("soldier_id = ?")
        params.append(soldier_id)
    if from_time:
        conditions.append("event_time >= ?")
        params.append(from_time)
    if to_time:
        conditions.append("event_time <= ?")
        params.append(to_time)
    if q and q.strip():
        needle = f"%{q.strip()}%"
        conditions.append(
            """(
                CAST(id AS TEXT) LIKE ? OR
                alert_type LIKE ? COLLATE NOCASE OR
                severity LIKE ? COLLATE NOCASE OR
                details LIKE ? COLLATE NOCASE OR
                IFNULL(group_id, '') LIKE ? COLLATE NOCASE OR
                IFNULL(CAST(soldier_id AS TEXT), '') LIKE ? OR
                IFNULL(record_origin, '') LIKE ? COLLATE NOCASE
            )"""
        )
        params.extend([needle] * 7)
    return " AND ".join(conditions), params


def _alert_query(
    q: Annotated[str | None, Query()] = None,
    alert_type: Annotated[list[str] | None, Query()] = None,
    severity: Annotated[list[str] | None, Query()] = None,
    status: Annotated[str | None, Query()] = None,
    soldier_id: Annotated[int | None, Query()] = None,
    group_id: Annotated[str | None, Query()] = None,
    gateway_id: Annotated[str | None, Query()] = None,
    from_time: Annotated[str | None, Query()] = None,
    to_time: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    where, params = _filters(
        q, alert_type, severity, status, soldier_id, group_id, gateway_id, from_time, to_time
    )
    return {"where": where, "params": params, "limit": limit, "offset": offset}


AlertFilters = Annotated[dict, Depends(_alert_query)]


@router.get("")
def list_alerts(filters: AlertFilters):
    where = filters["where"]
    params = filters["params"]
    with get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM alerts WHERE {where}", params).fetchone()["n"]
        rows = conn.execute(
            f"""
            SELECT * FROM alerts
            WHERE {where}
            ORDER BY event_time DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, filters["limit"], filters["offset"]],
        ).fetchall()
    items = [alert_to_api(row) for row in rows]
    return {
        "items": items,
        "limit": filters["limit"],
        "offset": filters["offset"],
        "count": len(items),
        "total": total,
    }


@router.get("/summary")
def alert_summary(filters: AlertFilters):
    where = filters["where"]
    params = filters["params"]
    with get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM alerts WHERE {where}", params).fetchone()["n"]
        timeline = conn.execute(
            f"""
            SELECT substr(event_time, 1, 13) || ':00:00Z' AS time, COUNT(*) AS count
            FROM alerts
            WHERE {where}
            GROUP BY time
            ORDER BY time
            """,
            params,
        ).fetchall()
        by_severity = conn.execute(
            f"""
            SELECT severity, COUNT(*) AS count
            FROM alerts
            WHERE {where}
            GROUP BY severity
            ORDER BY count DESC, severity
            """,
            params,
        ).fetchall()
        by_type = conn.execute(
            f"""
            SELECT alert_type, COUNT(*) AS count
            FROM alerts
            WHERE {where}
            GROUP BY alert_type
            ORDER BY count DESC, alert_type
            """,
            params,
        ).fetchall()
    return {
        "total": total,
        "timeline": [{"time": row["time"], "count": row["count"]} for row in timeline],
        "by_severity": [{"severity": row["severity"], "count": row["count"]} for row in by_severity],
        "by_type": [{"alert_type": row["alert_type"], "count": row["count"]} for row in by_type],
    }


@router.get("/export.csv")
def export_alerts(filters: AlertFilters):
    where = filters["where"]
    params = filters["params"]
    columns = (*_PUBLIC, "data")
    with get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM alerts
            WHERE {where}
            ORDER BY event_time DESC, id DESC
            """,
            params,
        ).fetchall()
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    for row in rows:
        item = alert_to_api(row)
        writer.writerow(
            {
                column: json.dumps(item["data"], separators=(",", ":")) if column == "data" else item[column]
                for column in columns
            }
        )
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="alerts.csv"'},
    )


@router.get("/{alert_id}")
def get_alert(alert_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return alert_to_api(row)
