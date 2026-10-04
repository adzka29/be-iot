from fastapi import APIRouter, HTTPException

from .alert_rules import raise_alerts
from .database import get_connection, get_record, insert_record, record_to_api
from .frame import decode_mesh_frame, pack_payload, parse_hex
from .records import make_record, parse_event_time, telemetry_data, utc_now
from .schemas import BeaconIn, ExplorerRecord, MeshFrameIn, SpecialIn, SystemIn, TelemetryIn, UplinkIn

router = APIRouter(prefix="/api/ingest", tags=["Ingest"])


def _clock(value: str) -> tuple[str, int]:
    try:
        return parse_event_time(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _received(value: str | None) -> str:
    if not value:
        return utc_now()
    received_at, _ = _clock(value)
    return received_at


def _origin(value: str | None) -> str:
    return value or "INGEST"


def _save(record: dict, soldier_payload: dict | None = None) -> dict:
    with get_connection() as conn:
        record_id = insert_record(conn, record)
        if soldier_payload is not None:
            raise_alerts(
                conn,
                source_record_id=record_id,
                soldier_id=record["soldier_id"],
                group_id=record["group_id"],
                gateway_id=record["gateway_id"],
                event_time=record["event_time"],
                received_at=record["received_at"],
                position_source=record["position_source"],
                record_origin=record["record_origin"],
                payload=soldier_payload,
            )
        row = get_record(conn, record_id)
    if row is None:
        raise HTTPException(status_code=500, detail="record was not stored")
    return record_to_api(row)


@router.post("/telemetry", response_model=ExplorerRecord)
def ingest_telemetry(body: TelemetryIn):
    event_time, unix = _clock(body.timestamp)
    data = telemetry_data(
        soldier_id=body.soldier_id,
        seq=body.seq,
        timestamp=unix,
        lat=body.lat,
        lon=body.lon,
        hr=body.hr,
        hrv=body.hrv,
        spo2=body.spo2,
        temp=body.temp,
        batt=body.batt,
        flags=body.flags,
    )
    raw_hex = body.raw_hex
    if raw_hex is None:
        raw_hex = pack_payload(
            soldier_id=body.soldier_id,
            seq=body.seq,
            timestamp=unix,
            lat=body.lat,
            lon=body.lon,
            hr=body.hr,
            hrv=body.hrv,
            spo2=body.spo2,
            temp=body.temp,
            batt=body.batt,
            flags=body.flags,
        ).hex()
    return _save(
        make_record(
            category="TELEMETRY",
            data_type="SOLDIER_TELEMETRY",
            entity_type="SOLDIER",
            entity_id=str(body.soldier_id),
            soldier_id=body.soldier_id,
            group_id=body.group_id,
            gateway_id=body.gateway_id,
            event_time=event_time,
            received_at=_received(body.received_at),
            position_source=data["flags"]["position_source"],
            transport=body.transport or "MESH",
            freshness=body.freshness or "FRESH",
            severity=None,
            record_origin=_origin(body.record_origin),
            raw_format=body.raw_format or "PAYLOAD_21",
            raw_hex=raw_hex,
            data=data,
        ),
        data,
    )


@router.post("/mesh-frame", response_model=ExplorerRecord)
def ingest_mesh_frame(body: MeshFrameIn):
    try:
        raw = parse_hex(body.frame_hex)
        frame = decode_mesh_frame(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = frame.payload
    data = {
        "source_id": payload.soldier_id,
        "seq": payload.seq,
        "ver_type": frame.ver_type,
        "ttl": frame.ttl,
        "hop_count": frame.hop_count,
        "payload_length": frame.payload_length,
        "payload": payload.as_data(),
    }
    for key, value in (
        ("rssi", body.rssi),
        ("snr", body.snr),
        ("pdr", body.pdr),
        ("spreading_factor", body.spreading_factor),
        ("tx_power_dbm", body.tx_power_dbm),
    ):
        if value is not None:
            data[key] = value

    return _save(
        make_record(
            category="MESH",
            data_type="LORA_FRAME",
            entity_type="SOLDIER",
            entity_id=str(payload.soldier_id),
            soldier_id=payload.soldier_id,
            group_id=body.group_id,
            gateway_id=body.gateway_id,
            event_time=_clock(str(payload.timestamp))[0],
            received_at=_received(body.received_at),
            position_source=payload.position_source,
            transport="LORA",
            freshness=body.freshness or "FRESH",
            severity=None,
            record_origin=_origin(body.record_origin),
            raw_format="FRAME_25",
            raw_hex=frame.raw.hex(),
            data=data,
        ),
        data["payload"],
    )


@router.post("/uplink", response_model=ExplorerRecord)
def ingest_uplink(body: UplinkIn):
    sent_at, _ = _clock(body.sent_at)
    received_at = _received(body.received_at)
    return _save(
        make_record(
            category="UPLINK",
            data_type="SATELLITE_UPLINK",
            entity_type="GATEWAY",
            entity_id=body.gateway_id,
            soldier_id=None,
            group_id=body.group_id,
            gateway_id=body.gateway_id,
            event_time=sent_at,
            received_at=received_at,
            position_source=None,
            transport="SATELLITE",
            freshness="STALE" if body.delivery_mode == "STORE_AND_CARRY" else "FRESH",
            severity=None,
            record_origin=_origin(body.record_origin),
            raw_format="HEX",
            raw_hex=body.raw_hex,
            data={
                "gateway_id": body.gateway_id,
                "burst_id": body.burst_id,
                "packet_count": body.packet_count,
                "payload_size_bytes": body.payload_size_bytes,
                "sent_at": sent_at,
                "received_at": received_at,
                "delivery_status": body.delivery_status,
                "retry_count": body.retry_count,
                "session_duration_seconds": body.session_duration_seconds,
                "delivery_mode": body.delivery_mode,
            },
        )
    )


@router.post("/beacon", response_model=ExplorerRecord)
def ingest_beacon(body: BeaconIn):
    event_time, _ = _clock(body.timestamp)
    return _save(
        make_record(
            category="BEACON",
            data_type="BEACON_OBSERVATION",
            entity_type="BEACON",
            entity_id=body.beacon_id,
            soldier_id=None,
            group_id=body.group_id,
            gateway_id=body.gateway_id,
            beacon_id=body.beacon_id,
            event_time=event_time,
            received_at=_received(body.timestamp),
            position_source=None,
            transport="LORA",
            freshness="FRESH",
            severity=None,
            record_origin=_origin(body.record_origin),
            raw_format="HEX",
            raw_hex=body.raw_hex,
            data={
                "beacon_id": body.beacon_id,
                "observer_id": body.observer_id,
                "rssi": body.rssi,
                "timestamp": event_time,
            },
        )
    )


@router.post("/special", response_model=ExplorerRecord)
def ingest_special(body: SpecialIn):
    try:
        parse_hex(body.payload_hex)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    event_time, _ = _clock(body.event_time)
    return _save(
        make_record(
            category="SPECIAL",
            data_type=body.special_type,
            entity_type="SOLDIER",
            entity_id=str(body.soldier_id),
            soldier_id=body.soldier_id,
            group_id=body.group_id,
            gateway_id=body.gateway_id,
            event_time=event_time,
            received_at=_received(body.received_at),
            position_source=None,
            transport=body.transport,
            freshness="FRESH",
            severity=None,
            record_origin=_origin(body.record_origin),
            raw_format="OPAQUE",
            raw_hex=body.payload_hex,
            data={
                "special_type": body.special_type,
                "soldier_id": body.soldier_id,
                "metadata": body.metadata or {},
            },
        )
    )


@router.post("/system", response_model=ExplorerRecord)
def ingest_system(body: SystemIn):
    event_time, _ = _clock(body.event_time)
    soldier_id = int(body.entity_id) if body.entity_type == "SOLDIER" and body.entity_id.isdigit() else None
    return _save(
        make_record(
            category="SYSTEM",
            data_type=body.event_type,
            entity_type=body.entity_type,
            entity_id=body.entity_id,
            soldier_id=soldier_id,
            group_id=body.group_id,
            gateway_id=body.gateway_id,
            event_time=event_time,
            received_at=_received(body.received_at),
            position_source=None,
            transport=None,
            freshness=body.freshness or "FRESH",
            severity=body.severity,
            record_origin=_origin(body.record_origin),
            raw_format="JSON",
            raw_hex=None,
            data={
                "event_type": body.event_type,
                "entity_type": body.entity_type,
                "entity_id": body.entity_id,
                "details": body.details or {},
            },
        )
    )
