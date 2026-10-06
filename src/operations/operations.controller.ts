import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { OperationsService } from './operations.service';

@Controller('api/operations')
export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get()
  list(@Req() request: Request, @Query() q: any) {
    return this.service.listOperations(request, {
      q: q.q,
      status: q.status,
      group_id: q.group_id != null && q.group_id !== '' ? Number(q.group_id) : null,
      start_from: q.start_from,
      start_to: q.start_to,
      page: Math.max(Number(q.page || 1), 1),
      limit: Math.min(Math.max(Number(q.limit || 20), 1), 100),
    });
  }

  @Get('summary')
  summary(@Req() request: Request) {
    return this.service.summary(request);
  }

  @Get('filters/options')
  filters(@Req() request: Request) {
    return this.service.filterOptions(request);
  }

  @Get('groups/options')
  groupOptions(@Req() request: Request) {
    return this.service.groupOptions(request);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: any, @Req() request: Request) {
    return this.service.create(request, body);
  }

  @Get(':operationId')
  detail(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.detail(request, operationId);
  }

  @Patch(':operationId')
  update(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.update(request, operationId, body);
  }

  @Delete(':operationId')
  @HttpCode(204)
  remove(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    this.service.delete(request, operationId);
  }

  @Post(':operationId/activate')
  @HttpCode(200)
  activate(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.activate(request, operationId);
  }

  @Post(':operationId/hold')
  @HttpCode(200)
  hold(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.hold(request, operationId);
  }

  @Post(':operationId/resume')
  @HttpCode(200)
  resume(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.resume(request, operationId);
  }

  @Post(':operationId/complete')
  @HttpCode(200)
  complete(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.complete(request, operationId);
  }

  @Post(':operationId/cancel')
  @HttpCode(200)
  cancel(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.cancel(request, operationId);
  }

  @Get(':operationId/groups')
  groups(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.groups(request, operationId);
  }

  @Post(':operationId/groups')
  @HttpCode(200)
  addGroup(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.addGroup(request, operationId, body.group_id);
  }

  @Delete(':operationId/groups/:groupId')
  removeGroup(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Param('groupId', ParseIntPipe) groupId: number,
    @Req() request: Request,
  ) {
    return this.service.removeGroup(request, operationId, groupId);
  }

  @Post(':operationId/geofences')
  @HttpCode(200)
  addGeofence(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.addGeofence(request, operationId, body.geofence_id);
  }

  @Delete(':operationId/geofences/:geofenceId')
  removeGeofence(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Param('geofenceId', ParseIntPipe) geofenceId: number,
    @Req() request: Request,
  ) {
    return this.service.removeGeofence(request, operationId, geofenceId);
  }

  @Get(':operationId/personnel')
  personnel(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.personnel(request, operationId);
  }

  @Get(':operationId/map')
  map(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.mapView(request, operationId);
  }

  @Get(':operationId/alerts')
  alerts(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.alerts(request, operationId);
  }

  @Get(':operationId/tickets')
  tickets(
    @Param('operationId', ParseIntPipe) operationId: number,
    @Req() request: Request,
  ) {
    return this.service.tickets(request, operationId);
  }
}
