from fastapi.testclient import TestClient


def _login(client: TestClient, account: str = "superadmin", password: str = "superadmin") -> dict[str, str]:
    logged = client.post("/users/login", json={"account": account, "password": password})
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['session_id']}"}


def _member(client: TestClient, username: str, role_name: str) -> tuple[int, dict[str, str]]:
    created = client.post(
        "/users/human",
        json={
            "name": username.replace(".", " ").title(),
            "username": username,
            "email": f"{username}@trackforge.id",
            "password": "temporary-password",
            "department": "Command Operations",
        },
    )
    assert created.status_code == 201, created.text
    user_id = created.json()["id"]
    role = next(item for item in client.get("/roles").json()["items"] if item["name"] == role_name)
    bound = client.post("/user-roles", json={"user_id": user_id, "role_id": role["id"]})
    assert bound.status_code == 201, bound.text
    return user_id, _login(client, username, "temporary-password")


def _alert(client: TestClient) -> dict:
    listed = client.get("/api/alerts", params={"alert_type": "SOS", "status": "ACTIVE"})
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"], "expected an active SOS alert"
    return listed.json()["items"][0]


def test_ticket_is_created_only_from_an_alert(client: TestClient):
    headers = _login(client)
    assert client.post("/api/tickets", headers=headers).status_code == 405
    assert client.post("/api/alerts/999999/ticket", headers=headers).status_code == 404
    assert client.get("/api/tickets", headers=headers).json()["total"] == 0

    alert = _alert(client)
    created = client.post(f"/api/alerts/{alert['id']}/ticket", headers=headers)
    assert created.status_code == 201, created.text
    ticket = created.json()
    assert ticket["status"] == "OPEN"
    assert ticket["priority"] == "CRITICAL"
    assert ticket["ticket_code"].startswith("TK-")
    assert ticket["assignee"] is None
    assert ticket["source_alert"]["id"] == alert["id"]
    assert ticket["source_alert"]["alert_code"] == alert["alert_code"]
    assert ticket["source_alert"]["status"] == "ACKNOWLEDGED"
    assert ticket["created_by"]["username"] == "superadmin"
    assert ticket["created_by"]["role"] == "Superadmin"

    again = client.post(f"/api/alerts/{alert['id']}/ticket", headers=headers)
    assert again.status_code == 409
    stored = client.get(f"/api/alerts/{alert['id']}")
    assert stored.json()["status"] == "ACKNOWLEDGED"

    listed = client.get("/api/tickets", headers=headers, params={"q": "SOS", "status": "OPEN", "priority": "CRITICAL"})
    assert listed.status_code == 200, listed.text
    item = listed.json()["items"][0]
    assert item["title"] == "SOS Signal Received"
    assert item["description"] == "SOS button pressed"
    assert item["source_alert_code"] == alert["alert_code"]
    assert listed.json()["total"] == 1

    summary = client.get("/api/tickets/summary", headers=headers).json()
    assert summary["total"] == 1
    assert {"value": "OPEN", "count": 1} in summary["by_status"]
    assert {"value": "CRITICAL", "count": 1} in summary["by_priority"]
    options = client.get("/api/tickets/filters/options", headers=headers).json()
    assert "SOS" in options["alert_types"]
    assert "OPEN" in options["statuses"]

    rejected = client.patch(f"/api/tickets/{ticket['id']}", headers=headers, json={"status": "RESOLVED"})
    assert rejected.status_code == 422
    updated = client.patch(
        f"/api/tickets/{ticket['id']}",
        headers=headers,
        json={"response_plan": "Kirim Alpha response team.", "priority": "HIGH"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["response_plan"] == "Kirim Alpha response team."
    assert updated.json()["priority"] == "HIGH"
    assert updated.json()["status"] == "OPEN"

    activity = client.get("/audit-logs", headers=headers, params={"category": "TICKETS"})
    assert any(row["event"] == "Ticket Created" for row in activity.json()["items"])


def test_ticket_visibility_follows_the_current_user(client: TestClient):
    admin = _login(client)
    other_id, other = _member(client, "rina.field", "field operator")
    alert = _alert(client)
    created = client.post(f"/api/alerts/{alert['id']}/ticket", headers=admin)
    assert created.status_code == 201, created.text
    ticket_id = created.json()["id"]

    assert client.get("/api/tickets", headers=other).json()["total"] == 0
    assert client.get("/api/tickets/summary", headers=other).json()["total"] == 0
    assert client.get(f"/api/tickets/{ticket_id}", headers=other).status_code == 404
    assert client.get("/api/tickets/filters/options", headers=other).json()["alert_types"] == []

    hidden = client.post("/api/alerts/1/ticket")
    assert hidden.status_code == 401

    assigned = client.post(f"/api/tickets/{ticket_id}/assign", headers=admin, json={"user_id": other_id})
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["assignee"]["id"] == other_id
    assert assigned.json()["assignee"]["username"] == "rina.field"
    assert assigned.json()["assignee"]["role"] == "Field Operator"
    assert client.get("/api/tickets", headers=other).json()["total"] == 1
    assert client.get(f"/api/tickets/{ticket_id}", headers=other).status_code == 200

    outsider = client.post(
        "/users/human",
        json={
            "name": "Idle User",
            "username": "idle.user",
            "email": "idle.user@trackforge.id",
            "password": "temporary-password",
        },
    )
    refused = client.post(
        f"/api/tickets/{ticket_id}/assign",
        headers=admin,
        json={"user_id": outsider.json()["id"]},
    )
    assert refused.status_code == 409


def test_ticket_lifecycle_tasks_and_updates(client: TestClient):
    admin = _login(client)
    assignee_id, assignee = _member(client, "rina.field", "field operator")
    helper_id, helper = _member(client, "andi.helper", "viewer")
    alert = _alert(client)
    ticket_id = client.post(f"/api/alerts/{alert['id']}/ticket", headers=admin).json()["id"]

    started = client.post(f"/api/tickets/{ticket_id}/start-working", headers=assignee)
    assert started.status_code == 404

    assigned = client.post(f"/api/tickets/{ticket_id}/assign", headers=admin, json={"user_id": assignee_id})
    assert assigned.status_code == 200, assigned.text
    takeover = client.post(f"/api/tickets/{ticket_id}/start-working", headers=admin)
    assert takeover.status_code == 403
    owned = client.post(f"/api/tickets/{ticket_id}/start-working", headers=assignee)
    assert owned.status_code == 200, owned.text
    assert owned.json()["status"] == "IN_PROGRESS"
    assert owned.json()["assignee"]["username"] == "rina.field"
    assert owned.json()["started_at"]

    waiting = client.post(f"/api/tickets/{ticket_id}/waiting", headers=assignee)
    assert waiting.status_code == 200, waiting.text
    assert waiting.json()["status"] == "WAITING"
    assert client.post(f"/api/tickets/{ticket_id}/waiting", headers=admin).status_code == 403
    resumed = client.post(f"/api/tickets/{ticket_id}/start-working", headers=assignee)
    assert resumed.json()["status"] == "IN_PROGRESS"

    assert client.post(f"/api/tickets/{ticket_id}/close", headers=assignee).status_code == 409
    collaborator = client.post(
        f"/api/tickets/{ticket_id}/collaborators",
        headers=assignee,
        json={"user_id": helper_id},
    )
    assert collaborator.status_code == 200, collaborator.text
    assert collaborator.json()["collaborators"][0]["username"] == "andi.helper"
    assert client.post(f"/api/tickets/{ticket_id}/resolve", headers=helper).status_code == 403
    duplicate = client.post(
        f"/api/tickets/{ticket_id}/collaborators",
        headers=assignee,
        json={"user_id": helper_id},
    )
    assert duplicate.status_code == 409
    creator = client.post(
        f"/api/tickets/{ticket_id}/collaborators",
        headers=assignee,
        json={"user_id": collaborator.json()["created_by"]["id"]},
    )
    assert creator.status_code == 409

    outside = client.post(
        f"/api/tickets/{ticket_id}/tasks",
        headers=assignee,
        json={"title": "Dispatch response team", "assignee_id": 999999, "priority": "HIGH"},
    )
    assert outside.status_code == 409
    task = client.post(
        f"/api/tickets/{ticket_id}/tasks",
        headers=assignee,
        json={
            "title": "Dispatch response team",
            "description": "Send one team to the last known position.",
            "assignee_id": helper_id,
            "priority": "HIGH",
        },
    )
    assert task.status_code == 201, task.text
    assert task.json()["status"] == "TODO"
    assert task.json()["assignee"]["id"] == helper_id
    done = client.patch(
        f"/api/tickets/{ticket_id}/tasks/{task.json()['id']}",
        headers=helper,
        json={"status": "DONE"},
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "DONE"
    assert done.json()["completed_at"]

    spoofed = client.post(
        f"/api/tickets/{ticket_id}/updates",
        headers=helper,
        json={"author_id": assignee_id, "message": "Not me"},
    )
    assert spoofed.status_code == 422
    posted = client.post(
        f"/api/tickets/{ticket_id}/updates",
        headers=helper,
        json={"message": "Response team has been dispatched."},
    )
    assert posted.status_code == 201, posted.text
    assert posted.json()["author"]["id"] == helper_id

    resolved = client.post(f"/api/tickets/{ticket_id}/resolve", headers=assignee)
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "RESOLVED"
    assert client.get(f"/api/alerts/{alert['id']}").json()["status"] == "RESOLVED"
    closed = client.post(f"/api/tickets/{ticket_id}/close", headers=assignee)
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "CLOSED"
    assert closed.json()["closed_at"]

    removed = client.delete(f"/api/tickets/{ticket_id}/collaborators/{helper_id}", headers=admin)
    assert removed.status_code == 200, removed.text
    assert removed.json()["collaborators"] == []
    assert client.get(f"/users/{helper_id}/permissions").status_code == 200
