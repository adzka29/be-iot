from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..schemas import (
    TicketAssignIn,
    TicketCollaboratorIn,
    TicketDetail,
    TicketFilterOptions,
    TicketMessageIn,
    TicketPage,
    TicketPatch,
    TicketSummary,
    TicketTaskIn,
    TicketTaskOut,
    TicketTaskPatch,
    TicketUpdateOut,
)
from ..services.tickets import TicketService

router = APIRouter(prefix="/api/tickets", tags=["Tickets"])
alert_ticket_router = APIRouter(prefix="/api/alerts", tags=["Tickets"])
service = TicketService()


@router.get("", response_model=TicketPage)
def list_tickets(
    request: Request,
    q: str | None = None,
    status: Annotated[list[str] | None, Query()] = None,
    priority: Annotated[list[str] | None, Query()] = None,
    alert_type: Annotated[list[str] | None, Query()] = None,
    group_id: Annotated[list[str] | None, Query()] = None,
    from_time: str | None = None,
    to_time: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return service.list_tickets(
        request,
        q=q,
        status=status,
        priority=priority,
        alert_type=alert_type,
        group_id=group_id,
        from_time=from_time,
        to_time=to_time,
        limit=limit,
        offset=offset,
    )


@router.get("/summary", response_model=TicketSummary)
def ticket_summary(request: Request):
    return service.summary(request)


@router.get("/filters/options", response_model=TicketFilterOptions)
def ticket_filters(request: Request):
    return service.filter_options(request)


@router.get("/{ticket_id}", response_model=TicketDetail)
def ticket_detail(ticket_id: int, request: Request):
    return service.detail(request, ticket_id)


@router.patch("/{ticket_id}", response_model=TicketDetail)
def update_ticket(ticket_id: int, body: TicketPatch, request: Request):
    return service.update_ticket(request, ticket_id, body)


@router.post("/{ticket_id}/assign", response_model=TicketDetail)
def assign_ticket(ticket_id: int, body: TicketAssignIn, request: Request):
    return service.assign(request, ticket_id, body.user_id)


@router.post("/{ticket_id}/start-working", response_model=TicketDetail)
def start_working(ticket_id: int, request: Request):
    return service.start_working(request, ticket_id)


@router.post("/{ticket_id}/waiting", response_model=TicketDetail)
def mark_waiting(ticket_id: int, request: Request):
    return service.mark_waiting(request, ticket_id)


@router.post("/{ticket_id}/resolve", response_model=TicketDetail)
def resolve_ticket(ticket_id: int, request: Request):
    return service.resolve(request, ticket_id)


@router.post("/{ticket_id}/close", response_model=TicketDetail)
def close_ticket(ticket_id: int, request: Request):
    return service.close(request, ticket_id)


@router.post("/{ticket_id}/collaborators", response_model=TicketDetail)
def add_collaborator(ticket_id: int, body: TicketCollaboratorIn, request: Request):
    return service.add_collaborator(request, ticket_id, body.user_id)


@router.delete("/{ticket_id}/collaborators/{user_id}", response_model=TicketDetail)
def remove_collaborator(ticket_id: int, user_id: int, request: Request):
    return service.remove_collaborator(request, ticket_id, user_id)


@router.post("/{ticket_id}/tasks", response_model=TicketTaskOut, status_code=201)
def add_task(ticket_id: int, body: TicketTaskIn, request: Request):
    return service.add_task(request, ticket_id, body)


@router.patch("/{ticket_id}/tasks/{task_id}", response_model=TicketTaskOut)
def update_task(ticket_id: int, task_id: int, body: TicketTaskPatch, request: Request):
    return service.update_task(request, ticket_id, task_id, body)


@router.post("/{ticket_id}/updates", response_model=TicketUpdateOut, status_code=201)
def add_update(ticket_id: int, body: TicketMessageIn, request: Request):
    return service.add_update(request, ticket_id, body.message)


@alert_ticket_router.post("/{alert_id}/ticket", response_model=TicketDetail, status_code=201)
def create_ticket(alert_id: int, request: Request):
    return service.create_from_alert(request, alert_id)
