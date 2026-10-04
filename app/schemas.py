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
    timestamp: int | str
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
    received_at: int | str | None = None
    freshness: str | None = None
    raw_hex: str | None = None
    raw_format: str | None = None
    transport: str | None = None
    record_origin: str | None = None


class MeshFrameIn(BaseModel):
    frame_hex: str = Field(description="25-byte frame: 4-byte mesh header + 21-byte soldier payload")
    gateway_id: str | None = None
    group_id: str | None = None
    received_at: int | str | None = None
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
    sent_at: int | str
    received_at: int | str
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
    timestamp: int | str
    gateway_id: str | None = None
    raw_hex: str | None = None
    record_origin: str | None = None
    group_id: str | None = None


class SpecialIn(BaseModel):
    special_type: SpecialType
    soldier_id: int = Field(ge=0, le=65535)
    group_id: str | None = None
    event_time: int | str
    received_at: int | str
    payload_hex: str
    transport: str | None = None
    gateway_id: str | None = None
    record_origin: str | None = None
    metadata: dict[str, Any] | None = None


class AlertOut(BaseModel):
    id: int
    alert_code: str
    alert_type: str
    severity: str
    status: str
    entity_type: str
    entity_id: str
    soldier_id: int | None
    group_id: str | None
    gateway_id: str | None
    source_record_id: int | None
    event_time: str
    first_seen_at: str
    last_seen_at: str
    position_source: str | None
    latitude: float | None
    longitude: float | None
    message: str
    acknowledged_at: str | None
    acknowledged_by: str | None
    resolved_at: str | None
    resolved_by: str | None
    derived_from: str
    record_origin: str | None
    created_at: str
    updated_at: str
    details: dict[str, Any]
    source_record: ExplorerRecord | None


class AlertPage(BaseModel):
    items: list[AlertOut]
    limit: int
    offset: int
    count: int
    total: int


class AlertTimelineBucket(BaseModel):
    time: str
    count: int


class AlertSeverityCount(BaseModel):
    severity: str
    count: int


class AlertTypeCount(BaseModel):
    alert_type: str
    count: int


class AlertSummary(BaseModel):
    total: int
    timeline: list[AlertTimelineBucket]
    by_severity: list[AlertSeverityCount]
    by_type: list[AlertTypeCount]


class AlertFilterOptions(BaseModel):
    alert_types: list[str]
    severities: list[str]
    statuses: list[str]
    groups: list[str]
    gateways: list[str]
    derived_from: list[str]
    record_origins: list[str]


class AlertActorIn(BaseModel):
    by: str | None = None


HistoryScope = Literal["SOLDIER", "GROUP"]
HistoryDataType = Literal[
    "TELEMETRY",
    "MESH_FRAME",
    "UPLINK",
    "BEACON",
    "SPECIAL",
    "SYSTEM",
]


class HistoryItem(BaseModel):
    id: str
    source_type: Literal["RECORD"]
    source_id: int
    event_time: str
    received_at: str | None
    data_type: HistoryDataType
    category: str
    entity_type: str | None
    entity_id: str | None
    soldier_id: int | None
    group_id: str | None
    gateway_id: str | None
    position_source: str | None
    latitude: float | None
    longitude: float | None


class HistoryPage(BaseModel):
    items: list[HistoryItem]
    limit: int
    offset: int
    count: int
    total: int


class HistoryCards(BaseModel):
    total_distance_km: float
    distance_is_derived: bool
    heart_rate_avg_bpm: int | None
    battery_avg_percent: int | None
    total_records: int


class HistorySummary(BaseModel):
    cards: HistoryCards


class HistoryNamedCount(BaseModel):
    name: str
    count: int


class HistoryStatistics(BaseModel):
    total_records: int
    position_points: int
    soldiers: int
    by_data_type: list[HistoryNamedCount]
    by_position_source: list[HistoryNamedCount]


class HistoryChartBucket(BaseModel):
    time: str
    heart_rate_avg_bpm: int | None
    battery_avg_percent: int | None
    samples: int


class HistoryCharts(BaseModel):
    buckets: list[HistoryChartBucket]


class HistoryTrackPoint(BaseModel):
    id: str
    source_id: int
    soldier_id: int | None
    event_time: str
    latitude: float
    longitude: float
    position_source: str | None


class HistoryTrack(BaseModel):
    points: list[HistoryTrackPoint]


class HistoryPointDetail(BaseModel):
    id: str
    source_type: Literal["RECORD"]
    source_id: int
    event_time: str
    received_at: str | None
    data_type: HistoryDataType
    category: str
    entity_type: str | None
    entity_id: str | None
    soldier_id: int | None
    group_id: str | None
    gateway_id: str | None
    position_source: str | None
    latitude: float | None
    longitude: float | None
    transport: str | None
    details: dict[str, Any]


class HistoryFilterOptions(BaseModel):
    data_types: list[str]
    position_sources: list[str]
    gateways: list[str]
    soldiers: list[int]
    groups: list[str]


class SystemIn(BaseModel):
    event_type: SystemEventType
    entity_type: str
    entity_id: str
    event_time: int | str
    received_at: int | str
    severity: str
    freshness: str | None = None
    gateway_id: str | None = None
    group_id: str | None = None
    details: dict[str, Any] | None = None
    record_origin: str | None = None
