from datetime import datetime, timedelta, timezone

from .database import insert_record
from .frame import encode_flags, pack_mesh_frame, pack_payload
from .records import make_record, parse_event_time, telemetry_data

_BASE = datetime(2026, 10, 4, 8, 0, tzinfo=timezone.utc)

_SOLDIERS = (
    {"soldier_id": 101, "group_id": "Alpha", "lat": -6.20110, "lon": 106.81210},
    {"soldier_id": 102, "group_id": "Alpha", "lat": -6.20140, "lon": 106.81240},
    {"soldier_id": 103, "group_id": "Alpha", "lat": -6.20170, "lon": 106.81270},
    {"soldier_id": 104, "group_id": "Alpha", "lat": -6.20200, "lon": 106.81300},
    {"soldier_id": 105, "group_id": "Alpha", "lat": -6.20230, "lon": 106.81330},
    {"soldier_id": 106, "group_id": "Alpha", "lat": -6.20260, "lon": 106.81360},
    {"soldier_id": 107, "group_id": "Alpha", "lat": -6.20290, "lon": 106.81390},
    {"soldier_id": 108, "group_id": "Alpha", "lat": -6.20320, "lon": 106.81420},
)

_POSITIONS = ("GNSS", "DEAD_RECKONING", "TRILATERATION", "STALE")


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _freshness(event: datetime, received: datetime) -> str:
    gap = (received - event).total_seconds()
    if gap <= 30:
        return "FRESH"
    if gap <= 15 * 60:
        return "AGING"
    return "STALE"


def seed(conn) -> None:
    inserted = 0
    for minute in range(30):
        for index, soldier in enumerate(_SOLDIERS):
            event = _BASE + timedelta(minutes=minute, seconds=index)
            received = event + timedelta(seconds=4)
            position = _POSITIONS[(minute + index) % len(_POSITIONS)] if minute % 7 == 0 else "GNSS"
            strap = (minute + index) % 11 != 0
            flags = encode_flags(
                sos=minute == 0 and index == 0,
                casualty=minute == 12 and index == 2,
                arrhythmia=minute == 18 and index == 4,
                position=position,
                strap=strap,
                low_battery=soldier["soldier_id"] == 108 and minute > 24,
                heat_stress=minute > 26 and index == 1,
            )
            event_time = _iso(event)
            received_at = _iso(received)
            _, unix = parse_event_time(event_time)
            lat = round(soldier["lat"] + minute * 0.00001, 7)
            lon = round(soldier["lon"] + minute * 0.00001, 7)
            hr = 70 + ((minute + index) % 20)
            hrv = 30 + ((minute + index) % 25)
            spo2 = 95 + ((minute + index) % 4)
            temp = 36 + ((minute + index) % 3)
            batt = max(40, 96 - minute)
            payload = telemetry_data(
                soldier_id=soldier["soldier_id"],
                seq=(minute + index) % 256,
                timestamp=unix,
                lat=lat,
                lon=lon,
                hr=hr,
                hrv=hrv,
                spo2=spo2,
                temp=temp,
                batt=batt,
                flags=flags,
            )
            raw = pack_payload(
                soldier_id=soldier["soldier_id"],
                seq=payload["seq"],
                timestamp=unix,
                lat=lat,
                lon=lon,
                hr=hr,
                hrv=hrv,
                spo2=spo2,
                temp=temp,
                batt=batt,
                flags=flags,
            )
            insert_record(
                conn,
                make_record(
                    category="TELEMETRY",
                    data_type="SOLDIER_TELEMETRY",
                    entity_type="SOLDIER",
                    entity_id=str(soldier["soldier_id"]),
                    soldier_id=soldier["soldier_id"],
                    group_id=soldier["group_id"],
                    gateway_id="GW-01",
                    event_time=event_time,
                    received_at=received_at,
                    position_source=payload["flags"]["position_source"],
                    transport="MESH",
                    freshness=_freshness(event, received),
                    severity=None,
                    record_origin="SIMULATED",
                    raw_format="PAYLOAD_21",
                    raw_hex=raw.hex(),
                    data=payload,
                    created_at=received_at,
                ),
            )
            hop_count = (index + minute) % 3
            ttl = 4 - hop_count
            frame = pack_mesh_frame(1, ttl, hop_count, raw)
            insert_record(
                conn,
                make_record(
                    category="MESH",
                    data_type="LORA_FRAME",
                    entity_type="SOLDIER",
                    entity_id=str(soldier["soldier_id"]),
                    soldier_id=soldier["soldier_id"],
                    group_id=soldier["group_id"],
                    gateway_id="GW-01",
                    event_time=event_time,
                    received_at=received_at,
                    position_source=payload["flags"]["position_source"],
                    transport="LORA",
                    freshness=_freshness(event, received),
                    severity=None,
                    record_origin="SIMULATED",
                    raw_format="FRAME_25",
                    raw_hex=frame.hex(),
                    data={
                        "source_id": soldier["soldier_id"],
                        "seq": payload["seq"],
                        "ver_type": 1,
                        "ttl": ttl,
                        "hop_count": hop_count,
                        "payload_length": 21,
                        "rssi": -72 - hop_count * 8 - (minute % 5),
                        "snr": round(12 - hop_count * 1.5, 1),
                        "pdr": round(1 - hop_count * 0.04, 2),
                        "spreading_factor": 9,
                        "tx_power_dbm": 14,
                        "payload": payload,
                    },
                    created_at=received_at,
                ),
            )
            inserted += 2

    uplinks = (
        {
            "burst_id": "burst-20261004-083000",
            "sent_at": "2026-10-04T08:30:00Z",
            "received_at": "2026-10-04T08:30:18Z",
            "delivery_mode": "LIVE",
            "delivery_status": "delivered",
            "retry_count": 0,
            "session_duration_seconds": 18,
            "freshness": "FRESH",
            "raw_hex": "aa" + "11" * 86,
        },
        {
            "burst_id": "burst-20261004-060000",
            "sent_at": "2026-10-04T06:00:00Z",
            "received_at": "2026-10-04T08:40:00Z",
            "delivery_mode": "STORE_AND_CARRY",
            "delivery_status": "delivered",
            "retry_count": 2,
            "session_duration_seconds": 40,
            "freshness": "STALE",
            "raw_hex": "bb" + "22" * 86,
        },
    )
    for uplink in uplinks:
        insert_record(
            conn,
            make_record(
                category="UPLINK",
                data_type="SATELLITE_UPLINK",
                entity_type="GATEWAY",
                entity_id="GW-01",
                soldier_id=None,
                group_id="Alpha",
                gateway_id="GW-01",
                event_time=uplink["sent_at"],
                received_at=uplink["received_at"],
                position_source=None,
                transport="SATELLITE",
                freshness=uplink["freshness"],
                severity=None,
                record_origin="SIMULATED",
                raw_format="HEX",
                raw_hex=uplink["raw_hex"],
                data={
                    "gateway_id": "GW-01",
                    "burst_id": uplink["burst_id"],
                    "packet_count": 8,
                    "payload_size_bytes": 174,
                    "sent_at": uplink["sent_at"],
                    "received_at": uplink["received_at"],
                    "delivery_status": uplink["delivery_status"],
                    "retry_count": uplink["retry_count"],
                    "session_duration_seconds": uplink["session_duration_seconds"],
                    "delivery_mode": uplink["delivery_mode"],
                },
                created_at=uplink["received_at"],
            ),
        )
        inserted += 1

    for beacon_number in range(1, 7):
        for observation in range(3):
            observer = _SOLDIERS[observation]
            event = _BASE + timedelta(minutes=5 + beacon_number, seconds=observation * 5)
            event_time = _iso(event)
            received_at = _iso(event + timedelta(seconds=2))
            beacon_id = f"B-{beacon_number:02d}"
            insert_record(
                conn,
                make_record(
                    category="BEACON",
                    data_type="BEACON_OBSERVATION",
                    entity_type="BEACON",
                    entity_id=beacon_id,
                    soldier_id=None,
                    group_id="Alpha",
                    gateway_id="GW-01",
                    beacon_id=beacon_id,
                    event_time=event_time,
                    received_at=received_at,
                    position_source=None,
                    transport="LORA",
                    freshness="FRESH",
                    severity=None,
                    record_origin="SIMULATED",
                    raw_format="HEX",
                    raw_hex=f"{beacon_number:02x}{observation:02x}",
                    data={
                        "beacon_id": beacon_id,
                        "observer_id": str(observer["soldier_id"]),
                        "rssi": -60 - observation * 15 - beacon_number,
                        "timestamp": event_time,
                    },
                    created_at=received_at,
                ),
            )
            inserted += 1

    specials = (
        {
            "special_type": "RR_SERIES",
            "soldier_id": 101,
            "transport": "MESH",
            "payload_hex": bytes(range(100)).hex(),
            "event_time": "2026-10-04T08:12:00Z",
            "received_at": "2026-10-04T08:12:06Z",
            "freshness": "FRESH",
        },
        {
            "special_type": "EKG_RECORDING",
            "soldier_id": 102,
            "transport": "SATELLITE",
            "payload_hex": bytes(range(64)).hex(),
            "event_time": "2026-10-04T08:18:00Z",
            "received_at": "2026-10-04T08:33:00Z",
            "freshness": "AGING",
        },
    )
    for special in specials:
        insert_record(
            conn,
            make_record(
                category="SPECIAL",
                data_type=special["special_type"],
                entity_type="SOLDIER",
                entity_id=str(special["soldier_id"]),
                soldier_id=special["soldier_id"],
                group_id="Alpha",
                gateway_id="GW-01",
                event_time=special["event_time"],
                received_at=special["received_at"],
                position_source=None,
                transport=special["transport"],
                freshness=special["freshness"],
                severity=None,
                record_origin="SIMULATED",
                raw_format="OPAQUE",
                raw_hex=special["payload_hex"],
                data={
                    "special_type": special["special_type"],
                    "soldier_id": special["soldier_id"],
                    "metadata": {},
                },
                created_at=special["received_at"],
            ),
        )
        inserted += 1

    systems = (
        {
            "event_type": "DEVICE_STATE_CHANGE",
            "entity_type": "SOLDIER",
            "entity_id": "101",
            "soldier_id": 101,
            "severity": "WARNING",
            "gateway_id": "GW-01",
            "details": {"state": "strap_disconnected"},
        },
        {
            "event_type": "GATEWAY_STATE_CHANGE",
            "entity_type": "GATEWAY",
            "entity_id": "GW-01",
            "soldier_id": None,
            "severity": "INFO",
            "gateway_id": "GW-01",
            "details": {"state": "uplink_queue_ready"},
        },
        {
            "event_type": "COMMUNICATION_STATE_CHANGE",
            "entity_type": "GATEWAY",
            "entity_id": "GW-01",
            "soldier_id": None,
            "severity": "CRITICAL",
            "gateway_id": "GW-01",
            "details": {"state": "satellite_session_failed"},
        },
    )
    for offset, system in enumerate(systems):
        event = _BASE + timedelta(minutes=20, seconds=offset)
        event_time = _iso(event)
        received_at = _iso(event + timedelta(seconds=1))
        insert_record(
            conn,
            make_record(
                category="SYSTEM",
                data_type=system["event_type"],
                entity_type=system["entity_type"],
                entity_id=system["entity_id"],
                soldier_id=system["soldier_id"],
                group_id="Alpha",
                gateway_id=system["gateway_id"],
                event_time=event_time,
                received_at=received_at,
                position_source=None,
                transport=None,
                freshness="FRESH",
                severity=system["severity"],
                record_origin="SIMULATED",
                raw_format="JSON",
                raw_hex=None,
                data={
                    "event_type": system["event_type"],
                    "entity_type": system["entity_type"],
                    "entity_id": system["entity_id"],
                    "details": system["details"],
                },
                created_at=received_at,
            ),
        )
        inserted += 1

    if inserted != 505:
        raise RuntimeError(f"seeder inserted {inserted} records, expected 505")
