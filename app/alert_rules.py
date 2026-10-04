import json

from .records import canonical_time, parse_event_time, utc_now

OPEN_STATUSES = ("ACTIVE", "ACKNOWLEDGED")
NO_CONTACT_GAP_SECONDS = 30 * 60

MESSAGES = {
    "SOS": "SOS button pressed",
    "CASUALTY": "Casualty detected",
    "ARRHYTHMIA": "Arrhythmia detected",
    "LOW_BATTERY": "Battery low",
    "HEAT_STRESS": "Heat stress detected",
    "STRAP_DISCONNECTED": "Chest strap disconnected",
    "NO_CONTACT": "No telemetry for more than 30 minutes",
}

SEVERITY = {
    "SOS": "CRITICAL",
    "CASUALTY": "CRITICAL",
    "ARRHYTHMIA": "CRITICAL",
    "LOW_BATTERY": "WARNING",
    "HEAT_STRESS": "WARNING",
    "STRAP_DISCONNECTED": "INFO",
    "NO_CONTACT": "INFO",
}

_FLAG_RULES = (
    ("SOS", "sos", "FLAGS"),
    ("CASUALTY", "casualty", "FLAGS"),
    ("ARRHYTHMIA", "arrhythmia", "FLAGS"),
    ("LOW_BATTERY", "low_battery", "FLAGS"),
    ("HEAT_STRESS", "heat_stress", "FLAGS"),
)

_COLUMNS = (
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
    "details_json",
)


def _code(alert_type: str, soldier_id: int, event_time: str) -> str:
    stamp = event_time.replace("-", "").replace(":", "")
    return f"{alert_type}-{soldier_id}-{stamp}"


def _details(payload: dict) -> dict:
    flags = payload.get("flags")
    return {
        "seq": payload.get("seq"),
        "hr": payload.get("hr"),
        "hrv": payload.get("hrv"),
        "spo2": payload.get("spo2"),
        "temp": payload.get("temp"),
        "batt": payload.get("batt"),
        "flags": flags if isinstance(flags, dict) else {},
    }


def _insert(conn, row: dict) -> int:
    columns = ", ".join(_COLUMNS)
    marks = ", ".join("?" for _ in _COLUMNS)
    cursor = conn.execute(
        f"INSERT INTO alerts ({columns}) VALUES ({marks})",
        tuple(row[column] for column in _COLUMNS),
    )
    return int(cursor.lastrowid)


def _open_alert(conn, soldier_id: int, alert_type: str):
    return conn.execute(
        """
        SELECT * FROM alerts
        WHERE soldier_id = ? AND alert_type = ? AND status IN ('ACTIVE', 'ACKNOWLEDGED')
        ORDER BY id DESC
        LIMIT 1
        """,
        (soldier_id, alert_type),
    ).fetchone()


def _apply_condition(
    conn,
    *,
    soldier_id: int,
    alert_type: str,
    active: bool,
    derived_from: str,
    source_record_id: int | None,
    group_id: str | None,
    gateway_id: str | None,
    event_time: str,
    position_source: str | None,
    latitude: float | None,
    longitude: float | None,
    record_origin: str | None,
    details: dict,
) -> None:
    current = _open_alert(conn, soldier_id, alert_type)
    now = utc_now()
    if not active:
        if current is not None:
            conn.execute(
                """
                UPDATE alerts
                SET status = 'CLEARED', updated_at = ?
                WHERE id = ?
                """,
                (now, current["id"]),
            )
        return
    if current is not None:
        conn.execute(
            """
            UPDATE alerts
            SET last_seen_at = ?, source_record_id = ?, gateway_id = ?,
                position_source = ?, latitude = ?, longitude = ?,
                details_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                event_time,
                source_record_id,
                gateway_id,
                position_source,
                latitude,
                longitude,
                json.dumps(details, separators=(",", ":")),
                now,
                current["id"],
            ),
        )
        return
    _insert(
        conn,
        {
            "alert_code": _code(alert_type, soldier_id, event_time),
            "alert_type": alert_type,
            "severity": SEVERITY[alert_type],
            "status": "ACTIVE",
            "entity_type": "SOLDIER",
            "entity_id": str(soldier_id),
            "soldier_id": soldier_id,
            "group_id": group_id,
            "gateway_id": gateway_id,
            "source_record_id": source_record_id,
            "event_time": event_time,
            "first_seen_at": event_time,
            "last_seen_at": event_time,
            "position_source": position_source,
            "latitude": latitude,
            "longitude": longitude,
            "message": MESSAGES[alert_type],
            "acknowledged_at": None,
            "acknowledged_by": None,
            "resolved_at": None,
            "resolved_by": None,
            "derived_from": derived_from,
            "record_origin": record_origin,
            "created_at": now,
            "updated_at": now,
            "details_json": json.dumps(details, separators=(",", ":")),
        },
    )


def raise_alerts(
    conn,
    *,
    source_record_id: int,
    soldier_id: int | None,
    group_id: str | None,
    gateway_id: str | None,
    event_time: str,
    position_source: str | None,
    record_origin: str | None,
    payload: dict,
) -> None:
    if soldier_id is None:
        return
    flags = payload.get("flags")
    if isinstance(flags, dict):
        details = _details(payload)
        latitude = payload.get("lat")
        longitude = payload.get("lon")
        for alert_type, flag_name, derived_from in _FLAG_RULES:
            _apply_condition(
                conn,
                soldier_id=soldier_id,
                alert_type=alert_type,
                active=bool(flags.get(flag_name)),
                derived_from=derived_from,
                source_record_id=source_record_id,
                group_id=group_id,
                gateway_id=gateway_id,
                event_time=event_time,
                position_source=position_source,
                latitude=latitude,
                longitude=longitude,
                record_origin=record_origin,
                details=details,
            )
        _apply_condition(
            conn,
            soldier_id=soldier_id,
            alert_type="STRAP_DISCONNECTED",
            active=flags.get("strap_connected") is False,
            derived_from="CHEST_STRAP",
            source_record_id=source_record_id,
            group_id=group_id,
            gateway_id=gateway_id,
            event_time=event_time,
            position_source=position_source,
            latitude=latitude,
            longitude=longitude,
            record_origin=record_origin,
            details=details,
        )
    resolve_no_contact(conn, soldier_id, event_time)
    sync_no_contact(conn, event_time)


def resolve_no_contact(conn, soldier_id: int, event_time: str) -> None:
    now = utc_now()
    conn.execute(
        """
        UPDATE alerts
        SET status = 'RESOLVED', resolved_at = ?, resolved_by = 'engine', updated_at = ?
        WHERE soldier_id = ? AND alert_type = 'NO_CONTACT'
          AND status IN ('ACTIVE', 'ACKNOWLEDGED')
          AND event_time <= ?
        """,
        (event_time, now, soldier_id, event_time),
    )


def sync_no_contact(conn, as_of: str | None = None) -> None:
    clock = conn.execute(
        """
        SELECT MAX(event_time) AS t
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND soldier_id IS NOT NULL
        """
    ).fetchone()["t"]
    if as_of and (clock is None or as_of > clock):
        clock = as_of
    if not clock:
        return
    _, clock_unix = parse_event_time(clock)
    soldiers = conn.execute(
        """
        SELECT soldier_id, MAX(event_time) AS event_time
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND soldier_id IS NOT NULL
        GROUP BY soldier_id
        """
    ).fetchall()
    rows = []
    for soldier in soldiers:
        row = conn.execute(
            """
            SELECT soldier_id, group_id, gateway_id, event_time, position_source,
                   record_origin, id, data_json
            FROM explorer_records
            WHERE category = 'TELEMETRY' AND soldier_id = ? AND event_time = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (soldier["soldier_id"], soldier["event_time"]),
        ).fetchone()
        if row is not None:
            rows.append(row)
    for row in rows:
        _, seen_unix = parse_event_time(row["event_time"])
        if clock_unix - seen_unix <= NO_CONTACT_GAP_SECONDS:
            continue
        if _open_alert(conn, row["soldier_id"], "NO_CONTACT") is not None:
            continue
        detected = canonical_time(seen_unix + NO_CONTACT_GAP_SECONDS)
        payload = json.loads(row["data_json"])
        _apply_condition(
            conn,
            soldier_id=row["soldier_id"],
            alert_type="NO_CONTACT",
            active=True,
            derived_from="NO_TELEMETRY",
            source_record_id=row["id"],
            group_id=row["group_id"],
            gateway_id=row["gateway_id"],
            event_time=detected,
            position_source=row["position_source"],
            latitude=payload.get("lat"),
            longitude=payload.get("lon"),
            record_origin=row["record_origin"],
            details={"last_telemetry_at": row["event_time"], "gap_seconds": clock_unix - seen_unix},
        )


def seed_alerts(conn) -> None:
    episodes = (
        ("SOS", 101, "2026-10-04T08:00:00Z", "FLAGS"),
        ("SOS", 102, "2026-10-04T08:05:01Z", "FLAGS"),
        ("SOS", 103, "2026-10-04T08:10:02Z", "FLAGS"),
        ("CASUALTY", 104, "2026-10-04T08:12:03Z", "FLAGS"),
        ("ARRHYTHMIA", 105, "2026-10-04T08:18:04Z", "FLAGS"),
        ("ARRHYTHMIA", 106, "2026-10-04T08:20:05Z", "FLAGS"),
        ("LOW_BATTERY", 101, "2026-10-04T08:25:00Z", "FLAGS"),
        ("LOW_BATTERY", 102, "2026-10-04T08:25:01Z", "FLAGS"),
        ("LOW_BATTERY", 103, "2026-10-04T08:25:02Z", "FLAGS"),
        ("LOW_BATTERY", 104, "2026-10-04T08:25:03Z", "FLAGS"),
        ("LOW_BATTERY", 105, "2026-10-04T08:25:04Z", "FLAGS"),
        ("LOW_BATTERY", 106, "2026-10-04T08:25:05Z", "FLAGS"),
        ("LOW_BATTERY", 107, "2026-10-04T08:25:06Z", "FLAGS"),
        ("HEAT_STRESS", 101, "2026-10-04T08:26:00Z", "FLAGS"),
        ("HEAT_STRESS", 102, "2026-10-04T08:26:01Z", "FLAGS"),
        ("HEAT_STRESS", 103, "2026-10-04T08:26:02Z", "FLAGS"),
        ("HEAT_STRESS", 104, "2026-10-04T08:26:03Z", "FLAGS"),
        ("HEAT_STRESS", 105, "2026-10-04T08:26:04Z", "FLAGS"),
        ("STRAP_DISCONNECTED", 105, "2026-10-04T08:15:04Z", "CHEST_STRAP"),
        ("STRAP_DISCONNECTED", 106, "2026-10-04T08:15:05Z", "CHEST_STRAP"),
        ("STRAP_DISCONNECTED", 107, "2026-10-04T08:15:06Z", "CHEST_STRAP"),
        ("STRAP_DISCONNECTED", 108, "2026-10-04T08:15:07Z", "CHEST_STRAP"),
    )
    inserted = 0
    for alert_type, soldier_id, event_time, derived_from in episodes:
        source = conn.execute(
            """
            SELECT id, position_source, data_json
            FROM explorer_records
            WHERE category = 'TELEMETRY' AND soldier_id = ? AND event_time = ?
            ORDER BY id
            LIMIT 1
            """,
            (soldier_id, event_time),
        ).fetchone()
        payload = json.loads(source["data_json"]) if source is not None else {}
        _insert(
            conn,
            {
                "alert_code": _code(alert_type, soldier_id, event_time),
                "alert_type": alert_type,
                "severity": SEVERITY[alert_type],
                "status": "ACTIVE",
                "entity_type": "SOLDIER",
                "entity_id": str(soldier_id),
                "soldier_id": soldier_id,
                "group_id": "Alpha",
                "gateway_id": "GW-01",
                "source_record_id": None if source is None else source["id"],
                "event_time": event_time,
                "first_seen_at": event_time,
                "last_seen_at": event_time,
                "position_source": None if source is None else source["position_source"],
                "latitude": payload.get("lat"),
                "longitude": payload.get("lon"),
                "message": MESSAGES[alert_type],
                "acknowledged_at": None,
                "acknowledged_by": None,
                "resolved_at": None,
                "resolved_by": None,
                "derived_from": derived_from,
                "record_origin": "SIMULATED",
                "created_at": event_time,
                "updated_at": event_time,
                "details_json": json.dumps(_details(payload) if payload else {"condition": alert_type}),
            },
        )
        inserted += 1
    for offset in range(14):
        soldier_id = 301 + offset
        event_time = f"2026-10-04T07:{offset:02d}:00Z"
        _insert(
            conn,
            {
                "alert_code": _code("NO_CONTACT", soldier_id, event_time),
                "alert_type": "NO_CONTACT",
                "severity": "INFO",
                "status": "ACTIVE",
                "entity_type": "SOLDIER",
                "entity_id": str(soldier_id),
                "soldier_id": soldier_id,
                "group_id": "Alpha",
                "gateway_id": "GW-01",
                "source_record_id": None,
                "event_time": event_time,
                "first_seen_at": event_time,
                "last_seen_at": event_time,
                "position_source": None,
                "latitude": None,
                "longitude": None,
                "message": MESSAGES["NO_CONTACT"],
                "acknowledged_at": None,
                "acknowledged_by": None,
                "resolved_at": None,
                "resolved_by": None,
                "derived_from": "NO_TELEMETRY",
                "record_origin": "SIMULATED",
                "created_at": event_time,
                "updated_at": event_time,
                "details_json": json.dumps({"gap_seconds": NO_CONTACT_GAP_SECONDS}),
            },
        )
        inserted += 1
    if inserted != 36:
        raise RuntimeError(f"seeder inserted {inserted} alerts, expected 36")
