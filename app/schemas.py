from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DeliveryMode = Literal["LIVE", "STORE_AND_CARRY", "RETRY", "UNKNOWN"]
SpecialType = Literal["RR_SERIES", "EKG_RECORDING"]
SystemEventType = Literal[
    "DEVICE_STATE_CHANGE",
    "GATEWAY_STATE_CHANGE",
    "COMMUNICATION_STATE_CHANGE",
    "OTHER",
]


class ExplorerRecord(BaseModel):
    id: int
    category: str
    data_type: str
    entity_type: str | None
    entity_id: str | None
    soldier_id: int | None
    group_id: str | None
    gateway_id: str | None
    event_time: str
    received_at: str
    position_source: str | None
    transport: str | None
    freshness: str | None
    severity: str | None
    record_origin: str | None
    raw_format: str | None
    raw_hex: str | None
    raw_bytes_length: int | None
    created_at: str
    data: dict[str, Any]


class ExplorerPage(BaseModel):
    items: list[ExplorerRecord]
    limit: int
    offset: int
    count: int
    total: int


class TimelineSegment(BaseModel):
    category: str
    count: int


class TimelineBucket(BaseModel):
    time: str
    count: int
    segments: list[TimelineSegment] = []


class CategoryCount(BaseModel):
    category: str
    count: int


class DataTypeCount(BaseModel):
    data_type: str
    count: int


class ExplorerSummary(BaseModel):
    total: int
    timeline: list[TimelineBucket]
    by_category: list[CategoryCount]
    by_data_type: list[DataTypeCount]


class FilterOptions(BaseModel):
    categories: list[str]
    data_types: list[str]
    entity_types: list[str]
    groups: list[str]
    gateways: list[str]
    position_sources: list[str]
    transports: list[str]
    freshness: list[str]
    severity: list[str]
    record_origins: list[str]
    raw_formats: list[str]


class TelemetryIn(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "soldier_id": 1024,
                    "seq": 125,
                    "timestamp": "2026-10-04T12:00:00Z",
                    "lat": -6.2012345,
                    "lon": 106.8123456,
                    "hr": 82,
                    "hrv": 41,
                    "spo2": 97,
                    "temp": 34,
                    "batt": 86,
                    "flags": 32,
                    "group_id": "Alpha",
                    "gateway_id": "GW-01",
                    "received_at": "2026-10-04T12:00:04Z",
                    "freshness": "FRESH",
                    "transport": "MESH",
                    "record_origin": "INGEST",
                }
            ]
        }
    )

    soldier_id: int = Field(ge=0, le=65535)
    seq: int = Field(ge=0, le=255)
    timestamp: str
    lat: float
    lon: float
    hr: int = Field(ge=0, le=255)
    hrv: int = Field(ge=0, le=255)
    spo2: int = Field(ge=0, le=255)
    temp: int = Field(ge=0, le=255)
    batt: int = Field(ge=0, le=255)
    flags: int = Field(ge=0, le=255)
    group_id: str | None = None
    gateway_id: str | None = None
    received_at: str | None = None
    freshness: str | None = None
    raw_hex: str | None = None
    raw_format: str | None = None
    transport: str | None = None
    record_origin: str | None = None


class MeshFrameIn(BaseModel):
    frame_hex: str = Field(description="25-byte frame: 4-byte mesh header + 21-byte soldier payload")
    gateway_id: str | None = None
    group_id: str | None = None
    received_at: str | None = None
    rssi: int | None = None
    snr: float | None = None
    pdr: float | None = None
    spreading_factor: int | None = None
    tx_power_dbm: int | None = None
    freshness: str | None = None
    record_origin: str | None = None


class UplinkIn(BaseModel):
    gateway_id: str
    burst_id: str
    raw_hex: str | None = None
    packet_count: int = Field(ge=0)
    payload_size_bytes: int = Field(ge=0)
    sent_at: str
    received_at: str
    delivery_status: str
    retry_count: int = Field(ge=0)
    session_duration_seconds: int = Field(ge=0)
    delivery_mode: DeliveryMode
    record_origin: str | None = None
    group_id: str | None = None


class BeaconIn(BaseModel):
    beacon_id: str
    observer_id: str
    rssi: int
    timestamp: str
    gateway_id: str | None = None
    raw_hex: str | None = None
    record_origin: str | None = None
    group_id: str | None = None


class SpecialIn(BaseModel):
    special_type: SpecialType
    soldier_id: int = Field(ge=0, le=65535)
    group_id: str | None = None
    event_time: str
    received_at: str
    payload_hex: str
    transport: str | None = None
    gateway_id: str | None = None
    record_origin: str | None = None
    metadata: dict[str, Any] | None = None


class SystemIn(BaseModel):
    event_type: SystemEventType
    entity_type: str
    entity_id: str
    event_time: str
    received_at: str
    severity: str
    freshness: str | None = None
    gateway_id: str | None = None
    group_id: str | None = None
    details: dict[str, Any] | None = None
    record_origin: str | None = None
