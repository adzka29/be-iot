from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..schemas import (
    OperationAlertList,
    OperationDetail,
    OperationFilterOptions,
    OperationGeofenceIn,
    OperationGroupChoices,
    OperationGroupIn,
    OperationGroupList,
    OperationMap,
    OperationPage,
    OperationPatch,
    OperationPersonnelList,
    OperationSummary,
    OperationTicketList,
    OperationWrite,
)
from ..services.operations import OperationService

router = APIRouter(prefix="/api/operations", tags=["Operations"])
service = OperationService()


@router.get("", response_model=OperationPage)
def list_operations(
    request: Request,
    q: str | None = None,
    status: str | None = None,
    group_id: int | None = None,
    start_from: str | None = None,
    start_to: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    return service.list_operations(
        request,
        q=q,
        status=status,
        group_id=group_id,
        start_from=start_from,
        start_to=start_to,
        page=page,
        limit=limit,
    )


@router.get("/summary", response_model=OperationSummary)
def operation_summary(request: Request):
    return service.summary(request)


@router.get("/filters/options", response_model=OperationFilterOptions)
def operation_filters(request: Request):
    return service.filter_options(request)


@router.get("/groups/options", response_model=OperationGroupChoices)
def operation_group_options(request: Request):
    return service.group_options(request)


@router.post("", response_model=OperationDetail, status_code=201)
def create_operation(body: OperationWrite, request: Request):
    return service.create(request, body)


@router.get("/{operation_id}", response_model=OperationDetail)
def operation_detail(operation_id: int, request: Request):
    return service.detail(request, operation_id)


@router.patch("/{operation_id}", response_model=OperationDetail)
def update_operation(operation_id: int, body: OperationPatch, request: Request):
    return service.update(request, operation_id, body)


@router.delete("/{operation_id}", status_code=204)
def delete_operation(operation_id: int, request: Request):
    service.delete(request, operation_id)


@router.post("/{operation_id}/activate", response_model=OperationDetail)
def activate_operation(operation_id: int, request: Request):
    return service.activate(request, operation_id)


@router.post("/{operation_id}/hold", response_model=OperationDetail)
def hold_operation(operation_id: int, request: Request):
    return service.hold(request, operation_id)


@router.post("/{operation_id}/resume", response_model=OperationDetail)
def resume_operation(operation_id: int, request: Request):
    return service.resume(request, operation_id)


@router.post("/{operation_id}/complete", response_model=OperationDetail)
def complete_operation(operation_id: int, request: Request):
    return service.complete(request, operation_id)


@router.post("/{operation_id}/cancel", response_model=OperationDetail)
def cancel_operation(operation_id: int, request: Request):
    return service.cancel(request, operation_id)


@router.get("/{operation_id}/groups", response_model=OperationGroupList)
def operation_groups(operation_id: int, request: Request):
    return service.groups(request, operation_id)


@router.post("/{operation_id}/groups", response_model=OperationDetail)
def add_operation_group(operation_id: int, body: OperationGroupIn, request: Request):
    return service.add_group(request, operation_id, body.group_id)


@router.delete("/{operation_id}/groups/{group_id}", response_model=OperationDetail)
def remove_operation_group(operation_id: int, group_id: int, request: Request):
    return service.remove_group(request, operation_id, group_id)


@router.post("/{operation_id}/geofences", response_model=OperationDetail)
def add_operation_geofence(operation_id: int, body: OperationGeofenceIn, request: Request):
    return service.add_geofence(request, operation_id, body.geofence_id)


@router.delete("/{operation_id}/geofences/{geofence_id}", response_model=OperationDetail)
def remove_operation_geofence(operation_id: int, geofence_id: int, request: Request):
    return service.remove_geofence(request, operation_id, geofence_id)


@router.get("/{operation_id}/personnel", response_model=OperationPersonnelList)
def operation_personnel(operation_id: int, request: Request):
    return service.personnel(request, operation_id)


@router.get("/{operation_id}/map", response_model=OperationMap)
def operation_map(operation_id: int, request: Request):
    return service.map_view(request, operation_id)


@router.get("/{operation_id}/alerts", response_model=OperationAlertList)
def operation_alerts(operation_id: int, request: Request):
    return service.alerts(request, operation_id)


@router.get("/{operation_id}/tickets", response_model=OperationTicketList)
def operation_tickets(operation_id: int, request: Request):
    return service.tickets(request, operation_id)
