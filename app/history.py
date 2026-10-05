import csv
import io
import json
import math
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from .database import get_connection, get_record
from .records import TIME_RANGES, canonical_time, parse_event_time, time_range_start
from .schemas import (
    HistoryCharts,
    HistoryFilterOptions,
    HistoryPage,
    HistoryPointDetail,
    HistoryStatistics,
    HistorySummary,
    HistoryTrack,
)

router = APIRouter(prefix="/api/history", tags=["History"])

_CATEGORY_BY_TYPE = {
    "TELEMETRY": "TELEMETRY",
    "MESH_FRAME": "MESH",
    "UPLINK": "UPLINK",
    "BEACON": "BEACON",
    "SPECIAL": "SPECIAL",
    "SYSTEM": "SYSTEM",
}
_TYPE_BY_CATEGORY = {category: name for name, category in _CATEGORY_BY_TYPE.items()}
_GAP_SECONDS = 15 * 60

_CSV_COLUMNS = (
    "id",
    "source_id",
    "event_time",
    "received_at",
    "data_type",
    "category",
    "soldier_id",
    "group_id",
    "gateway_id",
    "position_source",
    "latitude",
    "longitude",
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


def _categories(values: list[str] | None) -> list[str] | None:
    if not values:
        return None
    unknown = [value for value in values if value not in _CATEGORY_BY_TYPE]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown history_data_type: {', '.join(unknown)}")
    return [_CATEGORY_BY_TYPE[value] for value in values]


def _scope_clause(scope: str, soldier_id: int | None, group_id: str | None) -> tuple[str, list]:
    if scope == "SOLDIER":
        if soldier_id is None:
            raise HTTPException(status_code=400, detail="soldier_id is required when scope is SOLDIER")
        return "soldier_id = ?", [soldier_id]
    if scope == "GROUP":
        if not group_id:
            raise HTTPException(status_code=400, detail="group_id is required when scope is GROUP")
        return "group_id = ?", [group_id]
    raise HTTPException(status_code=400, detail="scope must be SOLDIER or GROUP")


def _where(
    scope: str,
    soldier_id: int | None,
    group_id: str | None,
    history_data_type: list[str] | None,
    position_source: list[str] | None,
    from_time: str | None,
    to_time: str | None,
    time_range: str | None = None,
) -> tuple[str, list]:
    clause, params = _scope_clause(scope, soldier_id, group_id)
    conditions = ["is_sos = 0", clause]
    categories = _categories(history_data_type)
    if categories:
        marks = ", ".join("?" for _ in categories)
        conditions.append(f"category IN ({marks})")
        params.extend(categories)
    sources = [value for value in position_source or () if value]
    if sources:
        marks = ", ".join("?" for _ in sources)
        conditions.append(f"position_source IN ({marks})")
        params.extend(sources)
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
    return " AND ".join(conditions), params


def _load(where: str, params: list):
    with get_connection() as conn:
        return conn.execute(
            f"""
            SELECT *
            FROM explorer_records
            WHERE {where}
            ORDER BY event_time ASC, id ASC
            """,
            params,
        ).fetchall()


def _payload(row, data: dict) -> dict:
    nested = data.get("payload")
    if row["category"] == "MESH" and isinstance(nested, dict):
        return nested
    return data


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _sample(row) -> dict:
    data = json.loads(row["data_json"])
    payload = _payload(row, data)
    return {
        "row": row,
        "data": data,
        "payload": payload,
        "seq": payload.get("seq"),
        "lat": _number(payload.get("lat")),
        "lon": _number(payload.get("lon")),
        "hr": _number(payload.get("hr")),
        "batt": _number(payload.get("batt")),
    }


def _deduped(rows) -> list[dict]:
    chosen: dict[tuple, dict] = {}
    for row in rows:
        if row["category"] not in ("TELEMETRY", "MESH"):
            continue
        sample = _sample(row)
        key = (row["soldier_id"], row["event_time"], sample["seq"])
        current = chosen.get(key)
        if current is None or (row["category"] == "TELEMETRY" and current["row"]["category"] != "TELEMETRY"):
            chosen[key] = sample
    return list(chosen.values())


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def _distance_km(samples: list[dict]) -> float:
    by_soldier: dict[int, list[dict]] = {}
    for sample in samples:
        soldier_id = sample["row"]["soldier_id"]
        if soldier_id is None or sample["lat"] is None or sample["lon"] is None:
            continue
        by_soldier.setdefault(soldier_id, []).append(sample)
    total = 0.0
    for points in by_soldier.values():
        points.sort(key=lambda item: (item["row"]["event_time"], item["row"]["id"]))
        for previous, current in zip(points, points[1:]):
            _, previous_unix = parse_event_time(previous["row"]["event_time"])
            _, current_unix = parse_event_time(current["row"]["event_time"])
            if current_unix - previous_unix > _GAP_SECONDS:
                continue
            total += _haversine_km(previous["lat"], previous["lon"], current["lat"], current["lon"])
    return round(total, 3)


def _average(values: list[float]) -> int | None:
    if not values:
        return None
    return int(round(sum(values) / len(values)))


def _history_type(category: str) -> str:
    return _TYPE_BY_CATEGORY.get(category, category)


def _item(row) -> dict:
    sample = _sample(row)
    return {
        "id": f"R-{row['id']}",
        "source_type": "RECORD",
        "source_id": row["id"],
        "event_time": row["event_time"],
        "received_at": row["received_at"],
        "data_type": _history_type(row["category"]),
        "category": row["category"],
        "entity_type": row["entity_type"],
        "entity_id": row["entity_id"],
        "soldier_id": row["soldier_id"],
        "group_id": row["group_id"],
        "gateway_id": row["gateway_id"],
        "position_source": row["position_source"],
        "latitude": sample["lat"],
        "longitude": sample["lon"],
    }


def _detail(row) -> dict:
    sample = _sample(row)
    payload = sample["payload"]
    data = sample["data"]
    flags = payload.get("flags") if isinstance(payload.get("flags"), dict) else {}
    position_source = row["position_source"] or flags.get("position_source")
    communication = {
        "transport": row["transport"],
        "gateway_id": row["gateway_id"],
        "hop_count": data.get("hop_count"),
        "rssi": data.get("rssi"),
        "snr": data.get("snr"),
        "ttl": data.get("ttl"),
        "delivery_mode": data.get("delivery_mode"),
        "delivery_status": data.get("delivery_status"),
    }
    item = _item(row)
    item["position_source"] = position_source
    item["transport"] = row["transport"]
    item["details"] = {
        "position": {
            "latitude": sample["lat"],
            "longitude": sample["lon"],
            "position_source": position_source,
        },
        "vitals": {
            "hr": payload.get("hr"),
            "hrv": payload.get("hrv"),
            "spo2": payload.get("spo2"),
            "temp": payload.get("temp"),
        },
        "device": {
            "batt": payload.get("batt"),
            "flags": flags,
        },
        "communication": {key: value for key, value in communication.items() if value is not None},
        "timing": {
            "event_time": row["event_time"],
            "received_at": row["received_at"],
        },
        "raw_data": {
            "raw_hex": row["raw_hex"],
            "raw_format": row["raw_format"],
            "raw_bytes_length": row["raw_bytes_length"],
        },
    }
    return item


def _query_rows(
    scope: str,
    soldier_id: int | None,
    group_id: str | None,
    history_data_type: list[str] | None,
    position_source: list[str] | None,
    from_time: str | None,
    to_time: str | None,
    time_range: str | None = None,
):
    where, params = _where(
        scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, time_range
    )
    return _load(where, params)


@router.get("", response_model=HistoryPage)
def list_history(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    history_data_type: Annotated[list[str] | None, Query()] = None,
    position_source: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    rows = _query_rows(scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, timeRange)
    rows = sorted(rows, key=lambda row: (row["event_time"], row["id"]), reverse=True)
    page = rows[offset : offset + limit]
    return {
        "items": [_item(row) for row in page],
        "limit": limit,
        "offset": offset,
        "count": len(page),
        "total": len(rows),
    }


@router.get("/filters/options", response_model=HistoryFilterOptions)
def history_filter_options(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
):
    rows = _query_rows(scope, soldier_id, group_id, None, None, from_time, to_time, timeRange)
    return {
        "data_types": sorted({_history_type(row["category"]) for row in rows}),
        "position_sources": sorted({row["position_source"] for row in rows if row["position_source"]}),
        "gateways": sorted({row["gateway_id"] for row in rows if row["gateway_id"]}),
        "soldiers": sorted({row["soldier_id"] for row in rows if row["soldier_id"] is not None}),
        "groups": sorted({row["group_id"] for row in rows if row["group_id"]}),
        "time_ranges": list(TIME_RANGES),
    }


@router.get("/summary", response_model=HistorySummary)
def history_summary(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    history_data_type: Annotated[list[str] | None, Query()] = None,
    position_source: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
):
    rows = _query_rows(scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, timeRange)
    samples = _deduped(rows)
    return {
        "cards": {
            "total_distance_km": _distance_km(samples),
            "distance_is_derived": True,
            "heart_rate_avg_bpm": _average([sample["hr"] for sample in samples if sample["hr"] is not None]),
            "battery_avg_percent": _average([sample["batt"] for sample in samples if sample["batt"] is not None]),
            "total_records": len(rows),
        }
    }


@router.get("/statistics", response_model=HistoryStatistics)
def history_statistics(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    history_data_type: Annotated[list[str] | None, Query()] = None,
    position_source: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
):
    rows = _query_rows(scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, timeRange)
    samples = [sample for sample in _deduped(rows) if sample["lat"] is not None and sample["lon"] is not None]
    type_counts: dict[str, int] = {}
    for row in rows:
        name = _history_type(row["category"])
        type_counts[name] = type_counts.get(name, 0) + 1
    source_counts: dict[str, int] = {}
    for sample in samples:
        source = sample["row"]["position_source"]
        if source:
            source_counts[source] = source_counts.get(source, 0) + 1
    return {
        "total_records": len(rows),
        "position_points": len(samples),
        "soldiers": len({row["soldier_id"] for row in rows if row["soldier_id"] is not None}),
        "by_data_type": [
            {"name": name, "count": count} for name, count in sorted(type_counts.items())
        ],
        "by_position_source": [
            {"name": name, "count": count} for name, count in sorted(source_counts.items())
        ],
    }


@router.get("/charts", response_model=HistoryCharts)
def history_charts(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    history_data_type: Annotated[list[str] | None, Query()] = None,
    position_source: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
):
    rows = _query_rows(scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, timeRange)
    buckets: dict[str, dict] = {}
    for sample in _deduped(rows):
        stamp = sample["row"]["event_time"]
        key = stamp[:13] + ":00:00Z"
        bucket = buckets.setdefault(key, {"time": key, "hr": [], "batt": []})
        if sample["hr"] is not None:
            bucket["hr"].append(sample["hr"])
        if sample["batt"] is not None:
            bucket["batt"].append(sample["batt"])
    return {
        "buckets": [
            {
                "time": bucket["time"],
                "heart_rate_avg_bpm": _average(bucket["hr"]),
                "battery_avg_percent": _average(bucket["batt"]),
                "samples": len(bucket["hr"]) or len(bucket["batt"]),
            }
            for _, bucket in sorted(buckets.items())
        ]
    }


@router.get("/track", response_model=HistoryTrack)
def history_track(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    history_data_type: Annotated[list[str] | None, Query()] = None,
    position_source: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
):
    rows = _query_rows(scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, timeRange)
    points = []
    for sample in _deduped(rows):
        if sample["lat"] is None or sample["lon"] is None:
            continue
        row = sample["row"]
        points.append(
            {
                "id": f"R-{row['id']}",
                "source_id": row["id"],
                "soldier_id": row["soldier_id"],
                "event_time": row["event_time"],
                "latitude": sample["lat"],
                "longitude": sample["lon"],
                "position_source": row["position_source"],
            }
        )
    points.sort(key=lambda point: (point["event_time"], point["source_id"]))
    return {"points": points}


@router.get("/export.csv")
def export_history(
    scope: str,
    soldier_id: int | None = None,
    group_id: str | None = None,
    history_data_type: Annotated[list[str] | None, Query()] = None,
    position_source: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    timeRange: str | None = None,
):
    rows = _query_rows(scope, soldier_id, group_id, history_data_type, position_source, from_time, to_time, timeRange)
    rows = sorted(rows, key=lambda row: (row["event_time"], row["id"]), reverse=True)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=_CSV_COLUMNS)
    writer.writeheader()
    for row in rows:
        item = _item(row)
        writer.writerow({column: "" if item.get(column) is None else item[column] for column in _CSV_COLUMNS})
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="history.csv"'},
    )


@router.get("/point/{record_id}", response_model=HistoryPointDetail)
def history_point(record_id: int):
    with get_connection() as conn:
        row = get_record(conn, record_id)
    if row is None or row["is_sos"] != 0:
        raise HTTPException(status_code=404, detail="record not found")
    return _detail(row)
