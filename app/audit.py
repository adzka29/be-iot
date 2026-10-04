import csv
import io
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response

from .access import display_name, effective_access
from .database import get_connection
from .records import canonical_time, utc_now
from .schemas import AuditCategories, AuditDetail, AuditIngest, AuditPage, AuditSummary

router = APIRouter(prefix="/audit-logs", tags=["Activity Log"])

CATEGORIES = (
    "AUTHENTICATION",
    "PERSONNEL",
    "GROUPS",
    "WEAPONS",
    "OPERATIONS",
    "ALERTS",
    "TICKETS",
    "HISTORY",
    "COMMUNICATION",
    "USER_ACCESS",
    "SETTINGS",
    "REPORTS",
    "SYSTEM",
)
ACTIONS = (
    "VIEW",
    "CREATE",
    "UPDATE",
    "DELETE",
    "ASSIGN",
    "REVOKE",
    "ACKNOWLEDGE",
    "RESOLVE",
    "EXPORT",
    "LOGIN",
    "LOGOUT",
    "ACCESS",
)
OUTCOMES = ("SUCCESS", "FAILED", "DENIED")
_TIME_RANGES = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
}
_SECRET_PARTS = ("password", "token", "secret", "jwt", "api_key", "authorization")


def display_label(code: str | None) -> str | None:
    if not code:
        return None
    return " ".join(part.capitalize() for part in code.split("_"))


def clean_metadata(metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    if not metadata:
        return None
    cleaned = {
        key: value
        for key, value in metadata.items()
        if not any(part in key.lower() for part in _SECRET_PARTS)
    }
    return cleaned or None


def session_token(request: Request | None) -> str | None:
    if request is None:
        return None
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        if token:
            return token
    token = (request.headers.get("x-session-id") or "").strip()
    return token or None


def create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    conn.execute(
        """
        INSERT INTO user_sessions (id, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
        """,
        (
            token,
            user_id,
            now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            (now + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        ),
    )
    return token


def actor_from_session(conn: sqlite3.Connection, token: str | None) -> dict | None:
    if not token:
        return None
    row = conn.execute(
        """
        SELECT u.id, u.name
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.deleted_at IS NULL
        """,
        (token, utc_now()),
    ).fetchone()
    if row is None:
        return None
    access = effective_access(conn, row["id"])
    role = None
    if access and access["role"]:
        role = display_name(access["role"])
    return {"id": row["id"], "name": row["name"], "role": role, "type": "USER"}


def actor_for_user(conn: sqlite3.Connection, user) -> dict:
    access = effective_access(conn, user["id"])
    role = display_name(access["role"]) if access and access["role"] else None
    return {"id": user["id"], "name": user["name"], "role": role, "type": "USER"}


def _client_ip(request: Request | None) -> str | None:
    if request is None or request.client is None:
        return None
    return request.client.host


def _next_event_id(conn: sqlite3.Connection, now: str) -> str:
    prefix = f"EVT-{now[:10].replace('-', '')}-"
    row = conn.execute(
        """
        SELECT event_id FROM audit_logs
        WHERE event_id LIKE ?
        ORDER BY event_id DESC
        LIMIT 1
        """,
        (f"{prefix}%",),
    ).fetchone()
    sequence = 1
    if row is not None:
        sequence = int(row["event_id"].rsplit("-", 1)[-1]) + 1
    return f"{prefix}{sequence:06d}"


def insert_audit(
    conn: sqlite3.Connection,
    *,
    category: str,
    event_type: str,
    action: str,
    actor: dict | None = None,
    target: dict | None = None,
    outcome: str = "SUCCESS",
    description: str | None = None,
    request: Request | None = None,
    metadata: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> str:
    if category not in CATEGORIES:
        raise HTTPException(status_code=400, detail="unknown category")
    if action not in ACTIONS:
        raise HTTPException(status_code=400, detail="unknown action")
    if outcome not in OUTCOMES:
        raise HTTPException(status_code=400, detail="unknown outcome")
    now = utc_now()
    token = session_id if session_id is not None else session_token(request)
    if actor is None:
        actor = actor_from_session(conn, token)
    resolved_type = (actor or {}).get("type") or ("USER" if actor else "SYSTEM")
    target = target or {}
    safe_metadata = clean_metadata(metadata)
    event_id = _next_event_id(conn, now)
    for offset in range(5):
        candidate = event_id if offset == 0 else f"{event_id[:-6]}{int(event_id[-6:]) + offset:06d}"
        try:
            conn.execute(
                """
                INSERT INTO audit_logs (
                    event_id, timestamp, actor_id, actor_name, actor_role, actor_type,
                    category, action, event_type, target_id, target_name, target_type,
                    outcome, description, ip_address, user_agent, session_id, metadata_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate,
                    now,
                    None if actor is None else actor.get("id"),
                    None if actor is None else actor.get("name"),
                    None if actor is None else actor.get("role"),
                    resolved_type,
                    category,
                    action,
                    event_type,
                    None if target.get("id") is None else str(target.get("id")),
                    target.get("name"),
                    target.get("type"),
                    outcome,
                    description,
                    _client_ip(request),
                    None if request is None else request.headers.get("user-agent"),
                    token,
                    None if safe_metadata is None else json.dumps(safe_metadata, separators=(",", ":")),
                    now,
                ),
            )
            return candidate
        except sqlite3.IntegrityError:
            continue
    raise HTTPException(status_code=500, detail="could not write audit log")


def record_audit(**kwargs) -> None:
    with get_connection() as conn:
        if kwargs.get("actor") is None:
            kwargs["actor"] = actor_from_session(conn, session_token(kwargs.get("request")))
        insert_audit(conn, **kwargs)


def _normalize_code(value: str | None, allowed: tuple[str, ...], label: str) -> str | None:
    if not value:
        return None
    code = value.strip().upper().replace(" ", "_")
    if code not in allowed:
        raise HTTPException(status_code=400, detail=f"unknown {label}")
    return code


def _filters(
    time_range: str | None,
    from_time: str | None,
    to_time: str | None,
    search: str | None,
    action: str | None,
    category: str | None,
    actor: str | None,
    outcome: str | None,
    resource: str | None,
    ip_address: str | None,
    user_id: int | None,
) -> tuple[str, list]:
    conditions = ["1 = 1"]
    params: list = []
    if time_range:
        if time_range not in _TIME_RANGES:
            raise HTTPException(status_code=400, detail="unknown timeRange")
        start = datetime.now(timezone.utc) - _TIME_RANGES[time_range]
        conditions.append("timestamp >= ?")
        params.append(start.strftime("%Y-%m-%dT%H:%M:%SZ"))
    if from_time:
        conditions.append("timestamp >= ?")
        params.append(_bound(from_time))
    if to_time:
        conditions.append("timestamp <= ?")
        params.append(_bound(to_time))
    action_code = _normalize_code(action, ACTIONS, "action")
    if action_code:
        conditions.append("action = ?")
        params.append(action_code)
    category_code = _normalize_code(category, CATEGORIES, "category")
    if category_code:
        conditions.append("category = ?")
        params.append(category_code)
    outcome_code = _normalize_code(outcome, OUTCOMES, "outcome")
    if outcome_code:
        conditions.append("outcome = ?")
        params.append(outcome_code)
    if actor and actor.strip():
        conditions.append("actor_name LIKE ?")
        params.append(f"%{actor.strip()}%")
    if resource and resource.strip():
        conditions.append("target_type = ?")
        params.append(resource.strip().upper().replace(" ", "_"))
    if ip_address and ip_address.strip():
        conditions.append("ip_address = ?")
        params.append(ip_address.strip())
    if user_id is not None:
        conditions.append("actor_id = ?")
        params.append(user_id)
    if search and search.strip():
        needle = f"%{search.strip()}%"
        conditions.append(
            """(
                event_id LIKE ? OR event_type LIKE ? OR description LIKE ?
                OR IFNULL(actor_name, '') LIKE ? OR IFNULL(target_name, '') LIKE ?
            )"""
        )
        params.extend([needle, needle, needle, needle, needle])
    return " AND ".join(conditions), params


def _bound(value: str) -> str:
    try:
        return canonical_time(value)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _target(row) -> dict | None:
    if row["target_id"] is None and row["target_name"] is None and row["target_type"] is None:
        return None
    return {
        "id": row["target_id"],
        "name": row["target_name"],
        "type": display_label(row["target_type"]),
    }


def _actor(row) -> dict:
    return {"id": row["actor_id"], "name": row["actor_name"], "role": row["actor_role"]}


def _list_item(row) -> dict:
    return {
        "eventId": row["event_id"],
        "timestamp": row["timestamp"],
        "event": display_label(row["event_type"]),
        "category": display_label(row["category"]),
        "actor": _actor(row),
        "target": _target(row),
        "action": display_label(row["action"]),
        "outcome": display_label(row["outcome"]),
        "description": row["description"],
    }


def _detail(row) -> dict:
    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else None
    target = None
    if row["target_id"] is not None or row["target_name"] is not None or row["target_type"] is not None:
        target = {
            "id": row["target_id"],
            "name": row["target_name"],
            "type": row["target_type"],
        }
    return {
        "eventId": row["event_id"],
        "timestamp": row["timestamp"],
        "actor": _actor(row),
        "actorType": row["actor_type"],
        "category": row["category"],
        "eventType": row["event_type"],
        "action": row["action"],
        "target": target,
        "outcome": row["outcome"],
        "description": row["description"],
        "ipAddress": row["ip_address"],
        "userAgent": row["user_agent"],
        "sessionId": row["session_id"],
        "metadata": metadata,
    }


def _query_args(
    time_range: str | None,
    from_time: str | None,
    to_time: str | None,
    search: str | None,
    action: str | None,
    category: str | None,
    actor: str | None,
    outcome: str | None,
    resource: str | None,
    ip_address: str | None,
    user_id: int | None,
):
    return _filters(
        time_range, from_time, to_time, search, action, category, actor, outcome, resource, ip_address, user_id
    )


@router.get("", response_model=AuditPage)
def list_audit_logs(
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    timeRange: str | None = None,
    from_time: str | None = None,
    to_time: str | None = None,
    search: str | None = None,
    action: str | None = None,
    category: str | None = None,
    actor: str | None = None,
    outcome: str | None = None,
    resource: str | None = None,
    ip: str | None = None,
    userId: int | None = None,
):
    where, params = _query_args(
        timeRange, from_time, to_time, search, action, category, actor, outcome, resource, ip, userId
    )
    with get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM audit_logs WHERE {where}", params).fetchone()["n"]
        rows = conn.execute(
            f"""
            SELECT * FROM audit_logs
            WHERE {where}
            ORDER BY timestamp DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, (page - 1) * limit],
        ).fetchall()
        return {"items": [_list_item(row) for row in rows], "total": total, "page": page, "limit": limit}


@router.get("/summary", response_model=AuditSummary)
def audit_summary():
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS total_activities,
                SUM(CASE WHEN actor_type = 'USER' THEN 1 ELSE 0 END) AS user_actions,
                SUM(CASE WHEN actor_type = 'SYSTEM' THEN 1 ELSE 0 END) AS system_actions,
                SUM(CASE WHEN outcome IN ('FAILED', 'DENIED') THEN 1 ELSE 0 END) AS failed_actions
            FROM audit_logs
            """
        ).fetchone()
        return {
            key: row[key] or 0
            for key in ("total_activities", "user_actions", "system_actions", "failed_actions")
        }


@router.get("/categories", response_model=AuditCategories)
def audit_categories():
    with get_connection() as conn:
        counts = {
            row["category"]: row["n"]
            for row in conn.execute(
                "SELECT category, COUNT(*) AS n FROM audit_logs GROUP BY category"
            )
        }
    return {
        "categories": [
            {"code": code, "name": display_label(code), "count": counts.get(code, 0)}
            for code in CATEGORIES
        ]
    }


@router.get("/export")
def export_audit_logs(
    timeRange: str | None = None,
    from_time: str | None = None,
    to_time: str | None = None,
    search: str | None = None,
    action: str | None = None,
    category: str | None = None,
    actor: str | None = None,
    outcome: str | None = None,
    resource: str | None = None,
    ip: str | None = None,
    userId: int | None = None,
):
    where, params = _query_args(
        timeRange, from_time, to_time, search, action, category, actor, outcome, resource, ip, userId
    )
    with get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM audit_logs
            WHERE {where}
            ORDER BY timestamp DESC, id DESC
            """,
            params,
        ).fetchall()
        items = [_list_item(row) for row in rows]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Event ID", "Timestamp", "Actor", "Role", "Category", "Action", "Target", "Outcome"])
    for item in items:
        writer.writerow(
            [
                item["eventId"],
                item["timestamp"],
                item["actor"]["name"] or "",
                item["actor"]["role"] or "",
                item["category"] or "",
                item["action"] or "",
                "" if item["target"] is None else (item["target"]["name"] or ""),
                item["outcome"] or "",
            ]
        )
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="activity-log.csv"'},
    )


@router.get("/me", response_model=AuditPage)
def my_audit_logs(
    request: Request,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    with get_connection() as conn:
        actor = actor_from_session(conn, session_token(request))
        if actor is None:
            raise HTTPException(status_code=401, detail="authentication required")
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id = ?",
            (actor["id"],),
        ).fetchone()["n"]
        rows = conn.execute(
            """
            SELECT * FROM audit_logs
            WHERE actor_id = ?
            ORDER BY timestamp DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            (actor["id"], limit, (page - 1) * limit),
        ).fetchall()
        return {"items": [_list_item(row) for row in rows], "total": total, "page": page, "limit": limit}


@router.post("", status_code=201)
def ingest_audit_log(body: AuditIngest, request: Request):
    with get_connection() as conn:
        actor = actor_from_session(conn, session_token(request))
        if actor is None:
            raise HTTPException(status_code=401, detail="authentication required")
        target = None if body.target is None else body.target.model_dump()
        event_id = insert_audit(
            conn,
            actor=actor,
            category=body.category.strip().upper().replace(" ", "_"),
            event_type=body.event_type.strip().upper().replace(" ", "_"),
            action=body.action.strip().upper().replace(" ", "_"),
            target=target,
            outcome=body.outcome.strip().upper(),
            description=body.description,
            request=request,
            metadata=body.metadata,
            session_id=session_token(request),
        )
        row = conn.execute("SELECT * FROM audit_logs WHERE event_id = ?", (event_id,)).fetchone()
        return _detail(row)


@router.get("/{event_id}", response_model=AuditDetail)
def audit_detail(event_id: str):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM audit_logs WHERE event_id = ?", (event_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="audit log not found")
        return _detail(row)
