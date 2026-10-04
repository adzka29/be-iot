import sqlite3
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request

from .access import (
    binding_label,
    effective_access,
    get_user,
    hash_password,
    load_binding,
    recalculate_user_status,
    user_item,
    verify_password,
)
from .audit import actor_for_user, actor_from_session, create_session, insert_audit, record_audit, session_token
from .database import get_connection
from .records import utc_now
from .schemas import (
    EffectiveAccess,
    HumanCreate,
    HumanUpdate,
    LoginIn,
    LoginOut,
    UserCreated,
    UserPage,
    UserSummary,
    UserUpdated,
)

router = APIRouter(prefix="/users", tags=["User Access"])

_IDENTITY_TYPES = {"HUMAN", "SERVICE"}
_STATUSES = {"INACTIVE", "ACTIVE", "SUSPENDED", "DISABLED"}
_VERIFICATIONS = {"PENDING", "VERIFIED"}
_BINDINGS = {"BOUND", "NO_BINDING"}


def _required(value: str, field: str) -> str:
    text = value.strip()
    if not text:
        raise HTTPException(status_code=422, detail=f"{field} is required")
    return text


def _email(value: str) -> str:
    text = _required(value, "email").lower()
    if "@" not in text or text.startswith("@") or text.endswith("@"):
        raise HTTPException(status_code=422, detail="email is invalid")
    return text


def _optional(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _binding_exists(now: str) -> tuple[str, list[str]]:
    return (
        """
        EXISTS (
            SELECT 1 FROM user_role_bindings b
            WHERE b.user_id = users.id
              AND b.status = 'ACTIVE'
              AND (b.valid_from IS NULL OR b.valid_from <= ?)
              AND (b.valid_until IS NULL OR b.valid_until >= ?)
        )
        """,
        [now, now],
    )


@router.get("", response_model=UserPage)
def list_users(
    identity_type: str | None = None,
    status: str | None = None,
    verification: str | None = None,
    access_binding: str | None = None,
    q: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    if identity_type and identity_type not in _IDENTITY_TYPES:
        raise HTTPException(status_code=400, detail="unknown identity_type")
    if status and status not in _STATUSES:
        raise HTTPException(status_code=400, detail="unknown status")
    if verification and verification not in _VERIFICATIONS:
        raise HTTPException(status_code=400, detail="unknown verification")
    if access_binding and access_binding not in _BINDINGS:
        raise HTTPException(status_code=400, detail="unknown access_binding")
    now = utc_now()
    conditions = ["deleted_at IS NULL"]
    params: list = []
    if identity_type:
        conditions.append("identity_type = ?")
        params.append(identity_type)
    if status:
        conditions.append("status = ?")
        params.append(status)
    if verification:
        conditions.append("verification = ?")
        params.append(verification)
    if access_binding:
        clause, clause_params = _binding_exists(now)
        conditions.append(clause if access_binding == "BOUND" else f"NOT {clause}")
        params.extend(clause_params)
    if q and q.strip():
        needle = f"%{q.strip()}%"
        conditions.append("(name LIKE ? OR IFNULL(username, '') LIKE ? OR IFNULL(email, '') LIKE ?)")
        params.extend([needle, needle, needle])
    where = " AND ".join(conditions)
    with get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM users WHERE {where}", params).fetchone()["n"]
        rows = conn.execute(
            f"""
            SELECT * FROM users
            WHERE {where}
            ORDER BY id ASC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, (page - 1) * limit],
        ).fetchall()
        items = [user_item(row, binding_label(load_binding(conn, row["id"]), now)) for row in rows]
    return {"items": items, "total": total, "page": page, "limit": limit}


@router.get("/summary", response_model=UserSummary)
def user_summary():
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT
                SUM(CASE WHEN identity_type = 'HUMAN' THEN 1 ELSE 0 END) AS total_humans,
                SUM(CASE WHEN identity_type = 'HUMAN' AND status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_humans,
                SUM(CASE WHEN identity_type = 'HUMAN' AND status = 'INACTIVE' THEN 1 ELSE 0 END) AS inactive_humans,
                SUM(CASE WHEN identity_type = 'SERVICE' THEN 1 ELSE 0 END) AS total_services,
                SUM(CASE WHEN identity_type = 'HUMAN' AND verification = 'PENDING' THEN 1 ELSE 0 END) AS pending_verification
            FROM users
            WHERE deleted_at IS NULL
            """
        ).fetchone()
        return {key: row[key] or 0 for key in row.keys()}


@router.post("/human", response_model=UserCreated, status_code=201)
def create_human(body: HumanCreate, request: Request):
    name = _required(body.name, "name")
    username = _required(body.username, "username")
    email = _email(body.email)
    password = body.password.strip()
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="password must be at least 8 characters")
    now = utc_now()
    metadata = {"username": username, "email": email, "department": _optional(body.department)}
    try:
        with get_connection() as conn:
            try:
                cursor = conn.execute(
                """
                INSERT INTO users (
                    identity_type, name, username, email, password_hash, department, title,
                    verification, status, created_at, updated_at
                )
                VALUES ('HUMAN', ?, ?, ?, ?, ?, ?, 'VERIFIED', 'INACTIVE', ?, ?)
                """,
                (
                    name,
                    username,
                    email,
                    hash_password(password),
                    _optional(body.department),
                    _optional(body.title),
                    now,
                    now,
                ),
            )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="username or email already exists") from exc
            user = get_user(conn, int(cursor.lastrowid))
            insert_audit(
                conn,
                category="USER_ACCESS",
                event_type="USER_CREATED",
                action="CREATE",
                target={"id": user["id"], "name": user["name"], "type": "USER"},
                description="Created new human identity.",
                request=request,
                metadata=metadata,
            )
            return {
                "id": user["id"],
                "name": user["name"],
                "verification": user["verification"],
                "access_binding": "NO_BINDING",
                "status": user["status"],
            }
    except HTTPException as exc:
        if exc.status_code == 409:
            record_audit(
                category="USER_ACCESS",
                event_type="USER_CREATED",
                action="CREATE",
                outcome="FAILED",
                target={"name": name, "type": "USER"},
                description="Failed to create human identity.",
                request=request,
                metadata={**metadata, "reason": exc.detail},
            )
        raise


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, request: Request):
    account = body.account.strip()
    password = body.password.strip()
    if not account or not password:
        raise HTTPException(status_code=401, detail="invalid account or password")
    failure_actor = None
    failure_event = "LOGIN_FAILED"
    failure_outcome = "FAILED"
    failure_description = "Login failed."
    try:
        with get_connection() as conn:
            user = conn.execute(
                """
                SELECT * FROM users
                WHERE deleted_at IS NULL AND username = ? COLLATE NOCASE
                """,
                (account,),
            ).fetchone()
            if user is None:
                user = conn.execute(
                    """
                    SELECT * FROM users
                    WHERE deleted_at IS NULL AND email = ?
                    """,
                    (account.lower(),),
                ).fetchone()
            if user is None or not verify_password(password, user["password_hash"]):
                if user is not None:
                    failure_actor = actor_for_user(conn, user)
                raise HTTPException(status_code=401, detail="invalid account or password")
            failure_actor = actor_for_user(conn, user)
            if user["identity_type"] != "HUMAN":
                failure_event = "ACCESS_DENIED"
                failure_outcome = "DENIED"
                failure_description = "Account is not human."
                raise HTTPException(status_code=403, detail="account is not human")
            if user["verification"] != "VERIFIED":
                failure_event = "ACCESS_DENIED"
                failure_outcome = "DENIED"
                failure_description = "Account is not verified."
                raise HTTPException(status_code=403, detail="account is not verified")
            if user["status"] != "ACTIVE":
                failure_event = "ACCESS_DENIED"
                failure_outcome = "DENIED"
                failure_description = "Account is not active."
                raise HTTPException(status_code=403, detail="account is not active")
            session_id = create_session(conn, user["id"])
            actor = actor_for_user(conn, user)
            insert_audit(
                conn,
                actor=actor,
                category="AUTHENTICATION",
                event_type="USER_LOGIN",
                action="LOGIN",
                target={"id": user["id"], "name": user["name"], "type": "USER"},
                description="Signed in.",
                request=request,
                session_id=session_id,
            )
            return {
                "id": user["id"],
                "name": user["name"],
                "username": user["username"],
                "email": user["email"],
                "department": user["department"],
                "verification": user["verification"],
                "status": user["status"],
                "access": effective_access(conn, user["id"]),
                "session_id": session_id,
            }
    except HTTPException as exc:
        if exc.status_code in {401, 403}:
            record_audit(
                actor=failure_actor,
                category="AUTHENTICATION",
                event_type=failure_event,
                action="LOGIN" if failure_event == "LOGIN_FAILED" else "ACCESS",
                outcome=failure_outcome,
                target={"name": account, "type": "USER"},
                description=failure_description,
                request=request,
                metadata={"account": account},
            )
        raise


@router.post("/logout", status_code=204)
def logout(request: Request):
    token = session_token(request)
    with get_connection() as conn:
        actor = actor_from_session(conn, token)
        if actor is None:
            raise HTTPException(status_code=401, detail="authentication required")
        conn.execute("DELETE FROM user_sessions WHERE id = ?", (token,))
        insert_audit(
            conn,
            actor=actor,
            category="AUTHENTICATION",
            event_type="USER_LOGOUT",
            action="LOGOUT",
            target={"id": actor["id"], "name": actor["name"], "type": "USER"},
            description="Signed out.",
            request=request,
            session_id=token,
        )


@router.get("/{user_id}/permissions", response_model=EffectiveAccess)
def user_permissions(user_id: int):
    with get_connection() as conn:
        access = effective_access(conn, user_id)
    if access is None:
        raise HTTPException(status_code=404, detail="user not found")
    return access


@router.patch("/{user_id}/human", response_model=UserUpdated)
def update_human(user_id: int, body: HumanUpdate, request: Request):
    try:
        with get_connection() as conn:
            user = get_user(conn, user_id)
            if user is None:
                raise HTTPException(status_code=404, detail="user not found")
            fields: dict[str, str | None] = {}
            if body.name is not None:
                fields["name"] = _required(body.name, "name")
            if body.username is not None:
                fields["username"] = _required(body.username, "username")
            if body.email is not None:
                fields["email"] = _email(body.email)
            if body.department is not None:
                fields["department"] = _optional(body.department)
            if body.title is not None:
                fields["title"] = _optional(body.title)
            if body.sponsor is not None:
                fields["sponsor"] = _optional(body.sponsor)
            if body.verification is not None:
                fields["verification"] = body.verification
            if fields:
                fields["updated_at"] = utc_now()
                assignments = ", ".join(f"{column} = ?" for column in fields)
                try:
                    conn.execute(
                        f"UPDATE users SET {assignments} WHERE id = ?",
                        [*fields.values(), user_id],
                    )
                except sqlite3.IntegrityError as exc:
                    raise HTTPException(status_code=409, detail="username or email already exists") from exc
            user = recalculate_user_status(conn, user_id)
            now = utc_now()
            item = user_item(user, binding_label(load_binding(conn, user_id), now))
            item["title"] = user["title"]
            item["sponsor"] = user["sponsor"]
            if fields:
                insert_audit(
                    conn,
                    category="USER_ACCESS",
                    event_type="USER_UPDATED",
                    action="UPDATE",
                    target={"id": user["id"], "name": user["name"], "type": "USER"},
                    description="Updated human identity.",
                    request=request,
                    metadata={"changed_fields": [key for key in fields if key != "updated_at"]},
                )
            return item
    except HTTPException as exc:
        if exc.status_code == 409:
            record_audit(
                category="USER_ACCESS",
                event_type="USER_UPDATED",
                action="UPDATE",
                outcome="FAILED",
                target={"id": str(user_id), "type": "USER"},
                description="Failed to update human identity.",
                request=request,
                metadata={"reason": exc.detail},
            )
        raise
