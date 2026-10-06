import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { TicketsService } from './tickets.service';
@Controller()
export class TicketsController {
  constructor(private readonly service: TicketsService) {}

  private asList(value?: string | string[]): string[] | undefined {
    if (value == null) return undefined;
    return Array.isArray(value) ? value : [value];
  }

  @Get('api/tickets')
  list(@Req() request: Request, @Query() q: any) {
    return this.service.listTickets(request, {
      q: q.q,
      status: this.asList(q.status),
      priority: this.asList(q.priority),
      alert_type: this.asList(q.alert_type),
      group_id: this.asList(q.group_id),
      from_time: q.from_time,
      to_time: q.to_time,
      time_range: q.timeRange,
      limit: Math.min(Math.max(Number(q.limit || 50), 1), 100),
      offset: Math.max(Number(q.offset || 0), 0),
    });
  }

  @Post('api/tickets')
  createDisabled() {
    throw new HttpException('Method Not Allowed', 405);
  }

  @Get('api/tickets/summary')
  summary(@Req() request: Request, @Query('timeRange') timeRange?: string) {
    return this.service.summary(request, timeRange);
  }

  @Get('api/tickets/filters/options')
  filters(@Req() request: Request) {
    return this.service.filterOptions(request);
  }

  @Get('api/tickets/:ticketId')
  detail(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Req() request: Request,
  ) {
    return this.service.detail(request, ticketId);
  }

  @Patch('api/tickets/:ticketId')
  update(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.updateTicket(request, ticketId, body);
  }

  @Post('api/tickets/:ticketId/assign')
  @HttpCode(200)
  assign(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.assign(request, ticketId, body.user_id);
  }

  @Post('api/tickets/:ticketId/start-working')
  @HttpCode(200)
  startWorking(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Req() request: Request,
  ) {
    return this.service.startWorking(request, ticketId);
  }

  @Post('api/tickets/:ticketId/waiting')
  @HttpCode(200)
  waiting(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Req() request: Request,
  ) {
    return this.service.markWaiting(request, ticketId);
  }

  @Post('api/tickets/:ticketId/resolve')
  @HttpCode(200)
  resolve(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Req() request: Request,
  ) {
    return this.service.resolve(request, ticketId);
  }

  @Post('api/tickets/:ticketId/close')
  @HttpCode(200)
  close(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Req() request: Request,
  ) {
    return this.service.close(request, ticketId);
  }

  @Post('api/tickets/:ticketId/collaborators')
  @HttpCode(200)
  addCollaborator(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.addCollaborator(request, ticketId, body.user_id);
  }

  @Delete('api/tickets/:ticketId/collaborators/:userId')
  removeCollaborator(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Req() request: Request,
  ) {
    return this.service.removeCollaborator(request, ticketId, userId);
  }

  @Post('api/tickets/:ticketId/tasks')
  @HttpCode(201)
  addTask(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.addTask(request, ticketId, body);
  }

  @Patch('api/tickets/:ticketId/tasks/:taskId')
  updateTask(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.updateTask(request, ticketId, taskId, body);
  }

  @Post('api/tickets/:ticketId/updates')
  @HttpCode(201)
  addUpdate(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() body: any,
    @Req() request: Request,
  ) {
    return this.service.addUpdate(request, ticketId, body);
  }

  @Post('api/alerts/:alertId/ticket')
  @HttpCode(201)
  createFromAlert(
    @Param('alertId', ParseIntPipe) alertId: number,
    @Req() request: Request,
  ) {
    return this.service.createFromAlert(request, alertId);
  }
}
