import json

from .records import utc_now

_RULES = (
    ("sos", "SOS", "critical", "SOS button pressed"),
    ("casualty", "CASUALTY", "critical", "Casualty detected"),
    ("arrhythmia", "ARRHYTHMIA", "critical", "Arrhythmia detected"),
    ("low_battery", "LOW_BATTERY", "warning", "Battery low"),
    ("heat_stress", "HEAT_STRESS", "warning", "Heat stress detected"),
)


def soldier_payload(category: str, data: dict) -> dict | None:
    if category == "MESH" and isinstance(data.get("payload"), dict):
        return data["payload"]
    if isinstance(data.get("flags"), dict):
        return data
    return None


def iter_alert_flags(payload: dict):
    flags = payload.get("flags")
    if not isinstance(flags, dict):
        return
    for key, alert_type, severity, details in _RULES:
        if flags.get(key):
            yield alert_type, severity, details
    if flags.get("strap_connected") is False:
        yield "STRAP_DISCONNECTED", "info", "Chest strap disconnected"


def raise_alerts(
    conn,
    *,
    source_record_id: int,
    soldier_id: int | None,
    group_id: str | None,
    gateway_id: str | None,
    event_time: str,
    received_at: str,
    position_source: str | None,
    record_origin: str | None,
    payload: dict,
) -> None:
    if soldier_id is None:
        return
    snapshot = {
        "seq": payload.get("seq"),
        "hr": payload.get("hr"),
        "hrv": payload.get("hrv"),
        "spo2": payload.get("spo2"),
        "temp": payload.get("temp"),
        "batt": payload.get("batt"),
        "flags": payload.get("flags"),
    }
    encoded = json.dumps(snapshot, separators=(",", ":"))
    created_at = utc_now()
    for alert_type, severity, details in iter_alert_flags(payload):
        conn.execute(
            """
            INSERT OR IGNORE INTO alerts (
                alert_type, severity, status, soldier_id, group_id, gateway_id,
                event_time, received_at, position_source, lat, lon, details,
                source_record_id, record_origin, data_json, created_at
            ) VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                alert_type,
                severity,
                soldier_id,
                group_id,
                gateway_id,
                event_time,
                received_at,
                position_source,
                payload.get("lat"),
                payload.get("lon"),
                details,
                source_record_id,
                record_origin,
                encoded,
                created_at,
            ),
        )


def backfill_alerts(conn) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM alerts").fetchone()["n"]
    if count:
        return
    rows = conn.execute(
        """
        SELECT *
        FROM explorer_records
        WHERE is_sos = 0 AND category IN ('TELEMETRY', 'MESH')
        ORDER BY CASE category WHEN 'TELEMETRY' THEN 0 ELSE 1 END, id
        """
    ).fetchall()
    for row in rows:
        payload = soldier_payload(row["category"], json.loads(row["data_json"]))
        if payload is None:
            continue
        raise_alerts(
            conn,
            source_record_id=row["id"],
            soldier_id=row["soldier_id"],
            group_id=row["group_id"],
            gateway_id=row["gateway_id"],
            event_time=row["event_time"],
            received_at=row["received_at"],
            position_source=row["position_source"],
            record_origin=row["record_origin"],
            payload=payload,
        )
