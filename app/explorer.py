import csv
import io
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from .database import get_connection, get_record, record_to_api
from .records import TIME_RANGES, canonical_time, time_range_start
from .schemas import ExplorerPage, ExplorerRecord, ExplorerSummary, FilterOptions

router = APIRouter(prefix="/api/explorer", tags=["Explorer"])

_CSV_COLUMNS = (
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
    "data",
)

_OPTION_COLUMNS = (
    ("categories", "category"),
    ("data_types", "data_type"),
    ("entity_types", "entity_type"),
    ("groups", "group_id"),
    ("gateways", "gateway_id"),
    ("position_sources", "position_source"),
    ("transports", "transport"),
    ("freshness", "freshness"),
    ("severity", "severity"),
    ("record_origins", "record_origin"),
    ("raw_formats", "raw_format"),
)


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
    category: list[str] | None,
    data_type: list[str] | None,
    entity_type: str | None,
    entity_id: str | None,
    soldier_id: int | None,
    group_id: str | None,
    gateway_id: str | None,
    position_source: str | None,
    transport: str | None,
    freshness: str | None,
    severity: str | None,
    record_origin: str | None,
    raw_format: str | None,
    from_time: str | None,
    to_time: str | None,
    time_range: str | None,
) -> tuple[str, list]:
    conditions = ["is_sos = 0"]
    params: list = []

    for column, values in (("category", category), ("data_type", data_type)):
        if values:
            marks = ", ".join("?" for _ in values)
            conditions.append(f"{column} IN ({marks})")
            params.extend(values)

    for column, value in (
        ("entity_type", entity_type),
        ("entity_id", entity_id),
        ("group_id", group_id),
        ("gateway_id", gateway_id),
        ("position_source", position_source),
        ("transport", transport),
        ("freshness", freshness),
        ("severity", severity),
        ("record_origin", record_origin),
        ("raw_format", raw_format),
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
                IFNULL(entity_id, '') LIKE ? COLLATE NOCASE OR
                IFNULL(entity_type, '') LIKE ? COLLATE NOCASE OR
                IFNULL(CAST(soldier_id AS TEXT), '') LIKE ? OR
                data_type LIKE ? COLLATE NOCASE OR
                category LIKE ? COLLATE NOCASE OR
                IFNULL(transport, '') LIKE ? COLLATE NOCASE OR
                IFNULL(position_source, '') LIKE ? COLLATE NOCASE OR
                IFNULL(raw_hex, '') LIKE ? COLLATE NOCASE OR
                data_json LIKE ? COLLATE NOCASE OR
                IFNULL(record_origin, '') LIKE ? COLLATE NOCASE
            )"""
        )
        params.extend([needle] * 11)

    return " AND ".join(conditions), params


def _explorer_query(
    q: Annotated[str | None, Query()] = None,
    category: Annotated[list[str] | None, Query()] = None,
    data_type: Annotated[list[str] | None, Query()] = None,
    entity_type: Annotated[str | None, Query()] = None,
    entity_id: Annotated[str | None, Query()] = None,
    soldier_id: Annotated[int | None, Query()] = None,
    group_id: Annotated[str | None, Query()] = None,
    gateway_id: Annotated[str | None, Query()] = None,
    position_source: Annotated[str | None, Query()] = None,
    transport: Annotated[str | None, Query()] = None,
    freshness: Annotated[str | None, Query()] = None,
    severity: Annotated[str | None, Query()] = None,
    record_origin: Annotated[str | None, Query()] = None,
    raw_format: Annotated[str | None, Query()] = None,
    from_time: Annotated[str | None, Query()] = None,
    to_time: Annotated[str | None, Query()] = None,
    timeRange: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    where, params = _filters(
        q,
        category,
        data_type,
        entity_type,
        entity_id,
        soldier_id,
        group_id,
        gateway_id,
        position_source,
        transport,
        freshness,
        severity,
        record_origin,
        raw_format,
        from_time,
        to_time,
        timeRange,
    )
    return {"where": where, "params": params, "limit": limit, "offset": offset}


QueryFilters = Annotated[dict, Depends(_explorer_query)]


def _rows(where: str, params: list, limit: int | None = None, offset: int = 0):
    sql = f"""
        SELECT *
        FROM explorer_records
        WHERE {where}
        ORDER BY event_time DESC, id DESC
    """
    bound = list(params)
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        bound.extend([limit, offset])
    with get_connection() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) AS n FROM explorer_records WHERE {where}",
            params,
        ).fetchone()["n"]
        rows = conn.execute(sql, bound).fetchall()
    return total, rows


@router.get("", response_model=ExplorerPage)
def get_explorer(filters: QueryFilters):
    total, rows = _rows(filters["where"], filters["params"], filters["limit"], filters["offset"])
    items = [record_to_api(row) for row in rows]
    return {
        "items": items,
        "limit": filters["limit"],
        "offset": filters["offset"],
        "count": len(items),
        "total": total,
    }


@router.get("/summary", response_model=ExplorerSummary)
def get_summary(filters: QueryFilters):
    where = filters["where"]
    params = filters["params"]
    with get_connection() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) AS n FROM explorer_records WHERE {where}",
            params,
        ).fetchone()["n"]
        timeline = conn.execute(
            f"""
            SELECT substr(event_time, 1, 13) || ':00:00Z' AS time, category, COUNT(*) AS count
            FROM explorer_records
            WHERE {where}
            GROUP BY time, category
            ORDER BY time, count DESC, category
            """,
            params,
        ).fetchall()
        by_category = conn.execute(
            f"""
            SELECT category, COUNT(*) AS count
            FROM explorer_records
            WHERE {where}
            GROUP BY category
            ORDER BY count DESC, category
            """,
            params,
        ).fetchall()
        by_data_type = conn.execute(
            f"""
            SELECT data_type, COUNT(*) AS count
            FROM explorer_records
            WHERE {where}
            GROUP BY data_type
            ORDER BY count DESC, data_type
            """,
            params,
        ).fetchall()
    buckets: dict[str, dict] = {}
    for row in timeline:
        bucket = buckets.setdefault(row["time"], {"time": row["time"], "count": 0, "segments": []})
        bucket["count"] += row["count"]
        bucket["segments"].append({"category": row["category"], "count": row["count"]})

    return {
        "total": total,
        "timeline": list(buckets.values()),
        "by_category": [{"category": row["category"], "count": row["count"]} for row in by_category],
        "by_data_type": [{"data_type": row["data_type"], "count": row["count"]} for row in by_data_type],
    }


@router.get("/filters/options", response_model=FilterOptions)
def get_filter_options():
    options: dict[str, list[str]] = {}
    with get_connection() as conn:
        for key, column in _OPTION_COLUMNS:
            rows = conn.execute(
                f"""
                SELECT DISTINCT {column} AS value
                FROM explorer_records
                WHERE is_sos = 0 AND {column} IS NOT NULL AND {column} != ''
                ORDER BY value
                """
            ).fetchall()
            options[key] = [row["value"] for row in rows]
    options["time_ranges"] = list(TIME_RANGES)
    return options


@router.get("/export.csv")
def export_csv(filters: QueryFilters):
    _, rows = _rows(filters["where"], filters["params"])
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=_CSV_COLUMNS)
    writer.writeheader()
    for row in rows:
        item = record_to_api(row)
        writer.writerow(
            {
                column: json.dumps(item["data"], separators=(",", ":")) if column == "data" else item[column]
                for column in _CSV_COLUMNS
            }
        )
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="explorer.csv"'},
    )


@router.get("/{record_id}", response_model=ExplorerRecord)
def get_explorer_record(record_id: int):
    with get_connection() as conn:
        row = get_record(conn, record_id)
    if row is None or row["is_sos"] != 0:
        raise HTTPException(status_code=404, detail="record not found")
    return record_to_api(row)
