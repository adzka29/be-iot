import json
from datetime import datetime, timedelta, timezone

from .frame import decode_flags, parse_hex


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


TIME_RANGES = ("all", "30d")
_TIME_RANGE_ALIASES = {
    "all": "all",
    "alltime": "all",
    "30d": "30d",
    "30day": "30d",
    "30days": "30d",
}


def time_range_start(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    key = "".join(char for char in value.strip().lower() if char.isalnum())
    preset = _TIME_RANGE_ALIASES.get(key)
    if preset is None:
        raise ValueError("unknown timeRange")
    if preset == "all":
        return None
    start = datetime.now(timezone.utc) - timedelta(days=30)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ")


def freshness_between(event_time: str, received_at: str) -> str:
    _, event_unix = parse_event_time(event_time)
    _, received_unix = parse_event_time(received_at)
    gap = received_unix - event_unix
    if gap <= 30:
        return "FRESH"
    if gap <= 15 * 60:
        return "AGING"
    return "STALE"


def canonical_time(value: int | str) -> str:
    iso, _ = parse_event_time(value)
    return iso


def parse_event_time(value: int | str) -> tuple[str, int]:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("timestamp must be ISO-8601 or unix seconds")
    if isinstance(value, int):
        unix = value
        iso = datetime.fromtimestamp(unix, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return iso, unix
    text = value.strip()
    if text.isdigit():
        unix = int(text)
        iso = datetime.fromtimestamp(unix, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return iso, unix
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("timestamp must be ISO-8601 or unix seconds") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc).replace(microsecond=0)
    unix = int(parsed.timestamp())
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ"), unix


def normalize_hex(raw_hex: str | None) -> tuple[str | None, int | None]:
    if raw_hex is None or raw_hex == "":
        return None, None
    try:
        raw = parse_hex(raw_hex)
    except ValueError:
        return raw_hex, None
    return raw.hex(), len(raw)


def telemetry_data(
    *,
    soldier_id: int,
    seq: int,
    timestamp: int,
    lat: float,
    lon: float,
    hr: int,
    hrv: int,
    spo2: int,
    temp: int,
    batt: int,
    flags: int,
) -> dict:
    decoded = decode_flags(flags)
    data = {
        "soldier_id": soldier_id,
        "seq": seq,
        "timestamp": timestamp,
        "lat": lat,
        "lon": lon,
        "hr": hr,
        "hrv": hrv,
        "spo2": spo2,
        "temp": temp,
        "batt": batt,
        "flags": decoded,
    }
    if not decoded["strap_connected"]:
        data["vital"] = "TANPA VITAL"
    return data


def make_record(
    *,
    category: str,
    data_type: str,
    entity_type: str | None,
    entity_id: str | None,
    soldier_id: int | None,
    group_id: str | None,
    gateway_id: str | None,
    event_time: str,
    received_at: str,
    position_source: str | None,
    transport: str | None,
    freshness: str | None,
    severity: str | None,
    record_origin: str | None,
    raw_format: str | None,
    raw_hex: str | None,
    data: dict,
    beacon_id: str | None = None,
    is_sos: int = 0,
    created_at: str | None = None,
) -> dict:
    stored_hex, nbytes = normalize_hex(raw_hex)
    return {
        "category": category,
        "data_type": data_type,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "soldier_id": soldier_id,
        "group_id": group_id,
        "gateway_id": gateway_id,
        "beacon_id": beacon_id,
        "event_time": event_time,
        "received_at": received_at,
        "position_source": position_source,
        "transport": transport,
        "freshness": freshness,
        "severity": severity,
        "record_origin": record_origin,
        "raw_format": raw_format,
        "raw_hex": stored_hex,
        "raw_bytes_length": nbytes,
        "data_json": json.dumps(data, separators=(",", ":")),
        "is_sos": is_sos,
        "created_at": created_at or utc_now(),
    }
