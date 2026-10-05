from fastapi.testclient import TestClient


def _login(client: TestClient, account: str = "superadmin", password: str = "superadmin") -> dict[str, str]:
    logged = client.post("/users/login", json={"account": account, "password": password})
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['session_id']}"}


def _reader(client: TestClient) -> dict[str, str]:
    created = client.post(
        "/users/human",
        json={
            "name": "Field Reader",
            "username": "field.reader",
            "email": "field.reader@trackforge.id",
            "password": "temporary-password",
        },
    )
    assert created.status_code == 201, created.text
    role = next(item for item in client.get("/roles").json()["items"] if item["name"] == "field operator")
    bound = client.post("/user-roles", json={"user_id": created.json()["id"], "role_id": role["id"]})
    assert bound.status_code == 201, bound.text
    return _login(client, "field.reader", "temporary-password")


def _geofence(client: TestClient) -> int:
    created = client.post(
        "/api/geofences",
        json={
            "name": "North Perimeter",
            "polygon": [[106.8, -6.2], [106.81, -6.2], [106.805, -6.21]],
        },
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def _alpha(client: TestClient, headers: dict[str, str]) -> int:
    options = client.get("/api/operations/groups/options", headers=headers)
    assert options.status_code == 200, options.text
    return next(item["id"] for item in options.json()["items"] if item["name"] == "Alpha")


def test_operations_follow_existing_groups_and_lifecycle(client: TestClient):
    assert client.get("/api/operations").status_code == 401
    reader = _reader(client)
    assert client.get("/api/operations", headers=reader).status_code == 200
    refused = client.post(
        "/api/operations",
        headers=reader,
        json={"name": "Nope", "start_at": "2026-10-05T08:00:00Z", "end_at": "2026-10-06T08:00:00Z"},
    )
    assert refused.status_code == 403

    admin = _login(client)
    alpha = _alpha(client, admin)
    fence = _geofence(client)
    choices = client.get("/api/operations/groups/options", headers=admin).json()["items"]
    alpha_choice = next(item for item in choices if item["id"] == alpha)
    assert alpha_choice["personnel_count"] == 8
    assert alpha_choice["commander_name"] is None

    created = client.post(
        "/api/operations",
        headers=admin,
        json={
            "name": "  Operation Alpha  ",
            "description": "Reconnaissance and surveillance operation",
            "start_at": "2026-10-05T08:00:00Z",
            "end_at": "2026-10-07T18:00:00Z",
            "group_ids": [alpha],
            "geofence_ids": [fence],
            "status": "ACTIVE",
        },
    )
    assert created.status_code == 422

    created = client.post(
        "/api/operations",
        headers=admin,
        json={
            "name": "  Operation Alpha  ",
            "description": "Reconnaissance and surveillance operation",
            "start_at": "2026-10-05T08:00:00Z",
            "end_at": "2026-10-07T18:00:00Z",
            "group_ids": [alpha],
            "geofence_ids": [fence],
        },
    )
    assert created.status_code == 201, created.text
    operation = created.json()
    operation_id = operation["id"]
    assert operation["status"] == "PLANNING"
    assert operation["name"] == "Operation Alpha"
    assert operation["operation_code"].startswith("OP-2026-")
    assert operation["summary"] == {"group_count": 1, "personnel_count": 8, "geofence_count": 1}
    assert operation["groups"][0]["name"] == "Alpha"
    assert operation["created_by"]["name"] == "Superadmin"

    listed = client.get("/api/operations", headers=admin, params={"q": "alpha", "status": "PLANNING", "group_id": alpha})
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["personnel_count"] == 8
    summary = client.get("/api/operations/summary", headers=admin).json()
    assert summary["planning"] == 1
    assert summary["total"] == 1
    filters = client.get("/api/operations/filters/options", headers=admin).json()
    assert "PLANNING" in filters["statuses"]
    assert any(item["name"] == "Alpha" for item in filters["groups"])

    rejected = client.patch(f"/api/operations/{operation_id}", headers=admin, json={"status": "ACTIVE"})
    assert rejected.status_code == 422
    renamed = client.patch(
        f"/api/operations/{operation_id}",
        headers=admin,
        json={"name": "Operation Alpha - Northern Recon", "end_at": "2026-10-08T18:00:00Z"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Operation Alpha - Northern Recon"
    assert renamed.json()["status"] == "PLANNING"

    people = client.get(f"/api/operations/{operation_id}/personnel", headers=admin).json()["items"]
    assert {item["soldier_id"] for item in people} == set(range(101, 109))
    mapped = client.get(f"/api/operations/{operation_id}/map", headers=admin).json()
    assert mapped["operation"]["name"] == "Operation Alpha - Northern Recon"
    assert mapped["positions"]
    assert mapped["geofences"][0]["name"] == "North Perimeter"
    alerts = client.get(f"/api/operations/{operation_id}/alerts", headers=admin).json()["items"]
    assert any(item["type"] == "SOS" and item["soldier_id"] in range(101, 109) for item in alerts)

    alert_id = next(item["id"] for item in alerts if item["type"] == "SOS")
    ticket = client.post(f"/api/alerts/{alert_id}/ticket", headers=admin)
    assert ticket.status_code == 201, ticket.text
    tickets = client.get(f"/api/operations/{operation_id}/tickets", headers=admin).json()["items"]
    assert tickets[0]["id"] == ticket.json()["id"]
    assert tickets[0]["source_alert_id"] == alert_id

    active = client.post(f"/api/operations/{operation_id}/activate", headers=admin)
    assert active.status_code == 200, active.text
    assert active.json()["status"] == "ACTIVE"
    assert client.post(f"/api/operations/{operation_id}/activate", headers=admin).status_code == 409
    assert client.delete(f"/api/operations/{operation_id}", headers=admin).status_code == 409
    held = client.post(f"/api/operations/{operation_id}/hold", headers=admin)
    assert held.json()["status"] == "ON_HOLD"
    resumed = client.post(f"/api/operations/{operation_id}/resume", headers=admin)
    assert resumed.json()["status"] == "ACTIVE"
    done = client.post(f"/api/operations/{operation_id}/complete", headers=admin)
    assert done.json()["status"] == "COMPLETED"
    assert client.post(f"/api/operations/{operation_id}/cancel", headers=admin).status_code == 409

    other = client.post(
        "/api/operations",
        headers=admin,
        json={
            "name": "Operation Bravo",
            "start_at": "2026-10-06T08:00:00Z",
            "end_at": "2026-10-09T18:00:00Z",
        },
    )
    assert other.status_code == 201, other.text
    other_id = other.json()["id"]
    missing = client.post(f"/api/operations/{other_id}/groups", headers=admin, json={"group_id": 999999})
    assert missing.status_code == 404
    added = client.post(f"/api/operations/{other_id}/groups", headers=admin, json={"group_id": alpha})
    assert added.status_code == 200, added.text
    assert added.json()["groups"][0]["id"] == alpha
    duplicate = client.post(f"/api/operations/{other_id}/groups", headers=admin, json={"group_id": alpha})
    assert duplicate.status_code == 409
    removed = client.delete(f"/api/operations/{other_id}/groups/{alpha}", headers=admin)
    assert removed.status_code == 200, removed.text
    assert removed.json()["groups"] == []
    assert client.get("/api/operations/groups/options", headers=admin).json()["items"]

    attached = client.post(f"/api/operations/{other_id}/geofences", headers=admin, json={"geofence_id": fence})
    assert attached.status_code == 200, attached.text
    detached = client.delete(f"/api/operations/{other_id}/geofences/{fence}", headers=admin)
    assert detached.json()["geofences"] == []

    deleted = client.delete(f"/api/operations/{other_id}", headers=admin)
    assert deleted.status_code == 204
    assert client.get(f"/api/operations/{other_id}", headers=admin).status_code == 404
    assert client.get("/api/geofences").json()["items"]
