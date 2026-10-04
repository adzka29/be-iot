"""Kontrak udara TrackForge: header mesh 4 byte + payload prajurit 21 byte.

Multi-byte fields are little-endian, matching nRF52840 and ESP32.
"""

import struct
from dataclasses import dataclass

HEADER_LEN = 4
PAYLOAD_LEN = 21
FRAME_LEN = HEADER_LEN + PAYLOAD_LEN

_PAYLOAD = struct.Struct("<HBIiiBBBBBB")

POSITION_SOURCES = ("GNSS", "DEAD_RECKONING", "TRILATERATION", "STALE")

if _PAYLOAD.size != PAYLOAD_LEN:
    raise RuntimeError("21-byte payload struct does not match PAYLOAD_LEN")


def encode_flags(
    *,
    sos: bool = False,
    casualty: bool = False,
    arrhythmia: bool = False,
    position: str = "GNSS",
    strap: bool = True,
    low_battery: bool = False,
    heat_stress: bool = False,
) -> int:
    value = POSITION_SOURCES.index(position) << 3
    if sos:
        value |= 0b1
    if casualty:
        value |= 0b10
    if arrhythmia:
        value |= 0b100
    if strap:
        value |= 1 << 5
    if low_battery:
        value |= 1 << 6
    if heat_stress:
        value |= 1 << 7
    return value


def decode_flags(flags: int) -> dict:
    return {
        "raw": flags,
        "sos": bool(flags & 0b1),
        "casualty": bool(flags & 0b10),
        "arrhythmia": bool(flags & 0b100),
        "position_source": POSITION_SOURCES[(flags >> 3) & 0b11],
        "strap_connected": bool(flags & (1 << 5)),
        "low_battery": bool(flags & (1 << 6)),
        "heat_stress": bool(flags & (1 << 7)),
    }


def position_from_flags(flags: int) -> str:
    return decode_flags(flags)["position_source"]


@dataclass(frozen=True)
class SoldierPayload:
    soldier_id: int
    seq: int
    timestamp: int
    lat: float
    lon: float
    hr: int
    hrv: int
    spo2: int
    temp: int
    batt: int
    flags: int

    @property
    def position_source(self) -> str:
        return position_from_flags(self.flags)

    def as_data(self) -> dict:
        flags = decode_flags(self.flags)
        data = {
            "soldier_id": self.soldier_id,
            "seq": self.seq,
            "timestamp": self.timestamp,
            "lat": self.lat,
            "lon": self.lon,
            "hr": self.hr,
            "hrv": self.hrv,
            "spo2": self.spo2,
            "temp": self.temp,
            "batt": self.batt,
            "flags": flags,
        }
        if not flags["strap_connected"]:
            data["vital"] = "TANPA VITAL"
        return data


@dataclass(frozen=True)
class MeshFrame:
    ver_type: int
    ttl: int
    hop_count: int
    payload_length: int
    payload: SoldierPayload
    raw: bytes


def parse_hex(raw_hex: str) -> bytes:
    cleaned = "".join(raw_hex.strip().removeprefix("0x").split())
    if not cleaned or len(cleaned) % 2 != 0:
        raise ValueError("hex must be an even-length hexadecimal string")
    try:
        return bytes.fromhex(cleaned)
    except ValueError as exc:
        raise ValueError("hex is not hexadecimal") from exc


def _degrees(e7: int) -> float:
    return round(e7 / 10_000_000, 7)


def degrees_to_e7(degrees: float) -> int:
    return int(round(degrees * 10_000_000))


def pack_payload(
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
) -> bytes:
    return _PAYLOAD.pack(
        soldier_id,
        seq,
        timestamp,
        degrees_to_e7(lat),
        degrees_to_e7(lon),
        hr,
        hrv,
        spo2,
        temp,
        batt,
        flags,
    )


def pack_mesh_frame(ver_type: int, ttl: int, hop_count: int, payload: bytes) -> bytes:
    if len(payload) != PAYLOAD_LEN:
        raise ValueError(f"soldier payload must be {PAYLOAD_LEN} bytes, got {len(payload)}")
    return bytes([ver_type & 0xFF, ttl & 0xFF, hop_count & 0xFF, PAYLOAD_LEN]) + payload


def decode_payload(payload: bytes) -> SoldierPayload:
    if len(payload) != PAYLOAD_LEN:
        raise ValueError(f"soldier payload must be {PAYLOAD_LEN} bytes, got {len(payload)}")
    (
        soldier_id,
        seq,
        timestamp,
        lat_e7,
        lon_e7,
        hr,
        hrv,
        spo2,
        temp,
        batt,
        flags,
    ) = _PAYLOAD.unpack(payload)
    return SoldierPayload(
        soldier_id=soldier_id,
        seq=seq,
        timestamp=timestamp,
        lat=_degrees(lat_e7),
        lon=_degrees(lon_e7),
        hr=hr,
        hrv=hrv,
        spo2=spo2,
        temp=temp,
        batt=batt,
        flags=flags,
    )


def decode_mesh_frame(raw: bytes) -> MeshFrame:
    if len(raw) != FRAME_LEN:
        raise ValueError(
            f"mesh frame must be {FRAME_LEN} bytes (4-byte header + 21-byte payload), got {len(raw)}"
        )
    ver_type, ttl, hop_count, payload_length = raw[:HEADER_LEN]
    if payload_length != PAYLOAD_LEN:
        raise ValueError(f"payload_len must be {PAYLOAD_LEN}, got {payload_length}")
    return MeshFrame(
        ver_type=ver_type,
        ttl=ttl,
        hop_count=hop_count,
        payload_length=payload_length,
        payload=decode_payload(raw[HEADER_LEN:]),
        raw=raw,
    )
