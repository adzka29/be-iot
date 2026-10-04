import hashlib
import secrets
import sqlite3
from collections.abc import Iterable
from typing import Annotated

from fastapi import Depends, Header, HTTPException

from .records import utc_now

DOMAINS = (
    "overview",
    "groups",
    "personal",
    "weapons",
    "operations",
    "geofences",
    "explorer",
    "alerts",
    "history",
    "reports",
    "lora_mesh",
    "gateways",
    "user_access",
    "activity_log",
    "settings",
)

OPERATIONAL_DOMAINS = (
    "overview",
    "groups",
    "personal",
    "weapons",
    "operations",
    "geofences",
    "explorer",
    "alerts",
    "history",
    "reports",
)

_SEED_ROLES = (
    {
        "name": "superadmin",
        "duty_category": "Platform Administration",
        "description": "Full platform administration.",
        "privilege_narrative": "Full authority across the TrackForge platform.",
        "least_privilege_baseline": "Reserved for platform administration.",
        "grants": DOMAINS,
    },
    {
        "name": "operations commander",
        "duty_category": "Command Operations",
        "description": "Operational command and oversight.",
        "privilege_narrative": "Provides broad operational visibility and command authority.",
        "least_privilege_baseline": "Only operational authority required for command.",
        "grants": OPERATIONAL_DOMAINS + ("lora_mesh.read", "gateways.read", "activity_log.read"),
    },
    {
        "name": "operations officer",
        "duty_category": "Operations Control",
        "description": "Operational monitoring and coordination.",
        "privilege_narrative": "Handles day-to-day operational workflows.",
        "least_privilege_baseline": "Only operational workflows required by duty.",
        "grants": (
            "overview",
            "groups",
            "personal",
            "operations",
            "geofences",
            "explorer",
            "alerts",
            "history",
            "weapons.read",
            "reports.read",
        ),
    },
    {
        "name": "field operator",
        "duty_category": "Field Operations",
        "description": "Field personnel monitoring.",
        "privilege_narrative": "Monitors personnel, alerts, and operational history.",
        "least_privilege_baseline": "Limit access to field monitoring capabilities.",
        "grants": (
            "overview.read",
            "groups.read",
            "personal.read",
            "operations.read",
            "alerts.read",
            "history.read",
        ),
    },
    {
        "name": "device & fleet admin",
        "duty_category": "Fleet & Communications",
        "description": "Device and communication management.",
        "privilege_narrative": "Manages tracking devices, gateways, and communication infrastructure.",
        "least_privilege_baseline": "Restrict authority to fleet and communication functions.",
        "grants": ("lora_mesh", "gateways", "overview.read"),
    },
    {
        "name": "viewer",
        "duty_category": "Read Only",
        "description": "Read-only operational visibility.",
        "privilege_narrative": "Provides visibility without modification authority.",
        "least_privilege_baseline": "No write capabilities.",
        "grants": tuple(f"{domain}.read" for domain in OPERATIONAL_DOMAINS),
    },
)


def has_permission(granted: set[str], domain: str, action: str) -> bool:
    if domain in granted:
        return True
    if action == "read":
        return f"{domain}.read" in granted
    return False


def display_name(name: str) -> str:
    return " ".join(part if part == "&" else part[:1].upper() + part[1:] for part in name.split(" "))


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000)
    return f"pbkdf2_sha256$120000${salt}${digest.hex()}"


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password or not password_hash:
        return False
    parts = password_hash.split("$")
    if len(parts) != 4:
        return False
    algorithm, rounds, salt, digest = parts
    if algorithm != "pbkdf2_sha256" or not rounds.isdigit():
        return False
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(rounds)).hex()
    return secrets.compare_digest(check, digest)


def expand_permission_codes(codes: Iterable[str]) -> set[str]:
    values = list(codes)
    expanded = set(values)
    for code in values:
        if code in DOMAINS:
            expanded.add(f"{code}.read")
    return expanded


def is_active_binding(row: sqlite3.Row | None, now: str) -> bool:
    if row is None or row["status"] != "ACTIVE":
        return False
    if row["valid_from"] and row["valid_from"] > now:
        return False
    if row["valid_until"] and row["valid_until"] < now:
        return False
    return True


def get_user(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL",
        (user_id,),
    ).fetchone()


def get_role(conn: sqlite3.Connection, role_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL",
        (role_id,),
    ).fetchone()


def load_binding(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM user_role_bindings WHERE user_id = ?",
        (user_id,),
    ).fetchone()


def binding_label(row: sqlite3.Row | None, now: str) -> str:
    return "BOUND" if is_active_binding(row, now) else "NO_BINDING"


def recalculate_user_status(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    user = get_user(conn, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    if user["status"] in {"SUSPENDED", "DISABLED"}:
        return user
    now = utc_now()
    active = user["verification"] == "VERIFIED" and is_active_binding(load_binding(conn, user_id), now)
    status = "ACTIVE" if active else "INACTIVE"
    if status != user["status"]:
        conn.execute(
            "UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, user_id),
        )
        user = get_user(conn, user_id)
    return user


def user_item(row: sqlite3.Row, access_binding: str) -> dict:
    return {
        "id": row["id"],
        "identity_type": row["identity_type"],
        "name": row["name"],
        "username": row["username"],
        "email": row["email"],
        "department": row["department"],
        "verification": row["verification"],
        "status": row["status"],
        "access_binding": access_binding,
    }


def permission_catalog(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, code, name, domain, action_type, description
        FROM permissions
        ORDER BY domain ASC,
                 CASE action_type WHEN 'ALL_ACTIONS' THEN 0 ELSE 1 END ASC,
                 code ASC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def role_permission_items(conn: sqlite3.Connection, role_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT p.id, p.code, p.name, p.domain, p.action_type, p.description
        FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ?
        ORDER BY p.domain ASC,
                 CASE p.action_type WHEN 'ALL_ACTIONS' THEN 0 ELSE 1 END ASC,
                 p.code ASC
        """,
        (role_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def resolve_permission_ids(conn: sqlite3.Connection, permission_ids: list[int]) -> list[int]:
    unique = list(dict.fromkeys(permission_ids))
    if not unique:
        return []
    marks = ", ".join("?" for _ in unique)
    rows = conn.execute(
        f"SELECT id, code FROM permissions WHERE id IN ({marks})",
        unique,
    ).fetchall()
    if len(rows) != len(unique):
        raise ValueError("unknown permission id")
    codes = expand_permission_codes(row["code"] for row in rows)
    code_marks = ", ".join("?" for _ in codes)
    resolved = conn.execute(
        f"SELECT id FROM permissions WHERE code IN ({code_marks}) ORDER BY id ASC",
        tuple(codes),
    ).fetchall()
    if len(resolved) != len(codes):
        raise ValueError("permission catalog is incomplete")
    return [row["id"] for row in resolved]


def replace_role_permissions(conn: sqlite3.Connection, role_id: int, permission_ids: list[int]) -> list[dict]:
    resolved = resolve_permission_ids(conn, permission_ids)
    now = utc_now()
    conn.execute("DELETE FROM role_permissions WHERE role_id = ?", (role_id,))
    for permission_id in resolved:
        conn.execute(
            """
            INSERT INTO role_permissions (role_id, permission_id, created_at)
            VALUES (?, ?, ?)
            """,
            (role_id, permission_id, now),
        )
    conn.execute("UPDATE roles SET updated_at = ? WHERE id = ?", (now, role_id))
    return role_permission_items(conn, role_id)


def assigned_users(conn: sqlite3.Connection, role_id: int, now: str) -> int:
    rows = conn.execute(
        "SELECT * FROM user_role_bindings WHERE role_id = ? AND status = 'ACTIVE'",
        (role_id,),
    ).fetchall()
    return sum(1 for row in rows if is_active_binding(row, now))


def role_item(conn: sqlite3.Connection, row: sqlite3.Row, now: str) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "display_name": display_name(row["name"]),
        "duty_category": row["duty_category"],
        "description": row["description"],
        "privilege_narrative": row["privilege_narrative"],
        "least_privilege_baseline": row["least_privilege_baseline"],
        "is_system": bool(row["is_system"]),
        "is_protected": bool(row["is_protected"]),
        "assigned_users": assigned_users(conn, row["id"], now),
    }


def effective_access(conn: sqlite3.Connection, user_id: int) -> dict | None:
    user = get_user(conn, user_id)
    if user is None:
        return None
    binding = load_binding(conn, user_id)
    now = utc_now()
    active = is_active_binding(binding, now)
    payload = {
        "user_id": user_id,
        "binding_id": None if binding is None else binding["id"],
        "binding_status": None if binding is None else binding["status"],
        "role_id": None,
        "role": None,
        "permissions": [],
    }
    if not active or binding is None:
        return payload
    role = get_role(conn, binding["role_id"])
    if role is None:
        return payload
    payload["role_id"] = role["id"]
    payload["role"] = role["name"]
    payload["permissions"] = [item["code"] for item in role_permission_items(conn, role["id"])]
    return payload


def require_permission(domain: str, action: str = "read"):
    def dependency(x_user_id: Annotated[int | None, Header()] = None) -> None:
        if x_user_id is None:
            raise HTTPException(status_code=401, detail="authentication required")
        from .database import get_connection

        with get_connection() as conn:
            access = effective_access(conn, x_user_id)
        granted = set() if access is None else set(access["permissions"])
        if not has_permission(granted, domain, action):
            raise HTTPException(status_code=403, detail="permission denied")

    return Depends(dependency)


def seed_access(conn: sqlite3.Connection) -> None:
    now = utc_now()
    permission_count = conn.execute("SELECT COUNT(*) AS n FROM permissions").fetchone()["n"]
    if permission_count == 0:
        for domain in DOMAINS:
            label = domain.replace("_", " ").title()
            conn.execute(
                """
                INSERT INTO permissions (code, name, domain, action_type, description, created_at)
                VALUES (?, ?, ?, 'ALL_ACTIONS', ?, ?)
                """,
                (domain, label, domain, f"All actions on {label}.", now),
            )
            conn.execute(
                """
                INSERT INTO permissions (code, name, domain, action_type, description, created_at)
                VALUES (?, ?, ?, 'READ', ?, ?)
                """,
                (f"{domain}.read", f"{label} Read", domain, f"Read {label}.", now),
            )
    role_count = conn.execute("SELECT COUNT(*) AS n FROM roles").fetchone()["n"]
    if role_count:
        return
    for role in _SEED_ROLES:
        cursor = conn.execute(
            """
            INSERT INTO roles (
                name, duty_category, description, privilege_narrative, least_privilege_baseline,
                is_system, is_protected, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
            """,
            (
                role["name"],
                role["duty_category"],
                role["description"],
                role["privilege_narrative"],
                role["least_privilege_baseline"],
                now,
                now,
            ),
        )
        role_id = int(cursor.lastrowid)
        codes = expand_permission_codes(role["grants"])
        marks = ", ".join("?" for _ in codes)
        permissions = conn.execute(
            f"SELECT id FROM permissions WHERE code IN ({marks})",
            tuple(codes),
        ).fetchall()
        if len(permissions) != len(codes):
            raise RuntimeError(f"permission catalog is missing a grant for {role['name']}")
        for permission in permissions:
            conn.execute(
                """
                INSERT INTO role_permissions (role_id, permission_id, created_at)
                VALUES (?, ?, ?)
                """,
                (role_id, permission["id"], now),
            )
