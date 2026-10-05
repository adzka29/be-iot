import sqlite3

from fastapi import APIRouter, HTTPException, Request, Response

from .access import binding_label, effective_access, get_user, load_binding
from .audit import actor_for_user, actor_from_session, insert_audit, session_token
from .database import get_connection
from .records import utc_now
from .schemas import ProfileOut

auth_router = APIRouter(prefix="/auth", tags=["My Profile"])
profile_router = APIRouter(prefix="/users", tags=["My Profile"])

_ALLOWED_FIELDS = {"fullname", "email", "profile_image"}
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_LOGIN_METHOD = "Email & Password"
_ACCOUNT_TYPES = {"HUMAN": "Human", "SERVICE": "Service"}
_IMAGE_PATH = "/users/me/profile-image"


def _current_user(conn: sqlite3.Connection, request: Request) -> sqlite3.Row:
    actor = actor_from_session(conn, session_token(request))
    if actor is None:
        raise HTTPException(status_code=401, detail="authentication required")
    user = get_user(conn, actor["id"])
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


def _email(value: str) -> str:
    text = value.strip().lower()
    if not text or "@" not in text or text.startswith("@") or text.endswith("@"):
        raise HTTPException(status_code=422, detail="email is invalid")
    return text


def _image_mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(status_code=422, detail="profile image must be PNG, JPEG, or WEBP")


def _profile(conn: sqlite3.Connection, user: sqlite3.Row) -> dict:
    now = utc_now()
    access = effective_access(conn, user["id"])
    role = None
    if access and access["role_id"] is not None and access["role"] is not None:
        role = {"id": access["role_id"], "name": access["role"]}
    last_login = conn.execute(
        """
        SELECT timestamp FROM audit_logs
        WHERE actor_id = ? AND event_type = 'USER_LOGIN' AND outcome = 'SUCCESS'
        ORDER BY timestamp DESC, id DESC
        LIMIT 1
        """,
        (user["id"],),
    ).fetchone()
    image = user["profile_image"]
    return {
        "user": {
            "id": user["id"],
            "identityType": user["identity_type"],
            "fullName": user["name"],
            "username": user["username"],
            "email": user["email"],
            "profileImageUrl": None if image is None else _IMAGE_PATH,
            "department": user["department"],
            "status": user["status"],
            "verification": user["verification"],
            "accessBinding": binding_label(load_binding(conn, user["id"]), now),
            "role": role,
            "accountType": _ACCOUNT_TYPES.get(user["identity_type"], user["identity_type"]),
            "lastLoginAt": None if last_login is None else last_login["timestamp"],
            "loginMethod": _LOGIN_METHOD,
            "memberSince": user["created_at"],
        }
    }


def _text_field(form, key: str) -> str | None:
    if key not in form:
        return None
    value = form.get(key)
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=f"{key} must be text")
    return value


async def _image_field(form) -> tuple[bytes, str] | None:
    if "profile_image" not in form:
        return None
    upload = form.get("profile_image")
    if not hasattr(upload, "read"):
        raise HTTPException(status_code=422, detail="profile image must be a file")
    filename = getattr(upload, "filename", None) or ""
    if not filename:
        return None
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=422, detail="profile image is empty")
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=422, detail="profile image must be at most 5 MB")
    return data, _image_mime(data)


@auth_router.get("/me", response_model=ProfileOut)
def read_me(request: Request):
    with get_connection() as conn:
        return _profile(conn, _current_user(conn, request))


@profile_router.patch("/me", response_model=ProfileOut)
async def update_me(request: Request):
    content_type = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" not in content_type:
        raise HTTPException(status_code=415, detail="multipart/form-data required")
    form = await request.form()
    rejected = sorted(key for key in form.keys() if key not in _ALLOWED_FIELDS)
    if rejected:
        raise HTTPException(status_code=422, detail="field cannot be changed")
    fullname = _text_field(form, "fullname")
    email = _text_field(form, "email")
    image = await _image_field(form)
    with get_connection() as conn:
        user = _current_user(conn, request)
        fields: dict[str, object] = {}
        metadata: dict[str, object] = {}
        if fullname is not None:
            name = fullname.strip()
            if not name:
                raise HTTPException(status_code=422, detail="fullname is required")
            if name != user["name"]:
                fields["name"] = name
                metadata["fullname"] = name
        if email is not None:
            normalized = _email(email)
            if normalized != (user["email"] or "").lower():
                taken = conn.execute(
                    "SELECT id FROM users WHERE lower(email) = ? AND id != ?",
                    (normalized, user["id"]),
                ).fetchone()
                if taken is not None:
                    raise HTTPException(status_code=409, detail="email already exists")
                fields["email"] = normalized
                metadata["email"] = normalized
        if image is not None:
            fields["profile_image"] = image[0]
            fields["profile_image_mime"] = image[1]
            metadata["profile_image"] = True
        if not fields:
            raise HTTPException(status_code=422, detail="no profile changes")
        fields["updated_at"] = utc_now()
        assignments = ", ".join(f"{column} = ?" for column in fields)
        try:
            conn.execute(
                f"UPDATE users SET {assignments} WHERE id = ?",
                [*fields.values(), user["id"]],
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="email already exists") from exc
        updated = get_user(conn, user["id"])
        insert_audit(
            conn,
            actor=actor_for_user(conn, updated),
            category="USER_ACCESS",
            event_type="PROFILE_UPDATED",
            action="UPDATE",
            target={"id": updated["id"], "name": updated["name"], "type": "USER"},
            description="Updated profile.",
            request=request,
            metadata=metadata,
        )
        return _profile(conn, updated)


@profile_router.get("/me/profile-image")
def read_profile_image(request: Request):
    with get_connection() as conn:
        user = _current_user(conn, request)
        blob = user["profile_image"]
        if blob is None:
            raise HTTPException(status_code=404, detail="profile image not found")
        mime = user["profile_image_mime"] or "application/octet-stream"
        return Response(content=bytes(blob), media_type=mime)


@profile_router.delete("/me/profile-image", status_code=204)
def remove_profile_image(request: Request):
    with get_connection() as conn:
        user = _current_user(conn, request)
        if user["profile_image"] is None:
            raise HTTPException(status_code=404, detail="profile image not found")
        conn.execute(
            """
            UPDATE users
            SET profile_image = NULL, profile_image_mime = NULL, updated_at = ?
            WHERE id = ?
            """,
            (utc_now(), user["id"]),
        )
        insert_audit(
            conn,
            actor=actor_for_user(conn, user),
            category="USER_ACCESS",
            event_type="PROFILE_IMAGE_REMOVED",
            action="DELETE",
            target={"id": user["id"], "name": user["name"], "type": "USER"},
            description="Removed profile image.",
            request=request,
        )
