from fastapi.testclient import TestClient

from app.database import get_connection, insert_record
from app.frame import encode_flags, pack_mesh_frame, pack_payload
from app.records import make_record


def test_health(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "storage": "sqlite-local"}


def test_seed_counts(client: TestClient):
    summary = client.get("/api/explorer/summary").json()
    counts = {item["category"]: item["count"] for item in summary["by_category"]}
    assert summary["total"] == 505
    assert counts == {
        "TELEMETRY": 240,
        "MESH": 240,
        "BEACON": 18,
        "SYSTEM": 3,
        "UPLINK": 2,
        "SPECIAL": 2,
    }


def test_telemetry_keeps_sos_flag_visible(client: TestClient):
    flags = encode_flags(sos=True, strap=True, position="GNSS")
    response = client.post(
        "/api/ingest/telemetry",
        json={
            "soldier_id": 4242,
            "seq": 7,
            "timestamp": "2026-10-04T12:00:00Z",
            "lat": -6.2,
            "lon": 106.8,
            "hr": 80,
            "hrv": 40,
            "spo2": 98,
            "temp": 36,
            "batt": 90,
            "flags": flags,
            "group_id": "Alpha",
            "gateway_id": "GW-01",
            "record_origin": "INGEST",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["category"] == "TELEMETRY"
    assert body["data"]["flags"]["sos"] is True
    assert body["data"]["flags"]["position_source"] == "GNSS"
    assert body["position_source"] == "GNSS"
    assert body["raw_bytes_length"] == 21
    listed = client.get("/api/explorer", params={"soldier_id": 4242}).json()
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == body["id"]


def test_mesh_frame_decodes_25_bytes(client: TestClient):
    flags = encode_flags(position="GNSS")
    payload = pack_payload(
        soldier_id=1024,
        seq=125,
        timestamp=1791115200,
        lat=-6.2012345,
        lon=106.8123456,
        hr=82,
        hrv=41,
        spo2=97,
        temp=34,
        batt=86,
        flags=flags,
    )
    frame = pack_mesh_frame(1, 3, 1, payload)
    response = client.post(
        "/api/ingest/mesh-frame",
        json={
            "frame_hex": frame.hex(),
            "gateway_id": "GW-01",
            "group_id": "Alpha",
            "rssi": -87,
            "snr": 8.5,
            "pdr": 0.96,
            "spreading_factor": 9,
            "tx_power_dbm": 14,
            "received_at": "2026-10-04T12:00:04Z",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["category"] == "MESH"
    assert body["data_type"] == "LORA_FRAME"
    assert body["raw_bytes_length"] == 25
    assert body["data"]["ttl"] == 3
    assert body["data"]["hop_count"] == 1
    assert body["data"]["payload_length"] == 21
    assert body["data"]["payload"]["seq"] == 125
    assert body["data"]["payload"]["lat"] == -6.2012345
    assert body["data"]["spreading_factor"] == 9


def test_mesh_frame_rejects_short_hex(client: TestClient):
    response = client.post("/api/ingest/mesh-frame", json={"frame_hex": "abcd"})
    assert response.status_code == 400


def test_uplink_beacon_special_and_system(client: TestClient):
    uplink = client.post(
        "/api/ingest/uplink",
        json={
            "gateway_id": "GW-02",
            "burst_id": "burst-test",
            "packet_count": 8,
            "payload_size_bytes": 174,
            "sent_at": "2026-10-04T06:00:00Z",
            "received_at": "2026-10-04T09:00:00Z",
            "delivery_status": "delivered",
            "retry_count": 1,
            "session_duration_seconds": 30,
            "delivery_mode": "STORE_AND_CARRY",
        },
    )
    assert uplink.status_code == 200
    assert uplink.json()["data"]["delivery_mode"] == "STORE_AND_CARRY"
    assert uplink.json()["event_time"] == "2026-10-04T06:00:00Z"
    assert uplink.json()["received_at"] == "2026-10-04T09:00:00Z"

    rejected = client.post(
        "/api/ingest/uplink",
        json={
            "gateway_id": "GW-02",
            "burst_id": "burst-bad",
            "packet_count": 1,
            "payload_size_bytes": 21,
            "sent_at": "2026-10-04T06:00:00Z",
            "received_at": "2026-10-04T06:00:10Z",
            "delivery_status": "delivered",
            "retry_count": 0,
            "session_duration_seconds": 10,
            "delivery_mode": "MAYBE",
        },
    )
    assert rejected.status_code == 422

    beacon = client.post(
        "/api/ingest/beacon",
        json={
            "beacon_id": "B-99",
            "observer_id": "101",
            "rssi": -88,
            "timestamp": "2026-10-04T08:10:00Z",
            "gateway_id": "GW-01",
        },
    )
    assert beacon.status_code == 200
    assert beacon.json()["category"] == "BEACON"
    assert beacon.json()["soldier_id"] is None
    assert beacon.json()["entity_type"] == "BEACON"

    special = client.post(
        "/api/ingest/special",
        json={
            "special_type": "RR_SERIES",
            "soldier_id": 101,
            "group_id": "Alpha",
            "event_time": "2026-10-04T08:12:00Z",
            "received_at": "2026-10-04T08:12:05Z",
            "payload_hex": "001122",
            "transport": "MESH",
            "metadata": {"note": "opaque"},
        },
    )
    assert special.status_code == 200
    assert special.json()["data_type"] == "RR_SERIES"
    assert special.json()["raw_format"] == "OPAQUE"
    assert special.json()["data"]["metadata"] == {"note": "opaque"}

    system = client.post(
        "/api/ingest/system",
        json={
            "event_type": "DEVICE_STATE_CHANGE",
            "entity_type": "SOLDIER",
            "entity_id": "101",
            "event_time": "2026-10-04T08:20:00Z",
            "received_at": "2026-10-04T08:20:01Z",
            "severity": "WARNING",
            "group_id": "Alpha",
            "gateway_id": "GW-01",
            "details": {"state": "online"},
        },
    )
    assert system.status_code == 200
    assert system.json()["category"] == "SYSTEM"
    assert system.json()["severity"] == "WARNING"
    assert system.json()["soldier_id"] == 101


def test_explorer_search_detail_options_and_csv(client: TestClient):
    found = client.get("/api/explorer", params={"q": "STORE_AND_CARRY", "category": "UPLINK"}).json()
    assert found["total"] == 1
    assert found["items"][0]["data"]["delivery_mode"] == "STORE_AND_CARRY"

    record_id = found["items"][0]["id"]
    detail = client.get(f"/api/explorer/{record_id}")
    assert detail.status_code == 200
    body = detail.json()
    for field in (
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
    ):
        assert field in body

    missing = client.get("/api/explorer/999999")
    assert missing.status_code == 404

    options = client.get("/api/explorer/filters/options").json()
    assert "TELEMETRY" in options["categories"]
    assert "SIMULATED" in options["record_origins"]
    assert "GW-01" in options["gateways"]
    assert "PAYLOAD_21" in options["raw_formats"]

    exported = client.get("/api/explorer/export.csv", params={"category": "UPLINK"})
    assert exported.status_code == 200
    assert "text/csv" in exported.headers["content-type"]
    text = exported.text.lstrip("\ufeff")
    assert text.startswith("id,category,data_type,")
    assert sum(1 for line in text.splitlines() if ",UPLINK," in line) == 2


def test_sos_opens_alert_and_stays_in_explorer(client: TestClient):
    seeded = client.get("/api/alerts", params={"alert_type": "SOS", "soldier_id": 101}).json()
    assert seeded["total"] == 1
    assert seeded["items"][0]["severity"] == "critical"
    assert seeded["items"][0]["details"] == "SOS button pressed"
    explorer_before = client.get("/api/explorer/summary").json()["total"]

    flags = encode_flags(sos=True, strap=True, position="GNSS")
    created = client.post(
        "/api/ingest/telemetry",
        json={
            "soldier_id": 5150,
            "seq": 9,
            "timestamp": "2026-10-04T13:00:00Z",
            "lat": -6.21,
            "lon": 106.82,
            "hr": 140,
            "hrv": 20,
            "spo2": 96,
            "temp": 37,
            "batt": 70,
            "flags": flags,
            "group_id": "Alpha",
        },
    )
    assert created.status_code == 200
    listed = client.get("/api/explorer", params={"soldier_id": 5150}).json()
    assert listed["total"] == 1
    alerts = client.get("/api/alerts", params={"soldier_id": 5150, "alert_type": "SOS"}).json()
    assert alerts["total"] == 1
    assert alerts["items"][0]["source_record_id"] == created.json()["id"]
    assert client.get("/api/explorer/summary").json()["total"] == explorer_before + 1
    exported = client.get("/api/alerts/export.csv", params={"alert_type": "SOS"})
    assert exported.status_code == 200
    assert ",SOS," in exported.text


def test_sos_rows_stay_out_of_explorer(client: TestClient):
    with get_connection() as conn:
        hidden_id = insert_record(
            conn,
            make_record(
                category="SYSTEM",
                data_type="OTHER",
                entity_type="SOLDIER",
                entity_id="4242",
                soldier_id=4242,
                group_id="Alpha",
                gateway_id="GW-01",
                event_time="2026-10-04T12:10:00Z",
                received_at="2026-10-04T12:10:01Z",
                position_source=None,
                transport=None,
                freshness="FRESH",
                severity="CRITICAL",
                record_origin="INGEST",
                raw_format="JSON",
                raw_hex="sos-hidden-marker",
                data={"event_type": "OTHER"},
                is_sos=1,
            ),
        )
    listed = client.get("/api/explorer", params={"q": "sos-hidden-marker"}).json()
    assert listed["total"] == 0
    assert client.get(f"/api/explorer/{hidden_id}").status_code == 404
