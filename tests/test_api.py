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


def test_direct_telemetry_uses_utc_and_21_byte_raw(client: TestClient):
    flags = encode_flags()
    unix = 1791115200
    response = client.post(
        "/api/ingest/telemetry",
        json={
            "soldier_id": 77,
            "seq": 4,
            "timestamp": unix,
            "lat": -6.2,
            "lon": 106.8,
            "hr": 80,
            "hrv": 40,
            "spo2": 98,
            "temp": 36,
            "batt": 90,
            "flags": flags,
            "received_at": "2026-10-04T19:00:04+07:00",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["event_time"] == "2026-10-04T12:00:00Z"
    assert body["received_at"] == "2026-10-04T12:00:04Z"
    assert body["data"]["timestamp"] == unix
    assert body["raw_format"] == "PAYLOAD_21"
    assert body["raw_bytes_length"] == 21
    assert body["raw_hex"] == pack_payload(
        soldier_id=77,
        seq=4,
        timestamp=unix,
        lat=-6.2,
        lon=106.8,
        hr=80,
        hrv=40,
        spo2=98,
        temp=36,
        batt=90,
        flags=flags,
    ).hex()

    rejected = client.post(
        "/api/ingest/telemetry",
        json={
            "soldier_id": 78,
            "seq": 1,
            "timestamp": "2026-10-04T12:00:00Z",
            "lat": -6.2,
            "lon": 106.8,
            "hr": 80,
            "hrv": 40,
            "spo2": 98,
            "temp": 36,
            "batt": 90,
            "flags": flags,
            "raw_hex": "abcd",
        },
    )
    assert rejected.status_code == 400

    listed = client.get(
        "/api/explorer",
        params={"from_time": "2026-10-04T15:00:00+07:00", "to_time": str(unix), "soldier_id": 77},
    )
    assert listed.status_code == 200
    assert listed.json()["total"] == 1


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
    assert seeded["items"][0]["severity"] == "CRITICAL"
    assert seeded["items"][0]["message"] == "SOS button pressed"
    assert seeded["items"][0]["source_record"]["soldier_id"] == 101
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


def test_alert_seed_distribution(client: TestClient):
    summary = client.get("/api/alerts/summary").json()
    assert summary["total"] == 36
    severities = {item["severity"]: item["count"] for item in summary["by_severity"]}
    kinds = {item["alert_type"]: item["count"] for item in summary["by_type"]}
    assert severities == {"CRITICAL": 6, "WARNING": 12, "INFO": 18}
    assert kinds == {
        "SOS": 3,
        "CASUALTY": 1,
        "ARRHYTHMIA": 2,
        "LOW_BATTERY": 7,
        "HEAT_STRESS": 5,
        "STRAP_DISCONNECTED": 4,
        "NO_CONTACT": 14,
    }
    sos = client.get("/api/alerts/sos").json()
    assert sos["total"] == 3
    options = client.get("/api/alerts/filters/options").json()
    assert "SOS" in options["alert_types"]
    assert "CRITICAL" in options["severities"]
    schema = client.get("/openapi.json").json()
    assert "/api/alerts/sos" in schema["paths"]
    assert "/api/alerts/{alert_id}/acknowledge" in schema["paths"]
    assert "alert_code" in schema["components"]["schemas"]["AlertOut"]["properties"]
    assert "source_record" in schema["components"]["schemas"]["AlertOut"]["properties"]


def test_arrhythmia_episode_does_not_duplicate(client: TestClient):
    def post(minute: int, *, active: bool):
        flags = encode_flags(arrhythmia=active, strap=True)
        response = client.post(
            "/api/ingest/telemetry",
            json={
                "soldier_id": 8800,
                "seq": minute,
                "timestamp": f"2026-10-04T12:{minute:02d}:00Z",
                "lat": -6.2,
                "lon": 106.8,
                "hr": 90,
                "hrv": 30,
                "spo2": 97,
                "temp": 36,
                "batt": 80,
                "flags": flags,
                "group_id": "Alpha",
                "gateway_id": "GW-01",
            },
        )
        assert response.status_code == 200, response.text
        return response.json()["id"]

    first = post(0, active=True)
    second = post(1, active=True)
    third = post(2, active=True)
    page = client.get("/api/alerts", params={"soldier_id": 8800, "alert_type": "ARRHYTHMIA"}).json()
    assert page["total"] == 1
    episode = page["items"][0]
    assert episode["source_record_id"] == third
    assert episode["first_seen_at"] == "2026-10-04T12:00:00Z"
    assert episode["last_seen_at"] == "2026-10-04T12:02:00Z"
    assert episode["status"] == "ACTIVE"
    assert first != second

    post(3, active=False)
    cleared = client.get("/api/alerts", params={"soldier_id": 8800, "alert_type": "ARRHYTHMIA"}).json()
    assert cleared["total"] == 1
    assert cleared["items"][0]["status"] == "CLEARED"

    post(10, active=True)
    reopened = client.get("/api/alerts", params={"soldier_id": 8800, "alert_type": "ARRHYTHMIA"}).json()
    assert reopened["total"] == 2
    assert reopened["items"][0]["status"] == "ACTIVE"
    assert reopened["items"][0]["event_time"] == "2026-10-04T12:10:00Z"


def test_acknowledge_and_resolve(client: TestClient):
    alert_id = client.get("/api/alerts", params={"alert_type": "CASUALTY"}).json()["items"][0]["id"]
    acknowledged = client.post(f"/api/alerts/{alert_id}/acknowledge", json={"by": "medic-1"})
    assert acknowledged.status_code == 200, acknowledged.text
    assert acknowledged.json()["status"] == "ACKNOWLEDGED"
    assert acknowledged.json()["acknowledged_by"] == "medic-1"
    resolved = client.post(f"/api/alerts/{alert_id}/resolve", json={"by": "medic-1"})
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["status"] == "RESOLVED"
    assert body["resolved_by"] == "medic-1"
    assert client.post(f"/api/alerts/{alert_id}/resolve", json={"by": "medic-1"}).status_code == 409


def test_no_contact_resolves_when_telemetry_returns(client: TestClient):
    before = client.get("/api/alerts", params={"soldier_id": 301, "alert_type": "NO_CONTACT"}).json()
    assert before["total"] == 1
    assert before["items"][0]["status"] == "ACTIVE"
    assert before["items"][0]["derived_from"] == "NO_TELEMETRY"
    flags = encode_flags(strap=True)
    response = client.post(
        "/api/ingest/telemetry",
        json={
            "soldier_id": 301,
            "seq": 1,
            "timestamp": "2026-10-04T08:00:00Z",
            "lat": -6.2,
            "lon": 106.8,
            "hr": 70,
            "hrv": 40,
            "spo2": 98,
            "temp": 36,
            "batt": 90,
            "flags": flags,
        },
    )
    assert response.status_code == 200, response.text
    after = client.get("/api/alerts", params={"soldier_id": 301, "alert_type": "NO_CONTACT"}).json()
    assert after["total"] == 1
    assert after["items"][0]["status"] == "RESOLVED"
    assert after["items"][0]["resolved_by"] == "engine"


def test_history_reads_explorer_without_double_counting(client: TestClient):
    params = {
        "scope": "SOLDIER",
        "soldier_id": 104,
        "from_time": "2026-10-04T08:00:00Z",
        "to_time": "2026-10-04T08:30:00Z",
    }
    summary = client.get("/api/history/summary", params=params)
    assert summary.status_code == 200, summary.text
    cards = summary.json()["cards"]
    assert cards["total_records"] == 60
    assert cards["distance_is_derived"] is True
    assert cards["total_distance_km"] > 0
    assert cards["heart_rate_avg_bpm"] is not None
    assert cards["battery_avg_percent"] is not None

    telemetry = client.get(
        "/api/history",
        params={**params, "history_data_type": "TELEMETRY", "limit": 500},
    ).json()
    assert telemetry["total"] == 30
    assert {item["data_type"] for item in telemetry["items"]} == {"TELEMETRY"}

    track = client.get("/api/history/track", params=params).json()["points"]
    assert len(track) == 30
    assert [point["event_time"] for point in track] == sorted(point["event_time"] for point in track)

    gnss = client.get(
        "/api/history/track",
        params={**params, "position_source": "GNSS"},
    ).json()["points"]
    assert 0 < len(gnss) < len(track)

    detail = client.get(f"/api/history/point/{track[0]['source_id']}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["id"] == f"R-{track[0]['source_id']}"
    assert body["details"]["vitals"]["hr"] is not None
    assert body["details"]["raw_data"]["raw_bytes_length"] == 21
    assert client.get("/api/history/point/999999").status_code == 404

    charts = client.get("/api/history/charts", params=params).json()["buckets"]
    assert charts
    assert charts[0]["samples"] == 30

    stats = client.get("/api/history/statistics", params=params).json()
    assert stats["position_points"] == 30
    assert stats["soldiers"] == 1

    options = client.get("/api/history/filters/options", params=params).json()
    assert "MESH_FRAME" in options["data_types"]
    assert "GNSS" in options["position_sources"]

    exported = client.get("/api/history/export.csv", params={**params, "history_data_type": "UPLINK"})
    assert exported.status_code == 200
    assert "text/csv" in exported.headers["content-type"]

    assert client.get("/api/history/summary", params={"scope": "SOLDIER"}).status_code == 400
    group = client.get("/api/history/summary", params={"scope": "GROUP", "group_id": "Alpha"}).json()
    assert group["cards"]["total_records"] == 505
    schema = client.get("/openapi.json").json()
    assert "/api/history/track" in schema["paths"]
    assert "/api/history/point/{record_id}" in schema["paths"]


def test_user_access_registry_role_and_binding(client: TestClient):
    import os
    import sqlite3

    from app.access import has_permission

    assert has_permission({"history"}, "history", "read") is True
    assert has_permission({"history"}, "history", "all") is True
    assert has_permission({"history.read"}, "history", "read") is True
    assert has_permission({"history.read"}, "history", "all") is False

    catalog = client.get("/permissions").json()["items"]
    codes = {item["code"] for item in catalog}
    assert len(codes) == 30
    assert "history" in codes and "history.read" in codes
    assert client.get("/roles/permissions").json()["items"] == catalog

    roles = client.get("/roles").json()["items"]
    assert [role["name"] for role in roles] == [
        "superadmin",
        "operations commander",
        "operations officer",
        "field operator",
        "device & fleet admin",
        "viewer",
    ]
    assert all(role["is_protected"] and role["is_system"] for role in roles)
    by_name = {role["name"]: role for role in roles}
    commander = client.get(f"/roles/{by_name['operations commander']['id']}/detail").json()
    commander_codes = {item["code"] for item in commander["permissions"]}
    assert "overview" in commander_codes and "overview.read" in commander_codes
    assert "user_access" not in commander_codes
    assert commander["display_name"] == "Operations Commander"
    viewer = client.get(f"/roles/{by_name['viewer']['id']}/permissions").json()["permissions"]
    assert viewer and all(item["code"].endswith(".read") for item in viewer)
    field = {item["code"] for item in client.get(f"/roles/{by_name['field operator']['id']}/permissions").json()["permissions"]}
    assert "history.read" in field and "history" not in field
    superadmin = by_name["superadmin"]
    assert client.put(
        f"/roles/{superadmin['id']}",
        json={
            "name": "superadmin",
            "duty_category": "Platform Administration",
            "description": "Changed.",
        },
    ).status_code == 403
    assert client.delete(f"/roles/{superadmin['id']}").status_code == 403

    seeded = client.post("/users/login", json={"account": "superadmin", "password": "superadmin"})
    assert seeded.status_code == 200, seeded.text
    assert seeded.json()["username"] == "superadmin"
    assert seeded.json()["status"] == "ACTIVE"
    assert seeded.json()["access"]["role"] == "superadmin"
    assert len(seeded.json()["access"]["permissions"]) == 30
    summary = client.get("/users/summary").json()
    assert summary["total_humans"] == 1
    assert summary["active_humans"] == 1
    assert summary["inactive_humans"] == 0
    assert summary["pending_verification"] == 0
    created = client.post(
        "/users/human",
        json={
            "name": "Andi Pratama",
            "username": "andi.pratama",
            "email": "Andi@trackforge.id",
            "password": "temporary-password",
            "department": "Command Operations",
            "title": "Operations Commander",
            "status": "ACTIVE",
            "access_binding": "BOUND",
        },
    )
    assert created.status_code == 201, created.text
    assert created.json() == {
        "id": created.json()["id"],
        "name": "Andi Pratama",
        "verification": "VERIFIED",
        "access_binding": "NO_BINDING",
        "status": "INACTIVE",
    }
    assert "password" not in created.json()
    user_id = created.json()["id"]
    stored = sqlite3.connect(os.environ["TRACKFORGE_DB"])
    password_hash = stored.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    stored.close()
    assert password_hash.startswith("pbkdf2_sha256$")
    assert "temporary-password" not in password_hash

    listed = client.get("/users", params={"q": "andi", "access_binding": "NO_BINDING"}).json()
    assert listed["total"] == 1
    assert listed["items"][0]["email"] == "andi@trackforge.id"
    assert listed["items"][0]["status"] == "INACTIVE"
    assert client.post(
        "/users/human",
        json={
            "name": "Andi Again",
            "username": "andi.pratama",
            "email": "other@trackforge.id",
            "password": "temporary-password",
        },
    ).status_code == 409

    custom = client.post(
        "/roles",
        json={
            "name": "  Operations Planner  ",
            "duty_category": "Operations Control",
            "description": "Operational planning role.",
            "privilege_narrative": "Provides required planning authority.",
            "least_privilege_baseline": "Only planning-related capabilities.",
        },
    )
    assert custom.status_code == 201, custom.text
    assert custom.json()["name"] == "operations planner"
    assert custom.json()["is_protected"] is False
    history_id = next(item["id"] for item in catalog if item["code"] == "history")
    read_id = next(item["id"] for item in catalog if item["code"] == "history.read")
    granted = client.patch(
        f"/roles/{custom.json()['id']}/permissions",
        json={"permissionIds": [history_id]},
    )
    assert granted.status_code == 200, granted.text
    assert {item["code"] for item in granted.json()["permissions"]} == {"history", "history.read"}
    read_only = client.patch(
        f"/roles/{custom.json()['id']}/permissions",
        json={"permissionIds": [read_id]},
    ).json()
    assert {item["code"] for item in read_only["permissions"]} == {"history.read"}
    assert client.patch(
        f"/roles/{custom.json()['id']}/permissions",
        json={"permissionIds": [999999]},
    ).status_code == 400

    bound = client.post(
        "/user-roles",
        json={"user_id": user_id, "role_id": custom.json()["id"], "description": "Planning desk"},
    )
    assert bound.status_code == 201, bound.text
    assert bound.json()["status"] == "ACTIVE"
    assert bound.json()["user_status"] == "ACTIVE"
    assert bound.json()["access_binding"] == "BOUND"
    assert client.post(
        "/user-roles",
        json={"user_id": user_id, "role_id": by_name["viewer"]["id"]},
    ).status_code == 409
    access = client.get(f"/users/{user_id}/permissions").json()
    assert access["role"] == "operations planner"
    assert access["permissions"] == ["history.read"]
    assert client.get("/users/summary").json()["active_humans"] == 2

    pending = client.patch(f"/users/{user_id}/human", json={"verification": "PENDING"})
    assert pending.status_code == 200, pending.text
    assert pending.json()["status"] == "INACTIVE"
    assert pending.json()["access_binding"] == "BOUND"
    assert client.get("/users/summary").json()["pending_verification"] == 1
    restored = client.patch(f"/users/{user_id}/human", json={"verification": "VERIFIED"})
    assert restored.json()["status"] == "ACTIVE"

    revoked = client.patch(f"/user-roles/{bound.json()['id']}/status", json={"status": "REVOKED"})
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["user_status"] == "INACTIVE"
    assert revoked.json()["access_binding"] == "NO_BINDING"
    assert client.get(f"/users/{user_id}/permissions").json()["permissions"] == []

    rebound = client.post(
        "/user-roles",
        json={"user_id": user_id, "role_id": by_name["viewer"]["id"]},
    )
    assert rebound.status_code == 201, rebound.text
    assert rebound.json()["id"] == bound.json()["id"]
    assert rebound.json()["user_status"] == "ACTIVE"
    viewer_access = client.get(f"/users/{user_id}/permissions").json()
    assert viewer_access["role"] == "viewer"
    assert "history.read" in viewer_access["permissions"]
    assert "history" not in viewer_access["permissions"]

    held = sqlite3.connect(os.environ["TRACKFORGE_DB"])
    held.execute("UPDATE users SET status = 'SUSPENDED' WHERE id = ?", (user_id,))
    held.commit()
    held.close()
    suspended = client.patch(f"/user-roles/{bound.json()['id']}/status", json={"status": "REVOKED"})
    assert suspended.json()["user_status"] == "SUSPENDED"
    assert client.delete(f"/roles/{custom.json()['id']}").status_code == 204
    assert client.get(f"/roles/{custom.json()['id']}/detail").status_code == 404
    assert client.get("/api/history/summary", params={"scope": "GROUP", "group_id": "Alpha"}).status_code == 200


def test_login_checks_password_and_returns_active_access(client: TestClient):
    import os
    import sqlite3

    from app.access import hash_password

    created = client.post(
        "/users/human",
        json={
            "name": "Andi Login",
            "username": "andi.login",
            "email": "andi.login@trackforge.id",
            "password": "temporary-password",
            "department": "Command Operations",
        },
    )
    assert created.status_code == 201, created.text
    user_id = created.json()["id"]
    body = {"account": "andi.login", "password": "temporary-password"}
    inactive = client.post("/users/login", json=body)
    assert inactive.status_code == 403
    assert inactive.json()["detail"] == "account is not active"
    assert client.post("/users/login", json={"account": "andi.login", "password": "wrong-password"}).status_code == 401
    assert client.post("/users/login", json={"account": "missing.user", "password": "temporary-password"}).status_code == 401

    viewer = next(role for role in client.get("/roles").json()["items"] if role["name"] == "viewer")
    bound = client.post("/user-roles", json={"user_id": user_id, "role_id": viewer["id"]})
    assert bound.status_code == 201, bound.text

    logged = client.post("/users/login", json={"account": "Andi.Login", "password": "temporary-password"})
    assert logged.status_code == 200, logged.text
    session = logged.json()
    assert session["id"] == user_id
    assert session["email"] == "andi.login@trackforge.id"
    assert session["status"] == "ACTIVE"
    assert session["access"]["role"] == "viewer"
    assert session["access"]["user_id"] == user_id
    assert "history.read" in session["access"]["permissions"]
    assert "history" not in session["access"]["permissions"]
    assert "password" not in session
    assert "password_hash" not in session

    by_email = client.post(
        "/users/login",
        json={"account": "ANDI.LOGIN@trackforge.id", "password": "temporary-password"},
    )
    assert by_email.status_code == 200, by_email.text
    assert by_email.json()["access"]["permissions"] == session["access"]["permissions"]

    pending = client.patch(f"/users/{user_id}/human", json={"verification": "PENDING"})
    assert pending.json()["status"] == "INACTIVE"
    unverified = client.post("/users/login", json=body)
    assert unverified.status_code == 403
    assert unverified.json()["detail"] == "account is not verified"

    stored = sqlite3.connect(os.environ["TRACKFORGE_DB"])
    stored.execute(
        """
        INSERT INTO users (
            identity_type, name, username, email, password_hash, verification, status, created_at, updated_at
        )
        VALUES ('SERVICE', 'Gateway Bot', 'gateway.bot', 'gateway.bot@trackforge.id', ?, 'VERIFIED', 'ACTIVE', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')
        """,
        (hash_password("temporary-password"),),
    )
    stored.commit()
    stored.close()
    service = client.post("/users/login", json={"account": "gateway.bot", "password": "temporary-password"})
    assert service.status_code == 403
    assert service.json()["detail"] == "account is not human"
    assert "/users/login" in client.get("/openapi.json").json()["paths"]
