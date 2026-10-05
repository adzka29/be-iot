import csv
import io
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from .alert_rules import sync_no_contact
from .database import get_connection, get_record, record_to_api
from .records import TIME_RANGES, canonical_time, time_range_start, utc_now
from .schemas import (
    AlertActorIn,
    AlertFilterOptions,
    AlertOut,
    AlertPage,
    AlertSummary,
)

router = APIRouter(prefix="/api/alerts", tags=["Alerts"])

_PUBLIC = (
    "id",
    "alert_code",
    "alert_type",
    "severity",
    "status",
    "entity_type",
    "entity_id",
    "soldier_id",
    "group_id",
    "gateway_id",
    "source_record_id",
    "event_time",
    "first_seen_at",
    "last_seen_at",
    "position_source",
    "latitude",
    "longitude",
    "message",
    "acknowledged_at",
    "acknowledged_by",
    "resolved_at",
    "resolved_by",
    "derived_from",
    "record_origin",
    "created_at",
    "updated_at",
)

_OPTION_COLUMNS = (
    ("alert_types", "alert_type"),
    ("severities", "severity"),
    ("statuses", "status"),
    ("groups", "group_id"),
    ("gateways", "gateway_id"),
    ("derived_from", "derived_from"),
    ("record_origins", "record_origin"),
)


def alert_to_api(conn, row) -> dict:
    item = {field: row[field] for field in _PUBLIC}
    item["details"] = json.loads(row["details_json"])
    source = None
    if row["source_record_id"] is not None:
        record = get_record(conn, row["source_record_id"])
        if record is not None:
            source = record_to_api(record)
    item["source_record"] = source
    return item


def _range_start(value: str | None) -> str | None:
    try:
        return time_range_start(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _time_bound(value: str) -> str:
    try:
        return canonical_time(value)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    time_range: str | None,
) -> tuple[str, list]:
    conditions = ["1 = 1"]
    params: list = []
    for column, values in (("alert_type", alert_type), ("severity", severity)):
        kept = [value for value in values or () if value]
        if kept:
            marks = ", ".join("?" for _ in kept)
            conditions.append(f"{column} IN ({marks})")
            params.extend(kept)
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
    range_start = _range_start(time_range)
    if range_start:
        conditions.append("event_time >= ?")
        params.append(range_start)
    if from_time:
        conditions.append("event_time >= ?")
        params.append(_time_bound(from_time))
    if to_time:
        conditions.append("event_time <= ?")
        params.append(_time_bound(to_time))
    if q and q.strip():
        needle = f"%{q.strip()}%"
        conditions.append(
            """(
                CAST(id AS TEXT) LIKE ? OR
                alert_code LIKE ? COLLATE NOCASE OR
                alert_type LIKE ? COLLATE NOCASE OR
                severity LIKE ? COLLATE NOCASE OR
                message LIKE ? COLLATE NOCASE OR
                details_json LIKE ? COLLATE NOCASE OR
                IFNULL(group_id, '') LIKE ? COLLATE NOCASE OR
                IFNULL(CAST(soldier_id AS TEXT), '') LIKE ? OR
                IFNULL(record_origin, '') LIKE ? COLLATE NOCASE
            )"""
        )
        params.extend([needle] * 9)
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
    timeRange: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    where, params = _filters(
        q, alert_type, severity, status, soldier_id, group_id, gateway_id, from_time, to_time, timeRange
    )
    return {"where": where, "params": params, "limit": limit, "offset": offset}


AlertFilters = Annotated[dict, Depends(_alert_query)]


def _page(conn, where: str, params: list, limit: int, offset: int) -> dict:
    total = conn.execute(f"SELECT COUNT(*) AS n FROM alerts WHERE {where}", params).fetchone()["n"]
    rows = conn.execute(
        f"""
        SELECT * FROM alerts
        WHERE {where}
        ORDER BY event_time DESC, id DESC
        LIMIT ? OFFSET ?
        """,
        [*params, limit, offset],
    ).fetchall()
    return {
        "items": [alert_to_api(conn, row) for row in rows],
        "limit": limit,
        "offset": offset,
        "count": len(rows),
        "total": total,
    }


@router.get("", response_model=AlertPage)
def list_alerts(filters: AlertFilters):
    with get_connection() as conn:
        sync_no_contact(conn)
        return _page(conn, filters["where"], filters["params"], filters["limit"], filters["offset"])


@router.get("/summary", response_model=AlertSummary)
def alert_summary(filters: AlertFilters):
    where = filters["where"]
    params = filters["params"]
    with get_connection() as conn:
        sync_no_contact(conn)
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


@router.get("/filters/options", response_model=AlertFilterOptions)
def alert_filter_options():
    options: dict[str, list[str]] = {}
    with get_connection() as conn:
        sync_no_contact(conn)
        for key, column in _OPTION_COLUMNS:
            rows = conn.execute(
                f"""
                SELECT DISTINCT {column} AS value
                FROM alerts
                WHERE {column} IS NOT NULL AND {column} != ''
                ORDER BY value
                """
            ).fetchall()
            options[key] = [row["value"] for row in rows]
    options["time_ranges"] = list(TIME_RANGES)
    return options


@router.get("/export.csv")
def export_alerts(filters: AlertFilters):
    where = filters["where"]
    params = filters["params"]
    columns = (*_PUBLIC, "details")
    with get_connection() as conn:
        sync_no_contact(conn)
        rows = conn.execute(
            f"""
            SELECT * FROM alerts
            WHERE {where}
            ORDER BY event_time DESC, id DESC
            """,
            params,
        ).fetchall()
        items = [alert_to_api(conn, row) for row in rows]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    for item in items:
        writer.writerow(
            {
                column: json.dumps(item["details"], separators=(",", ":"))
                if column == "details"
                else item[column]
                for column in columns
            }
        )
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="alerts.csv"'},
    )


@router.get("/sos", response_model=AlertPage)
def list_sos(
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    where = "alert_type = 'SOS' AND status IN ('ACTIVE', 'ACKNOWLEDGED')"
    with get_connection() as conn:
        sync_no_contact(conn)
        return _page(conn, where, [], limit, offset)


@router.get("/{alert_id}", response_model=AlertOut)
def get_alert(alert_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="alert not found")
        return alert_to_api(conn, row)


def _load_alert(conn, alert_id: int):
    row = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return row


@router.post("/{alert_id}/acknowledge", response_model=AlertOut)
def acknowledge_alert(alert_id: int, body: AlertActorIn | None = None):
    actor = (body.by if body and body.by else "operator")
    now = utc_now()
    with get_connection() as conn:
        row = _load_alert(conn, alert_id)
        if row["status"] in ("RESOLVED", "CLEARED"):
            raise HTTPException(status_code=409, detail="alert is already closed")
        if row["status"] == "ACTIVE":
            conn.execute(
                """
                UPDATE alerts
                SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
                WHERE id = ?
                """,
                (now, actor, now, alert_id),
            )
        updated = _load_alert(conn, alert_id)
        return alert_to_api(conn, updated)


@router.post("/{alert_id}/resolve", response_model=AlertOut)
def resolve_alert(alert_id: int, body: AlertActorIn | None = None):
    actor = body.by if body and body.by else "operator"
    now = utc_now()
    with get_connection() as conn:
        row = _load_alert(conn, alert_id)
        if row["status"] in ("RESOLVED", "CLEARED"):
            raise HTTPException(status_code=409, detail="alert is already closed")
        conn.execute(
            """
            UPDATE alerts
            SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, updated_at = ?
            WHERE id = ?
            """,
            (now, actor, now, alert_id),
        )
        updated = _load_alert(conn, alert_id)
        return alert_to_api(conn, updated)
