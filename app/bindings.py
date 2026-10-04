from fastapi import APIRouter, HTTPException, Request

from .access import (
    binding_label,
    get_role,
    get_user,
    is_active_binding,
    load_binding,
    recalculate_user_status,
)
from .audit import insert_audit, record_audit
from .database import get_connection
from .records import canonical_time, utc_now
from .schemas import BindingItem, BindingPage, BindingStatusUpdate, BindingWrite

router = APIRouter(prefix="/user-roles", tags=["User Access"])


def _time(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    try:
        return canonical_time(value)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _binding_item(conn, binding, user, now: str) -> dict:
    role = get_role(conn, binding["role_id"])
    return {
        "id": binding["id"],
        "user_id": binding["user_id"],
        "role_id": binding["role_id"],
        "role": None if role is None else role["name"],
        "status": binding["status"],
        "valid_from": binding["valid_from"],
        "valid_until": binding["valid_until"],
        "description": binding["description"],
        "access_binding": binding_label(binding, now),
        "user_status": user["status"],
    }


@router.get("", response_model=BindingPage)
def list_bindings(user_id: int | None = None):
    now = utc_now()
    with get_connection() as conn:
        if user_id is None:
            rows = conn.execute("SELECT * FROM user_role_bindings ORDER BY id ASC").fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM user_role_bindings WHERE user_id = ? ORDER BY id ASC",
                (user_id,),
            ).fetchall()
        items = []
        for binding in rows:
            user = get_user(conn, binding["user_id"])
            if user is None:
                continue
            items.append(_binding_item(conn, binding, user, now))
    return {"items": items}


@router.post("", response_model=BindingItem, status_code=201)
def create_binding(body: BindingWrite, request: Request):
    valid_from = _time(body.valid_from)
    valid_until = _time(body.valid_until)
    if valid_from and valid_until and valid_until < valid_from:
        raise HTTPException(status_code=400, detail="valid_until is before valid_from")
    description = body.description.strip() if body.description else None
    now = utc_now()
    try:
        with get_connection() as conn:
            user = get_user(conn, body.user_id)
            if user is None:
                raise HTTPException(status_code=404, detail="user not found")
            role = get_role(conn, body.role_id)
            if role is None:
                raise HTTPException(status_code=404, detail="role not found")
            existing = load_binding(conn, body.user_id)
            if existing is not None and is_active_binding(existing, now):
                raise HTTPException(status_code=409, detail="user already has an active binding")
            previous_role = None
            if existing is not None:
                previous = get_role(conn, existing["role_id"])
                previous_role = None if previous is None else previous["name"]
            if existing is None:
                cursor = conn.execute(
                    """
                    INSERT INTO user_role_bindings (
                        user_id, role_id, status, valid_from, valid_until, description, created_at, updated_at
                    )
                    VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
                    """,
                    (body.user_id, body.role_id, valid_from, valid_until, description or None, now, now),
                )
                binding_id = int(cursor.lastrowid)
            else:
                conn.execute(
                    """
                    UPDATE user_role_bindings
                    SET role_id = ?, status = 'ACTIVE', valid_from = ?, valid_until = ?,
                        description = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (body.role_id, valid_from, valid_until, description or None, now, existing["id"]),
                )
                binding_id = existing["id"]
            user = recalculate_user_status(conn, body.user_id)
            binding = conn.execute(
                "SELECT * FROM user_role_bindings WHERE id = ?",
                (binding_id,),
            ).fetchone()
            insert_audit(
                conn,
                category="USER_ACCESS",
                event_type="ROLE_ASSIGNED",
                action="ASSIGN",
                target={"id": user["id"], "name": user["name"], "type": "USER"},
                description="Assigned role to user.",
                request=request,
                metadata={"previous_role": previous_role, "new_role": role["name"]},
            )
            return _binding_item(conn, binding, user, utc_now())
    except HTTPException as exc:
        if exc.status_code == 409:
            record_audit(
                category="USER_ACCESS",
                event_type="ROLE_ASSIGNED",
                action="ASSIGN",
                outcome="FAILED",
                target={"id": str(body.user_id), "type": "USER"},
                description="Failed to assign role.",
                request=request,
                metadata={"reason": exc.detail, "role_id": body.role_id},
            )
        raise


@router.patch("/{binding_id}/status", response_model=BindingItem)
def update_binding_status(binding_id: int, body: BindingStatusUpdate, request: Request):
    now = utc_now()
    with get_connection() as conn:
        binding = conn.execute(
            "SELECT * FROM user_role_bindings WHERE id = ?",
            (binding_id,),
        ).fetchone()
        if binding is None or get_user(conn, binding["user_id"]) is None:
            raise HTTPException(status_code=404, detail="binding not found")
        conn.execute(
            "UPDATE user_role_bindings SET status = ?, updated_at = ? WHERE id = ?",
            (body.status, now, binding_id),
        )
        user = recalculate_user_status(conn, binding["user_id"])
        binding = conn.execute(
            "SELECT * FROM user_role_bindings WHERE id = ?",
            (binding_id,),
        ).fetchone()
        role = get_role(conn, binding["role_id"])
        event_type = "ROLE_REVOKED" if body.status in {"REVOKED", "SUSPENDED"} else "ROLE_ASSIGNED"
        action = "REVOKE" if event_type == "ROLE_REVOKED" else "ASSIGN"
        insert_audit(
            conn,
            category="USER_ACCESS",
            event_type=event_type,
            action=action,
            target={"id": user["id"], "name": user["name"], "type": "USER"},
            description="Updated role assignment.",
            request=request,
            metadata={"status": body.status, "role": None if role is None else role["name"]},
        )
        return _binding_item(conn, binding, user, utc_now())
