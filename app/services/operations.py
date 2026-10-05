import json

from fastapi import HTTPException, Request

from ..access import effective_access, get_user, has_permission, is_active_binding, load_binding
from ..audit import actor_for_user, actor_from_session, insert_audit, session_token
from ..database import get_connection
from ..db.operations_repository import OperationRepository, position_of
from ..records import canonical_time, utc_now

STATUSES = ("PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED")


class OperationService:
    def list_operations(self, request: Request, **filters) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            repo.sync_groups()
            where, params = self._filters(**filters)
            total = repo.count_operations(where, params)
            offset = (filters["page"] - 1) * filters["limit"]
            rows = repo.list_operations(where, params, filters["limit"], offset)
            return {
                "items": [self._list_item(repo, row) for row in rows],
                "page": filters["page"],
                "limit": filters["limit"],
                "total": total,
            }

    def summary(self, request: Request) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            counts = OperationRepository(conn).status_counts()
            return {
                "total": sum(counts.values()),
                "planning": counts.get("PLANNING", 0),
                "active": counts.get("ACTIVE", 0),
                "on_hold": counts.get("ON_HOLD", 0),
                "completed": counts.get("COMPLETED", 0),
                "cancelled": counts.get("CANCELLED", 0),
            }

    def filter_options(self, request: Request) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            groups = OperationRepository(conn).groups()
            return {
                "statuses": list(STATUSES),
                "groups": [{"id": row["id"], "name": row["name"]} for row in groups],
            }

    def group_options(self, request: Request) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            return {"items": [self._group_choice(repo, row) for row in repo.groups()]}

    def create(self, request: Request, body) -> dict:
        name = self._name(body.name)
        description = self._optional(body.description)
        start_at, end_at = self._window(body.start_at, body.end_at)
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            group_ids = self._groups(repo, body.group_ids)
            geofence_ids = self._geofences(repo, body.geofence_ids)
            now = utc_now()
            operation_id = repo.insert_operation(
                operation_code=repo.next_code(now),
                name=name,
                description=description,
                status="PLANNING",
                start_at=start_at,
                end_at=end_at,
                created_by=user["id"],
                created_at=now,
                updated_at=now,
                completed_at=None,
                deleted_at=None,
            )
            repo.replace_groups(operation_id, group_ids)
            repo.replace_geofences(operation_id, geofence_ids)
            operation = repo.get_operation(operation_id)
            self._audit(conn, user, request, operation, "OPERATION_CREATED", "CREATE", "Created an operation.")
            return self._detail(conn, repo, operation)

    def detail(self, request: Request, operation_id: int) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            return self._detail(conn, repo, self._operation(repo, operation_id))

    def update(self, request: Request, operation_id: int, body) -> dict:
        fields = body.model_dump(exclude_unset=True)
        if not fields:
            raise HTTPException(status_code=422, detail="no operation changes")
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            changes = {}
            start_at = fields.get("start_at", operation["start_at"])
            end_at = fields.get("end_at", operation["end_at"])
            if "start_at" in fields or "end_at" in fields:
                start_at, end_at = self._window(start_at, end_at)
                changes["start_at"] = start_at
                changes["end_at"] = end_at
            if "name" in fields:
                changes["name"] = self._name(fields["name"])
            if "description" in fields:
                changes["description"] = self._optional(fields["description"])
            if "group_ids" in fields:
                repo.replace_groups(operation_id, self._groups(repo, fields["group_ids"]))
            if "geofence_ids" in fields:
                repo.replace_geofences(operation_id, self._geofences(repo, fields["geofence_ids"]))
            if not changes and "group_ids" not in fields and "geofence_ids" not in fields:
                raise HTTPException(status_code=422, detail="no operation changes")
            changes["updated_at"] = utc_now()
            repo.update_operation(operation_id, changes)
            updated = repo.get_operation(operation_id)
            self._audit(conn, user, request, updated, "OPERATION_UPDATED", "UPDATE", "Updated an operation.")
            return self._detail(conn, repo, updated)

    def delete(self, request: Request, operation_id: int) -> None:
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            if operation["status"] != "PLANNING":
                raise HTTPException(status_code=409, detail="only a planning operation can be deleted")
            now = utc_now()
            repo.update_operation(operation_id, {"deleted_at": now, "updated_at": now})
            self._audit(conn, user, request, operation, "OPERATION_DELETED", "DELETE", "Deleted an operation.")

    def activate(self, request: Request, operation_id: int) -> dict:
        return self._transition(request, operation_id, {"PLANNING"}, "ACTIVE", "OPERATION_ACTIVATED", "Activated an operation.")

    def hold(self, request: Request, operation_id: int) -> dict:
        return self._transition(request, operation_id, {"ACTIVE"}, "ON_HOLD", "OPERATION_HELD", "Put an operation on hold.")

    def resume(self, request: Request, operation_id: int) -> dict:
        return self._transition(request, operation_id, {"ON_HOLD"}, "ACTIVE", "OPERATION_RESUMED", "Resumed an operation.")

    def complete(self, request: Request, operation_id: int) -> dict:
        return self._transition(
            request,
            operation_id,
            {"ACTIVE", "ON_HOLD"},
            "COMPLETED",
            "OPERATION_COMPLETED",
            "Completed an operation.",
            stamp="completed_at",
        )

    def cancel(self, request: Request, operation_id: int) -> dict:
        return self._transition(
            request,
            operation_id,
            {"PLANNING", "ACTIVE", "ON_HOLD"},
            "CANCELLED",
            "OPERATION_CANCELLED",
            "Cancelled an operation.",
        )

    def add_group(self, request: Request, operation_id: int, group_id: int) -> dict:
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            if repo.get_group(group_id) is None:
                raise HTTPException(status_code=404, detail="group not found")
            if repo.has_group(operation_id, group_id):
                raise HTTPException(status_code=409, detail="group is already assigned")
            repo.link_group(operation_id, group_id)
            repo.update_operation(operation_id, {"updated_at": utc_now()})
            self._audit(
                conn, user, request, operation, "OPERATION_GROUP_ADDED", "ASSIGN", "Assigned a group to an operation.",
                metadata={"group_id": group_id},
            )
            return self._detail(conn, repo, repo.get_operation(operation_id))

    def remove_group(self, request: Request, operation_id: int, group_id: int) -> dict:
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            if repo.unlink_group(operation_id, group_id) == 0:
                raise HTTPException(status_code=404, detail="group is not assigned")
            repo.update_operation(operation_id, {"updated_at": utc_now()})
            self._audit(
                conn, user, request, operation, "OPERATION_GROUP_REMOVED", "DELETE", "Removed a group from an operation.",
                metadata={"group_id": group_id},
            )
            return self._detail(conn, repo, repo.get_operation(operation_id))

    def add_geofence(self, request: Request, operation_id: int, geofence_id: int) -> dict:
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            if repo.get_geofence(geofence_id) is None:
                raise HTTPException(status_code=404, detail="geofence not found")
            if repo.has_geofence(operation_id, geofence_id):
                raise HTTPException(status_code=409, detail="geofence is already assigned")
            repo.link_geofence(operation_id, geofence_id)
            repo.update_operation(operation_id, {"updated_at": utc_now()})
            self._audit(
                conn, user, request, operation, "OPERATION_GEOFENCE_ADDED", "ASSIGN", "Assigned a geofence to an operation.",
                metadata={"geofence_id": geofence_id},
            )
            return self._detail(conn, repo, repo.get_operation(operation_id))

    def remove_geofence(self, request: Request, operation_id: int, geofence_id: int) -> dict:
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            if repo.unlink_geofence(operation_id, geofence_id) == 0:
                raise HTTPException(status_code=404, detail="geofence is not assigned")
            repo.update_operation(operation_id, {"updated_at": utc_now()})
            self._audit(
                conn,
                user,
                request,
                operation,
                "OPERATION_GEOFENCE_REMOVED",
                "DELETE",
                "Removed a geofence from an operation.",
                metadata={"geofence_id": geofence_id},
            )
            return self._detail(conn, repo, repo.get_operation(operation_id))

    def groups(self, request: Request, operation_id: int) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            self._operation(repo, operation_id)
            return {"items": [self._group_item(repo, row) for row in repo.linked_groups(operation_id)]}

    def personnel(self, request: Request, operation_id: int) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            self._operation(repo, operation_id)
            return {"items": self._personnel(repo, operation_id)}

    def map_view(self, request: Request, operation_id: int) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            groups = repo.linked_groups(operation_id)
            people = self._personnel(repo, operation_id)
            positions = []
            for person in people:
                lat, lon, event_time = position_of(repo.latest_position(person["soldier_id"], person["group_name"]))
                positions.append({**person, "latitude": lat, "longitude": lon, "event_time": event_time})
            return {
                "operation": {"id": operation["id"], "name": operation["name"]},
                "groups": [self._group_ref(repo, row) for row in groups],
                "personnel": people,
                "geofences": [self._map_geofence(row) for row in repo.linked_geofences(operation_id)],
                "positions": positions,
            }

    def alerts(self, request: Request, operation_id: int) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            self._operation(repo, operation_id)
            names, soldier_ids, group_ids = self._scope(repo, operation_id)
            items = []
            for row in repo.alerts_for(names, soldier_ids):
                items.append(
                    {
                        "id": row["id"],
                        "type": row["alert_type"],
                        "severity": row["severity"],
                        "soldier_id": row["soldier_id"],
                        "group_id": group_ids.get(row["group_id"]),
                        "status": row["status"],
                        "event_time": row["event_time"],
                    }
                )
            return {"items": items}

    def tickets(self, request: Request, operation_id: int) -> dict:
        with get_connection() as conn:
            self._reader(conn, request)
            repo = OperationRepository(conn)
            self._operation(repo, operation_id)
            names, soldier_ids, _group_ids = self._scope(repo, operation_id)
            alert_ids = [row["id"] for row in repo.alerts_for(names, soldier_ids)]
            return {
                "items": [
                    {
                        "id": row["id"],
                        "ticket_code": row["ticket_code"],
                        "status": row["status"],
                        "priority": row["priority"],
                        "source_alert_id": row["source_alert_id"],
                        "alert_type": row["alert_type"],
                    }
                    for row in repo.tickets_for_alerts(alert_ids)
                ]
            }

    def _transition(self, request, operation_id, allowed, status, event_type, description, stamp=None) -> dict:
        with get_connection() as conn:
            user = self._writer(conn, request)
            repo = OperationRepository(conn)
            operation = self._operation(repo, operation_id)
            if operation["status"] not in allowed:
                raise HTTPException(status_code=409, detail=f"operation cannot move from {operation['status']} to {status}")
            if status == "ACTIVE":
                self._window(operation["start_at"], operation["end_at"])
            now = utc_now()
            fields = {"status": status, "updated_at": now}
            if stamp:
                fields[stamp] = now
            repo.update_operation(operation_id, fields)
            updated = repo.get_operation(operation_id)
            self._audit(conn, user, request, updated, event_type, "UPDATE", description)
            return self._detail(conn, repo, updated)

    def _filters(self, **filters) -> tuple[str, list]:
        conditions = ["o.deleted_at IS NULL"]
        params: list = []
        status = (filters.get("status") or "").strip().upper()
        if status:
            if status not in STATUSES:
                raise HTTPException(status_code=400, detail="unknown status")
            conditions.append("o.status = ?")
            params.append(status)
        if filters.get("group_id") is not None:
            conditions.append(
                """EXISTS (
                    SELECT 1 FROM operation_groups og
                    WHERE og.operation_id = o.id AND og.group_id = ?
                )"""
            )
            params.append(filters["group_id"])
        if filters.get("start_from"):
            conditions.append("o.start_at >= ?")
            params.append(self._time(filters["start_from"]))
        if filters.get("start_to"):
            conditions.append("o.start_at <= ?")
            params.append(self._time(filters["start_to"]))
        query = (filters.get("q") or "").strip()
        if query:
            needle = f"%{query}%"
            conditions.append("(o.name LIKE ? COLLATE NOCASE OR o.operation_code LIKE ? COLLATE NOCASE)")
            params.extend([needle, needle])
        return " AND ".join(conditions), params

    def _reader(self, conn, request: Request):
        return self._user(conn, request, write=False)

    def _writer(self, conn, request: Request):
        user = self._user(conn, request, write=True)
        if user["identity_type"] != "HUMAN" or user["verification"] != "VERIFIED" or user["status"] != "ACTIVE":
            raise HTTPException(status_code=403, detail="account is not active")
        if not is_active_binding(load_binding(conn, user["id"]), utc_now()):
            raise HTTPException(status_code=403, detail="account is not active")
        return user

    def _user(self, conn, request: Request, *, write: bool):
        actor = actor_from_session(conn, session_token(request))
        if actor is None:
            raise HTTPException(status_code=401, detail="authentication required")
        user = get_user(conn, actor["id"])
        if user is None:
            raise HTTPException(status_code=401, detail="authentication required")
        access = effective_access(conn, user["id"])
        granted = set() if access is None else set(access["permissions"])
        if not has_permission(granted, "operations", "write" if write else "read"):
            raise HTTPException(status_code=403, detail="permission denied")
        return user

    def _operation(self, repo: OperationRepository, operation_id: int):
        operation = repo.get_operation(operation_id)
        if operation is None:
            raise HTTPException(status_code=404, detail="operation not found")
        return operation

    def _groups(self, repo: OperationRepository, group_ids: list[int]) -> list[int]:
        unique = list(dict.fromkeys(group_ids))
        for group_id in unique:
            if repo.get_group(group_id) is None:
                raise HTTPException(status_code=404, detail="group not found")
        return unique

    def _geofences(self, repo: OperationRepository, geofence_ids: list[int]) -> list[int]:
        unique = list(dict.fromkeys(geofence_ids))
        for geofence_id in unique:
            if repo.get_geofence(geofence_id) is None:
                raise HTTPException(status_code=404, detail="geofence not found")
        return unique

    def _name(self, value: str) -> str:
        name = value.strip()
        if not name:
            raise HTTPException(status_code=422, detail="name is required")
        return name

    def _optional(self, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        return text or None

    def _window(self, start_at: str, end_at: str) -> tuple[str, str]:
        start = self._time(start_at)
        end = self._time(end_at)
        if end <= start:
            raise HTTPException(status_code=422, detail="end_at must be after start_at")
        return start, end

    def _time(self, value: str) -> str:
        try:
            return canonical_time(value)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _personnel_count(self, repo: OperationRepository, group_names: list[str]) -> int:
        return len({row["soldier_id"] for row in repo.personnel(group_names)})

    def _list_item(self, repo: OperationRepository, operation) -> dict:
        groups = repo.linked_groups(operation["id"])
        names = [row["name"] for row in groups]
        return {
            "id": operation["id"],
            "operation_code": operation["operation_code"],
            "name": operation["name"],
            "description": operation["description"],
            "status": operation["status"],
            "start_at": operation["start_at"],
            "end_at": operation["end_at"],
            "group_count": len(groups),
            "personnel_count": self._personnel_count(repo, names),
            "geofence_count": len(repo.linked_geofences(operation["id"])),
            "created_at": operation["created_at"],
        }

    def _detail(self, conn, repo: OperationRepository, operation) -> dict:
        groups = repo.linked_groups(operation["id"])
        geofences = repo.linked_geofences(operation["id"])
        names = [row["name"] for row in groups]
        creator = conn.execute("SELECT id, name FROM users WHERE id = ?", (operation["created_by"],)).fetchone()
        return {
            "id": operation["id"],
            "operation_code": operation["operation_code"],
            "name": operation["name"],
            "description": operation["description"],
            "status": operation["status"],
            "start_at": operation["start_at"],
            "end_at": operation["end_at"],
            "groups": [self._group_ref(repo, row) for row in groups],
            "geofences": [{"id": row["id"], "name": row["name"]} for row in geofences],
            "summary": {
                "group_count": len(groups),
                "personnel_count": self._personnel_count(repo, names),
                "geofence_count": len(geofences),
            },
            "created_by": {"id": creator["id"], "name": creator["name"]},
            "created_at": operation["created_at"],
        }

    def _group_ref(self, repo: OperationRepository, row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "personnel_count": self._personnel_count(repo, [row["name"]]),
        }

    def _group_choice(self, repo: OperationRepository, row) -> dict:
        return {**self._group_ref(repo, row), "commander_name": None}

    def _group_item(self, repo: OperationRepository, row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "commander": None,
            "personnel_count": self._personnel_count(repo, [row["name"]]),
            "status": row["status"],
        }

    def _personnel(self, repo: OperationRepository, operation_id: int) -> list[dict]:
        groups = {row["name"]: row for row in repo.linked_groups(operation_id)}
        items = []
        for row in repo.personnel(list(groups)):
            group = groups[row["group_id"]]
            items.append({"soldier_id": row["soldier_id"], "group_id": group["id"], "group_name": group["name"]})
        return items

    def _scope(self, repo: OperationRepository, operation_id: int):
        groups = repo.linked_groups(operation_id)
        names = [row["name"] for row in groups]
        group_ids = {row["name"]: row["id"] for row in groups}
        soldier_ids = sorted({row["soldier_id"] for row in repo.personnel(names)})
        return names, soldier_ids, group_ids

    def _map_geofence(self, row) -> dict:
        return {"id": row["id"], "name": row["name"], "polygon": json.loads(row["polygon_json"])}

    def _audit(self, conn, user, request, operation, event_type, action, description, metadata=None) -> None:
        insert_audit(
            conn,
            actor=actor_for_user(conn, user),
            category="OPERATIONS",
            event_type=event_type,
            action=action,
            target={"id": operation["id"], "name": operation["operation_code"], "type": "OPERATION"},
            description=description,
            request=request,
            metadata=metadata,
        )
