import sqlite3

from fastapi import APIRouter, HTTPException

from .access import get_role, permission_catalog, replace_role_permissions, role_item, role_permission_items
from .database import get_connection
from .records import utc_now
from .schemas import (
    PermissionCatalog,
    RoleDetail,
    RolePage,
    RolePermissionSet,
    RolePermissionUpdate,
    RoleSummary,
    RoleWrite,
)

router = APIRouter(prefix="/roles", tags=["User Access"])
catalog_router = APIRouter(prefix="/permissions", tags=["User Access"])


def _clean_role(body: RoleWrite) -> dict:
    name = body.name.strip().lower()
    duty = body.duty_category.strip()
    description = body.description.strip()
    if not name or not duty or not description:
        raise HTTPException(status_code=422, detail="name, duty_category, and description are required")
    narrative = body.privilege_narrative.strip() if body.privilege_narrative else None
    baseline = body.least_privilege_baseline.strip() if body.least_privilege_baseline else None
    return {
        "name": name,
        "duty_category": duty,
        "description": description,
        "privilege_narrative": narrative or None,
        "least_privilege_baseline": baseline or None,
    }


def _catalog() -> dict:
    with get_connection() as conn:
        return {"items": permission_catalog(conn)}


@catalog_router.get("", response_model=PermissionCatalog)
def list_permissions():
    return _catalog()


@router.get("/permissions", response_model=PermissionCatalog)
def list_role_permission_catalog():
    return _catalog()


@router.get("", response_model=RolePage)
def list_roles():
    now = utc_now()
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM roles WHERE deleted_at IS NULL ORDER BY id ASC"
        ).fetchall()
        return {"items": [role_item(conn, row, now) for row in rows]}


@router.get("/summary", response_model=RoleSummary)
def role_summary():
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN is_system = 1 THEN 1 ELSE 0 END) AS system_roles,
                SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END) AS protected_roles,
                SUM(CASE WHEN is_system = 0 THEN 1 ELSE 0 END) AS custom_roles
            FROM roles
            WHERE deleted_at IS NULL
            """
        ).fetchone()
        return {key: row[key] or 0 for key in ("total", "system_roles", "protected_roles", "custom_roles")}


@router.post("", response_model=RoleDetail, status_code=201)
def create_role(body: RoleWrite):
    fields = _clean_role(body)
    now = utc_now()
    with get_connection() as conn:
        try:
            cursor = conn.execute(
                """
                INSERT INTO roles (
                    name, duty_category, description, privilege_narrative, least_privilege_baseline,
                    is_system, is_protected, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
                """,
                (
                    fields["name"],
                    fields["duty_category"],
                    fields["description"],
                    fields["privilege_narrative"],
                    fields["least_privilege_baseline"],
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="role already exists") from exc
        role = get_role(conn, int(cursor.lastrowid))
        item = role_item(conn, role, now)
        item["permissions"] = []
    return item


@router.get("/{role_id}/detail", response_model=RoleDetail)
def role_detail(role_id: int):
    now = utc_now()
    with get_connection() as conn:
        role = get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="role not found")
        item = role_item(conn, role, now)
        item["permissions"] = [{"code": permission["code"]} for permission in role_permission_items(conn, role_id)]
    return item


@router.put("/{role_id}", response_model=RoleDetail)
def update_role(role_id: int, body: RoleWrite):
    fields = _clean_role(body)
    now = utc_now()
    with get_connection() as conn:
        role = get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="role not found")
        if role["is_protected"]:
            raise HTTPException(status_code=403, detail="protected role cannot be modified")
        try:
            conn.execute(
                """
                UPDATE roles
                SET name = ?, duty_category = ?, description = ?, privilege_narrative = ?,
                    least_privilege_baseline = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    fields["name"],
                    fields["duty_category"],
                    fields["description"],
                    fields["privilege_narrative"],
                    fields["least_privilege_baseline"],
                    now,
                    role_id,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="role already exists") from exc
        role = get_role(conn, role_id)
        item = role_item(conn, role, now)
        item["permissions"] = [{"code": permission["code"]} for permission in role_permission_items(conn, role_id)]
    return item


@router.delete("/{role_id}", status_code=204)
def delete_role(role_id: int):
    now = utc_now()
    with get_connection() as conn:
        role = get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="role not found")
        if role["is_protected"]:
            raise HTTPException(status_code=403, detail="protected role cannot be deleted")
        active = conn.execute(
            """
            SELECT 1 FROM user_role_bindings
            WHERE role_id = ? AND status = 'ACTIVE'
            """,
            (role_id,),
        ).fetchone()
        if active is not None:
            raise HTTPException(status_code=409, detail="role still has an active binding")
        conn.execute(
            "UPDATE roles SET deleted_at = ?, updated_at = ? WHERE id = ?",
            (now, now, role_id),
        )


@router.get("/{role_id}/permissions", response_model=RolePermissionSet)
def get_role_permissions(role_id: int):
    with get_connection() as conn:
        if get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="role not found")
        return {"role_id": role_id, "permissions": role_permission_items(conn, role_id)}


@router.patch("/{role_id}/permissions", response_model=RolePermissionSet)
def update_role_permissions(role_id: int, body: RolePermissionUpdate):
    with get_connection() as conn:
        if get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="role not found")
        try:
            permissions = replace_role_permissions(conn, role_id, body.permissionIds)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"role_id": role_id, "permissions": permissions}
