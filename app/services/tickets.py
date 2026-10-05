import sqlite3
from dataclasses import dataclass

from fastapi import HTTPException, Request

from ..access import display_name, effective_access, get_user, is_active_binding, load_binding
from ..audit import actor_for_user, actor_from_session, insert_audit, session_token
from ..database import get_connection
from ..db.tickets_repository import TicketRepository
from ..records import canonical_time, utc_now

STATUSES = ("OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED")
PRIORITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW")
_PRIORITY_FROM_SEVERITY = {
    "CRITICAL": "CRITICAL",
    "HIGH": "HIGH",
    "MEDIUM": "MEDIUM",
    "LOW": "LOW",
    "WARNING": "HIGH",
    "INFO": "LOW",
}


@dataclass
class CurrentUser:
    id: int
    name: str
    is_superadmin: bool
    row: sqlite3.Row


def _title(alert_type: str) -> str:
    parts = [part if part == "SOS" else part.capitalize() for part in alert_type.split("_")]
    return f"{' '.join(parts)} Signal Received"


class TicketService:
    def list_tickets(self, request: Request, **filters) -> dict:
        with get_connection() as conn:
            user = self._reader(conn, request)
            where, params = self._filters(user, **filters)
            repo = TicketRepository(conn)
            total = repo.count_tickets(where, params)
            rows = repo.list_tickets(where, params, filters["limit"], filters["offset"])
            return {
                "items": [self._list_item(conn, row) for row in rows],
                "total": total,
                "limit": filters["limit"],
                "offset": filters["offset"],
            }

    def summary(self, request: Request) -> dict:
        with get_connection() as conn:
            user = self._reader(conn, request)
            where, params = self._visibility(user)
            repo = TicketRepository(conn)
            by_status = repo.grouped_counts(where, params, "status")
            by_priority = repo.grouped_counts(where, params, "priority")
            return {
                "total": repo.count_tickets(where, params),
                "by_status": [{"value": value, "count": by_status.get(value, 0)} for value in STATUSES],
                "by_priority": [{"value": value, "count": by_priority.get(value, 0)} for value in PRIORITIES],
            }

    def filter_options(self, request: Request) -> dict:
        with get_connection() as conn:
            user = self._reader(conn, request)
            where, params = self._visibility(user)
            repo = TicketRepository(conn)
            return {
                "statuses": list(STATUSES),
                "priorities": list(PRIORITIES),
                "alert_types": repo.visible_alert_types(where, params),
                "groups": repo.visible_groups(where, params),
            }

    def detail(self, request: Request, ticket_id: int) -> dict:
        with get_connection() as conn:
            user = self._reader(conn, request)
            return self._detail(conn, user, ticket_id)

    def create_from_alert(self, request: Request, alert_id: int) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            repo = TicketRepository(conn)
            alert = repo.get_alert(alert_id)
            if alert is None:
                raise HTTPException(status_code=404, detail="alert not found")
            if alert["status"] in {"RESOLVED", "CLEARED"}:
                raise HTTPException(status_code=409, detail="alert is already closed")
            if repo.ticket_for_alert(alert_id) is not None:
                raise HTTPException(status_code=409, detail="alert already has a ticket")
            now = utc_now()
            priority = _PRIORITY_FROM_SEVERITY.get(alert["severity"], "HIGH")
            try:
                ticket_id = repo.insert_ticket(
                    ticket_code=repo.next_code(now),
                    source_alert_id=alert_id,
                    status="OPEN",
                    priority=priority,
                    created_by=user.id,
                    assignee_id=None,
                    response_plan=None,
                    created_at=now,
                    updated_at=now,
                    started_at=None,
                    resolved_at=None,
                    closed_at=None,
                )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="alert already has a ticket") from exc
            if alert["status"] == "ACTIVE":
                repo.acknowledge_alert(alert_id, user.name, now)
            ticket = repo.get_ticket(ticket_id)
            self._audit(
                conn,
                user,
                request,
                event_type="TICKET_CREATED",
                action="CREATE",
                ticket=ticket,
                description="Created a ticket from an alert.",
                metadata={"alert_id": alert_id, "alert_code": alert["alert_code"]},
            )
            return self._detail(conn, user, ticket_id)

    def update_ticket(self, request: Request, ticket_id: int, body) -> dict:
        fields = body.model_dump(exclude_unset=True)
        if not fields:
            raise HTTPException(status_code=422, detail="no ticket changes")
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            self._require_manager(user, ticket)
            changes = {}
            if "response_plan" in fields:
                plan = (fields["response_plan"] or "").strip()
                changes["response_plan"] = plan or None
            if "priority" in fields and fields["priority"] is not None:
                changes["priority"] = fields["priority"]
            if not changes or all(ticket[column] == value for column, value in changes.items()):
                raise HTTPException(status_code=422, detail="no ticket changes")
            changes["updated_at"] = utc_now()
            TicketRepository(conn).update_ticket(ticket_id, changes)
            updated = TicketRepository(conn).get_ticket(ticket_id)
            self._audit(
                conn,
                user,
                request,
                event_type="TICKET_UPDATED",
                action="UPDATE",
                ticket=updated,
                description="Updated ticket details.",
                metadata={key: changes[key] for key in changes if key != "updated_at"},
            )
            return self._detail(conn, user, ticket_id)

    def assign(self, request: Request, ticket_id: int, user_id: int) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            self._require_manager(user, ticket)
            if ticket["status"] in {"RESOLVED", "CLOSED"}:
                raise HTTPException(status_code=409, detail="closed ticket cannot be assigned")
            assignee = self._assignable_user(conn, user_id)
            if ticket["assignee_id"] == assignee["id"]:
                return self._detail(conn, user, ticket_id)
            now = utc_now()
            TicketRepository(conn).update_ticket(ticket_id, {"assignee_id": assignee["id"], "updated_at": now})
            updated = TicketRepository(conn).get_ticket(ticket_id)
            self._audit(
                conn,
                user,
                request,
                event_type="TICKET_ASSIGNED",
                action="ASSIGN",
                ticket=updated,
                description="Assigned the ticket.",
                metadata={"assignee_id": assignee["id"], "assignee": assignee["username"]},
            )
            return self._detail(conn, user, ticket_id)

    def start_working(self, request: Request, ticket_id: int) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            if ticket["status"] == "WAITING":
                self._require_assignee(user, ticket)
                now = utc_now()
                TicketRepository(conn).update_ticket(ticket_id, {"status": "IN_PROGRESS", "updated_at": now})
            elif ticket["status"] == "OPEN":
                if ticket["assignee_id"] not in {None, user.id}:
                    raise HTTPException(status_code=403, detail="ticket is assigned to someone else")
                now = utc_now()
                TicketRepository(conn).update_ticket(
                    ticket_id,
                    {
                        "assignee_id": user.id,
                        "status": "IN_PROGRESS",
                        "started_at": ticket["started_at"] or now,
                        "updated_at": now,
                    },
                )
            else:
                raise HTTPException(status_code=409, detail="ticket cannot be started")
            updated = TicketRepository(conn).get_ticket(ticket_id)
            self._audit(
                conn,
                user,
                request,
                event_type="TICKET_STARTED",
                action="UPDATE",
                ticket=updated,
                description="Started working on the ticket.",
            )
            return self._detail(conn, user, ticket_id)

    def mark_waiting(self, request: Request, ticket_id: int) -> dict:
        return self._transition(
            request,
            ticket_id,
            allowed={"IN_PROGRESS"},
            status="WAITING",
            event_type="TICKET_WAITING",
            description="Marked the ticket as waiting.",
            rejected="ticket must be in progress",
        )

    def resolve(self, request: Request, ticket_id: int) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            self._require_assignee(user, ticket)
            if ticket["status"] not in {"IN_PROGRESS", "WAITING"}:
                raise HTTPException(status_code=409, detail="ticket must be in progress or waiting")
            now = utc_now()
            repo = TicketRepository(conn)
            repo.update_ticket(ticket_id, {"status": "RESOLVED", "resolved_at": now, "updated_at": now})
            repo.resolve_alert(ticket["source_alert_id"], user.name, now)
            updated = repo.get_ticket(ticket_id)
            self._audit(
                conn,
                user,
                request,
                event_type="TICKET_RESOLVED",
                action="UPDATE",
                ticket=updated,
                description="Resolved the ticket and its source alert.",
            )
            return self._detail(conn, user, ticket_id)

    def close(self, request: Request, ticket_id: int) -> dict:
        return self._transition(
            request,
            ticket_id,
            allowed={"RESOLVED"},
            status="CLOSED",
            event_type="TICKET_CLOSED",
            description="Closed the ticket.",
            rejected="ticket must be resolved before it can be closed",
            stamp="closed_at",
        )

    def add_collaborator(self, request: Request, ticket_id: int, user_id: int) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            self._require_access(user, ticket, TicketRepository(conn).collaborators(ticket_id))
            target = self._assignable_user(conn, user_id)
            if target["id"] == ticket["created_by"]:
                raise HTTPException(status_code=409, detail="creator cannot be a collaborator")
            if target["id"] == ticket["assignee_id"]:
                raise HTTPException(status_code=409, detail="assignee cannot be a collaborator")
            repo = TicketRepository(conn)
            if repo.get_collaborator(ticket_id, target["id"]) is not None:
                raise HTTPException(status_code=409, detail="user is already a collaborator")
            now = utc_now()
            repo.add_collaborator(ticket_id, target["id"], user.id, now)
            repo.update_ticket(ticket_id, {"updated_at": now})
            self._audit(
                conn,
                user,
                request,
                event_type="COLLABORATOR_ADDED",
                action="ASSIGN",
                ticket=repo.get_ticket(ticket_id),
                description="Added a ticket collaborator.",
                metadata={"user_id": target["id"], "username": target["username"]},
            )
            return self._detail(conn, user, ticket_id)

    def remove_collaborator(self, request: Request, ticket_id: int, user_id: int) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            repo = TicketRepository(conn)
            if repo.get_collaborator(ticket_id, user_id) is None:
                raise HTTPException(status_code=404, detail="collaborator not found")
            now = utc_now()
            repo.remove_collaborator(ticket_id, user_id)
            repo.update_ticket(ticket_id, {"updated_at": now})
            self._audit(
                conn,
                user,
                request,
                event_type="COLLABORATOR_REMOVED",
                action="DELETE",
                ticket=repo.get_ticket(ticket_id),
                description="Removed a ticket collaborator.",
                metadata={"user_id": user_id},
            )
            return self._detail(conn, user, ticket_id)

    def add_task(self, request: Request, ticket_id: int, body) -> dict:
        title = body.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="title is required")
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            self._require_manager(user, ticket)
            if body.assignee_id is not None:
                self._require_participant(conn, ticket, body.assignee_id)
            now = utc_now()
            description = None if body.description is None else body.description.strip() or None
            task_id = TicketRepository(conn).insert_task(
                ticket_id=ticket_id,
                title=title,
                description=description,
                assignee_id=body.assignee_id,
                priority=body.priority,
                status="TODO",
                created_by=user.id,
                created_at=now,
                updated_at=now,
                completed_at=None,
            )
            TicketRepository(conn).update_ticket(ticket_id, {"updated_at": now})
            self._audit(
                conn,
                user,
                request,
                event_type="TASK_CREATED",
                action="CREATE",
                ticket=TicketRepository(conn).get_ticket(ticket_id),
                description="Added a ticket task.",
                metadata={"task_id": task_id, "title": title},
            )
            task = TicketRepository(conn).get_task(ticket_id, task_id)
            return self._task(conn, task)

    def update_task(self, request: Request, ticket_id: int, task_id: int, body) -> dict:
        fields = body.model_dump(exclude_unset=True)
        if not fields:
            raise HTTPException(status_code=422, detail="no task changes")
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            repo = TicketRepository(conn)
            task = repo.get_task(ticket_id, task_id)
            if task is None:
                raise HTTPException(status_code=404, detail="task not found")
            manages = self._manages(user, ticket)
            owns_task = task["assignee_id"] == user.id
            if not manages and not owns_task:
                raise HTTPException(status_code=403, detail="not allowed to update this task")
            if not manages and "assignee_id" in fields:
                raise HTTPException(status_code=403, detail="not allowed to reassign this task")
            changes = {}
            if "title" in fields:
                title = (fields["title"] or "").strip()
                if not title:
                    raise HTTPException(status_code=422, detail="title is required")
                changes["title"] = title
            if "description" in fields:
                changes["description"] = None if fields["description"] is None else fields["description"].strip() or None
            if "priority" in fields and fields["priority"] is not None:
                changes["priority"] = fields["priority"]
            if "assignee_id" in fields:
                if fields["assignee_id"] is not None:
                    self._require_participant(conn, ticket, fields["assignee_id"])
                changes["assignee_id"] = fields["assignee_id"]
            if "status" in fields and fields["status"] is not None:
                changes["status"] = fields["status"]
                changes["completed_at"] = utc_now() if fields["status"] == "DONE" else None
            if not changes:
                raise HTTPException(status_code=422, detail="no task changes")
            changes["updated_at"] = utc_now()
            repo.update_task(task_id, changes)
            repo.update_ticket(ticket_id, {"updated_at": changes["updated_at"]})
            self._audit(
                conn,
                user,
                request,
                event_type="TASK_UPDATED",
                action="UPDATE",
                ticket=repo.get_ticket(ticket_id),
                description="Updated a ticket task.",
                metadata={"task_id": task_id, "status": changes.get("status")},
            )
            return self._task(conn, repo.get_task(ticket_id, task_id))

    def add_update(self, request: Request, ticket_id: int, message: str) -> dict:
        text = message.strip()
        if not text:
            raise HTTPException(status_code=422, detail="message is required")
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            now = utc_now()
            repo = TicketRepository(conn)
            update_id = repo.insert_update(ticket_id, user.id, text, now)
            repo.update_ticket(ticket_id, {"updated_at": now})
            self._audit(
                conn,
                user,
                request,
                event_type="TICKET_UPDATE_POSTED",
                action="CREATE",
                ticket=repo.get_ticket(ticket_id),
                description="Posted a ticket update.",
                metadata={"update_id": update_id},
            )
            return {
                "id": update_id,
                "message": text,
                "created_at": now,
                "author": self._person(conn, user.id),
            }

    def _transition(
        self,
        request: Request,
        ticket_id: int,
        *,
        allowed: set[str],
        status: str,
        event_type: str,
        description: str,
        rejected: str,
        stamp: str | None = None,
    ) -> dict:
        with get_connection() as conn:
            user = self._operator(conn, request)
            ticket = self._visible_row(conn, user, ticket_id)
            self._require_assignee(user, ticket)
            if ticket["status"] not in allowed:
                raise HTTPException(status_code=409, detail=rejected)
            now = utc_now()
            fields = {"status": status, "updated_at": now}
            if stamp:
                fields[stamp] = now
            TicketRepository(conn).update_ticket(ticket_id, fields)
            updated = TicketRepository(conn).get_ticket(ticket_id)
            self._audit(
                conn,
                user,
                request,
                event_type=event_type,
                action="UPDATE",
                ticket=updated,
                description=description,
            )
            return self._detail(conn, user, ticket_id)

    def _filters(self, user: CurrentUser, **filters) -> tuple[str, list]:
        where, params = self._visibility(user)
        conditions = [where]
        for name, column in (
            ("status", "t.status"),
            ("priority", "t.priority"),
            ("alert_type", "a.alert_type"),
        ):
            values = self._codes(filters.get(name), STATUSES if name == "status" else PRIORITIES if name == "priority" else None, name)
            if values:
                marks = ", ".join("?" for _ in values)
                conditions.append(f"{column} IN ({marks})")
                params.extend(values)
        groups = [value.strip() for value in filters.get("group_id") or [] if value and value.strip()]
        if groups:
            comparisons = " OR ".join("a.group_id = ? COLLATE NOCASE" for _ in groups)
            conditions.append(f"({comparisons})")
            params.extend(groups)
        if filters.get("from_time"):
            conditions.append("t.created_at >= ?")
            params.append(self._time(filters["from_time"]))
        if filters.get("to_time"):
            conditions.append("t.created_at <= ?")
            params.append(self._time(filters["to_time"]))
        query = (filters.get("q") or "").strip()
        if query:
            needle = f"%{query}%"
            conditions.append(
                """(
                    t.ticket_code LIKE ? COLLATE NOCASE OR
                    a.alert_code LIKE ? COLLATE NOCASE OR
                    a.alert_type LIKE ? COLLATE NOCASE OR
                    a.message LIKE ? COLLATE NOCASE OR
                    IFNULL(a.group_id, '') LIKE ? COLLATE NOCASE OR
                    IFNULL(CAST(a.soldier_id AS TEXT), '') LIKE ?
                )"""
            )
            params.extend([needle] * 6)
        return " AND ".join(conditions), params

    def _codes(self, values: list[str] | None, allowed: tuple[str, ...] | None, label: str) -> list[str]:
        chosen = []
        for value in values or []:
            text = value.strip().upper()
            if not text:
                continue
            if allowed is not None and text not in allowed:
                raise HTTPException(status_code=400, detail=f"unknown {label}")
            chosen.append(text)
        return chosen

    def _time(self, value: str) -> str:
        try:
            return canonical_time(value)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _visibility(self, user: CurrentUser) -> tuple[str, list]:
        if user.is_superadmin:
            return "1 = 1", []
        return (
            """(
                t.created_by = ?
                OR t.assignee_id = ?
                OR EXISTS (
                    SELECT 1 FROM ticket_collaborators c
                    WHERE c.ticket_id = t.id AND c.user_id = ?
                )
            )""",
            [user.id, user.id, user.id],
        )

    def _reader(self, conn: sqlite3.Connection, request: Request) -> CurrentUser:
        actor = actor_from_session(conn, session_token(request))
        if actor is None:
            raise HTTPException(status_code=401, detail="authentication required")
        row = get_user(conn, actor["id"])
        if row is None:
            raise HTTPException(status_code=401, detail="authentication required")
        access = effective_access(conn, row["id"])
        role = None if access is None else access["role"]
        return CurrentUser(id=row["id"], name=row["name"], is_superadmin=role == "superadmin", row=row)

    def _operator(self, conn: sqlite3.Connection, request: Request) -> CurrentUser:
        user = self._reader(conn, request)
        row = user.row
        if row["identity_type"] != "HUMAN":
            raise HTTPException(status_code=403, detail="account is not human")
        if row["verification"] != "VERIFIED":
            raise HTTPException(status_code=403, detail="account is not verified")
        if row["status"] != "ACTIVE":
            raise HTTPException(status_code=403, detail="account is not active")
        if not is_active_binding(load_binding(conn, user.id), utc_now()):
            raise HTTPException(status_code=403, detail="account is not active")
        return user

    def _assignable_user(self, conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
        row = get_user(conn, user_id)
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        if row["identity_type"] != "HUMAN" or row["verification"] != "VERIFIED" or row["status"] != "ACTIVE":
            raise HTTPException(status_code=409, detail="user is not active")
        if not is_active_binding(load_binding(conn, row["id"]), utc_now()):
            raise HTTPException(status_code=409, detail="user is not active")
        return row

    def _visible_row(self, conn: sqlite3.Connection, user: CurrentUser, ticket_id: int) -> sqlite3.Row:
        ticket = TicketRepository(conn).get_ticket(ticket_id)
        if ticket is None:
            raise HTTPException(status_code=404, detail="ticket not found")
        collaborators = TicketRepository(conn).collaborators(ticket_id)
        if not self._can_see(user, ticket, collaborators):
            raise HTTPException(status_code=404, detail="ticket not found")
        return ticket

    def _can_see(self, user: CurrentUser, ticket, collaborators) -> bool:
        if user.is_superadmin:
            return True
        if ticket["created_by"] == user.id or ticket["assignee_id"] == user.id:
            return True
        return any(row["user_id"] == user.id for row in collaborators)

    def _require_assignee(self, user: CurrentUser, ticket) -> None:
        if ticket["assignee_id"] != user.id:
            raise HTTPException(status_code=403, detail="only the assignee can do this")

    def _manages(self, user: CurrentUser, ticket) -> bool:
        return user.is_superadmin or ticket["created_by"] == user.id or ticket["assignee_id"] == user.id

    def _require_manager(self, user: CurrentUser, ticket) -> None:
        if not self._manages(user, ticket):
            raise HTTPException(status_code=403, detail="not allowed to manage this ticket")

    def _require_access(self, user: CurrentUser, ticket, collaborators) -> None:
        if not self._can_see(user, ticket, collaborators):
            raise HTTPException(status_code=404, detail="ticket not found")

    def _require_participant(self, conn: sqlite3.Connection, ticket, user_id: int) -> None:
        collaborators = TicketRepository(conn).collaborators(ticket["id"])
        allowed = {ticket["created_by"], ticket["assignee_id"], *(row["user_id"] for row in collaborators)}
        allowed.discard(None)
        if user_id not in allowed:
            raise HTTPException(status_code=409, detail="assignee is not a ticket participant")

    def _detail(self, conn: sqlite3.Connection, user: CurrentUser, ticket_id: int) -> dict:
        ticket = self._visible_row(conn, user, ticket_id)
        repo = TicketRepository(conn)
        return {
            "id": ticket["id"],
            "ticket_code": ticket["ticket_code"],
            "status": ticket["status"],
            "priority": ticket["priority"],
            "source_alert": self._source_alert(ticket),
            "created_by": self._person(conn, ticket["created_by"]),
            "assignee": self._person(conn, ticket["assignee_id"]),
            "collaborators": [self._person(conn, row["user_id"]) for row in repo.collaborators(ticket["id"])],
            "response_plan": ticket["response_plan"],
            "tasks": [self._task(conn, row) for row in repo.tasks(ticket["id"])],
            "updates": [
                {
                    "id": row["id"],
                    "message": row["message"],
                    "created_at": row["created_at"],
                    "author": self._person(conn, row["author_id"]),
                }
                for row in repo.updates(ticket["id"])
            ],
            "created_at": ticket["created_at"],
            "updated_at": ticket["updated_at"],
            "started_at": ticket["started_at"],
            "resolved_at": ticket["resolved_at"],
            "closed_at": ticket["closed_at"],
        }

    def _list_item(self, conn: sqlite3.Connection, ticket) -> dict:
        return {
            "id": ticket["id"],
            "ticket_code": ticket["ticket_code"],
            "source_alert_id": ticket["source_alert_id"],
            "source_alert_code": ticket["alert_code"],
            "alert_type": ticket["alert_type"],
            "title": _title(ticket["alert_type"]),
            "description": ticket["message"],
            "soldier_id": ticket["soldier_id"],
            "group_id": ticket["group_id"],
            "priority": ticket["priority"],
            "status": ticket["status"],
            "created_at": ticket["created_at"],
            "updated_at": ticket["updated_at"],
            "assignee": self._person(conn, ticket["assignee_id"]),
            "created_by": self._person(conn, ticket["created_by"]),
        }

    def _source_alert(self, ticket) -> dict:
        return {
            "id": ticket["source_alert_id"],
            "alert_code": ticket["alert_code"],
            "type": ticket["alert_type"],
            "severity": ticket["alert_severity"],
            "status": ticket["alert_status"],
            "soldier_id": ticket["soldier_id"],
            "group_id": ticket["group_id"],
            "event_time": ticket["event_time"],
            "position_source": ticket["position_source"],
            "latitude": ticket["latitude"],
            "longitude": ticket["longitude"],
        }

    def _task(self, conn: sqlite3.Connection, task) -> dict:
        return {
            "id": task["id"],
            "title": task["title"],
            "description": task["description"],
            "assignee": self._person(conn, task["assignee_id"]),
            "priority": task["priority"],
            "status": task["status"],
            "created_by": self._person(conn, task["created_by"]),
            "created_at": task["created_at"],
            "updated_at": task["updated_at"],
            "completed_at": task["completed_at"],
        }

    def _person(self, conn: sqlite3.Connection, user_id: int | None) -> dict | None:
        if user_id is None:
            return None
        row = conn.execute(
            "SELECT id, name, username FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            return None
        access = effective_access(conn, row["id"])
        role = display_name(access["role"]) if access and access["role"] else None
        return {
            "id": row["id"],
            "full_name": row["name"],
            "username": row["username"],
            "role": role,
        }

    def _audit(self, conn, user: CurrentUser, request: Request, **kwargs) -> None:
        ticket = kwargs.pop("ticket")
        insert_audit(
            conn,
            actor=actor_for_user(conn, user.row),
            category="TICKETS",
            target={"id": ticket["id"], "name": ticket["ticket_code"], "type": "TICKET"},
            request=request,
            **kwargs,
        )
