from fastapi.testclient import TestClient

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff" + b"\x00" * 16
WEBP = b"RIFF" + b"\x24\x00\x00\x00" + b"WEBP" + b"\x00" * 16
GIF = b"GIF89a" + b"\x00" * 16


def _form(fields: dict[str, str], files: dict | None = None) -> dict:
    payload = {key: (None, value) for key, value in fields.items()}
    if files:
        payload.update(files)
    return payload


def _login(client: TestClient) -> dict[str, str]:
    logged = client.post("/users/login", json={"account": "superadmin", "password": "superadmin"})
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['session_id']}"}


def test_profile_reads_existing_account_fields(client: TestClient):
    headers = _login(client)
    response = client.get("/auth/me", headers=headers)
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["fullName"] == "Superadmin"
    assert user["username"] == "superadmin"
    assert user["email"] == "superadmin@trackforge.id"
    assert user["profileImageUrl"] is None
    assert user["department"] == "Platform Administration"
    assert user["status"] == "ACTIVE"
    assert user["verification"] == "VERIFIED"
    assert user["accessBinding"] == "BOUND"
    assert user["role"]["name"] == "superadmin"
    assert user["accountType"] == "Human"
    assert user["identityType"] == "HUMAN"
    assert user["loginMethod"] == "Email & Password"
    assert user["memberSince"].endswith("Z")
    assert user["lastLoginAt"].endswith("Z")
    assert "phone" not in user
    assert "bio" not in user
    assert client.get("/auth/me").status_code == 401


def test_profile_updates_name_email_and_image_only(client: TestClient):
    headers = _login(client)
    rejected = client.patch(
        "/users/me",
        headers=headers,
        files=_form({"fullname": "Hacked", "username": "root", "role": "superadmin", "status": "ACTIVE"}),
    )
    assert rejected.status_code == 422
    assert rejected.json()["detail"] == "field cannot be changed"
    unchanged = client.get("/auth/me", headers=headers).json()["user"]
    assert unchanged["fullName"] == "Superadmin"
    assert unchanged["username"] == "superadmin"

    json_body = client.patch(
        "/users/me",
        headers=headers,
        json={"fullname": "Nope", "role": "viewer"},
    )
    assert json_body.status_code == 415

    updated = client.patch(
        "/users/me",
        headers=headers,
        files=_form(
            {"fullname": "  Administrator Baru  ", "email": "AdminBaru@Trackforge.id"},
            {"profile_image": ("avatar.png", PNG, "image/png")},
        ),
    )
    assert updated.status_code == 200, updated.text
    user = updated.json()["user"]
    assert user["fullName"] == "Administrator Baru"
    assert user["email"] == "adminbaru@trackforge.id"
    assert user["username"] == "superadmin"
    assert user["department"] == "Platform Administration"
    assert user["role"]["name"] == "superadmin"
    assert user["profileImageUrl"] == "/users/me/profile-image"

    image = client.get("/users/me/profile-image", headers=headers)
    assert image.status_code == 200
    assert image.content == PNG
    assert image.headers["content-type"].startswith("image/png")

    jpeg = client.patch(
        "/users/me",
        headers=headers,
        files={"profile_image": ("avatar.jpg", JPEG, "image/jpeg")},
    )
    assert jpeg.status_code == 200, jpeg.text
    assert client.get("/users/me/profile-image", headers=headers).headers["content-type"].startswith("image/jpeg")
    webp = client.patch(
        "/users/me",
        headers=headers,
        files={"profile_image": ("avatar.webp", WEBP, "image/webp")},
    )
    assert webp.status_code == 200, webp.text

    gif = client.patch(
        "/users/me",
        headers=headers,
        files={"profile_image": ("avatar.gif", GIF, "image/gif")},
    )
    assert gif.status_code == 422
    kept = client.get("/users/me/profile-image", headers=headers)
    assert kept.headers["content-type"].startswith("image/webp")
    assert kept.content == WEBP

    huge = b"\x89PNG\r\n\x1a\n" + b"\x00" * (5 * 1024 * 1024)
    oversized = client.patch(
        "/users/me",
        headers=headers,
        files={"profile_image": ("big.png", huge, "image/png")},
    )
    assert oversized.status_code == 422

    created = client.post(
        "/users/human",
        json={
            "name": "Sari Profile",
            "username": "sari.profile",
            "email": "sari.profile@trackforge.id",
            "password": "temporary-password",
        },
    )
    assert created.status_code == 201, created.text
    duplicate = client.patch(
        "/users/me",
        headers=headers,
        files=_form({"email": "sari.profile@trackforge.id"}),
    )
    assert duplicate.status_code == 409
    assert client.get("/auth/me", headers=headers).json()["user"]["email"] == "adminbaru@trackforge.id"

    empty = client.patch("/users/me", headers=headers, files=_form({"fullname": "Administrator Baru"}))
    assert empty.status_code == 422

    activity = client.get("/audit-logs/me", headers=headers)
    assert activity.status_code == 200
    events = [item["event"] for item in activity.json()["items"]]
    assert "Profile Updated" in events

    removed = client.delete("/users/me/profile-image", headers=headers)
    assert removed.status_code == 204
    assert client.get("/users/me/profile-image", headers=headers).status_code == 404
    assert client.get("/auth/me", headers=headers).json()["user"]["profileImageUrl"] is None
    assert client.delete("/users/me/profile-image", headers=headers).status_code == 404
    again = client.get("/audit-logs/me", headers=headers).json()["items"]
    assert any(item["event"] == "Profile Image Removed" for item in again)
    detail = client.get(f"/audit-logs/{again[0]['eventId']}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["eventType"] == "PROFILE_IMAGE_REMOVED"
