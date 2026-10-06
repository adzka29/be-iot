import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TestApp } from './app.e2e-setup';

async function login(
  app: INestApplication,
  account = 'superadmin',
  password = 'superadmin',
) {
  const logged = await request(app.getHttpServer())
    .post('/users/login')
    .send({ account, password });
  expect(logged.status).toBe(200);
  return { Authorization: `Bearer ${logged.body.session_id}` };
}

async function member(
  app: INestApplication,
  username: string,
  roleName: string,
): Promise<[number, Record<string, string>]> {
  const created = await request(app.getHttpServer())
    .post('/users/human')
    .send({
      name: username
        .replace(/\./g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      username,
      email: `${username}@trackforge.id`,
      password: 'temporary-password',
      department: 'Command Operations',
    });
  expect(created.status).toBe(201);
  const userId = created.body.id as number;
  const role = (await request(app.getHttpServer()).get('/roles')).body.items.find(
    (item: any) => item.name === roleName,
  );
  const bound = await request(app.getHttpServer())
    .post('/user-roles')
    .send({ user_id: userId, role_id: role.id });
  expect(bound.status).toBe(201);
  return [userId, await login(app, username, 'temporary-password')];
}

async function alert(app: INestApplication) {
  const listed = await request(app.getHttpServer())
    .get('/api/alerts')
    .query({ alert_type: 'SOS', status: 'ACTIVE' });
  expect(listed.status).toBe(200);
  expect(listed.body.items.length).toBeGreaterThan(0);
  return listed.body.items[0];
}

describe('Tickets e2e (ported from test_tickets.py)', () => {
  let harness: TestApp;
  let app: INestApplication;

  beforeEach(async () => {
    harness = await createTestApp();
    app = harness.app;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('ticket_is_created_only_from_an_alert', async () => {
    const headers = await login(app);
    expect(
      (await request(app.getHttpServer()).post('/api/tickets').set(headers)).status,
    ).toBe(405);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/alerts/999999/ticket')
          .set(headers)
      ).status,
    ).toBe(404);
    expect(
      (await request(app.getHttpServer()).get('/api/tickets').set(headers)).body.total,
    ).toBe(0);

    const source = await alert(app);
    const created = await request(app.getHttpServer())
      .post(`/api/alerts/${source.id}/ticket`)
      .set(headers);
    expect(created.status).toBe(201);
    const ticket = created.body;
    expect(ticket.status).toBe('OPEN');
    expect(ticket.priority).toBe('CRITICAL');
    expect(ticket.ticket_code.startsWith('TK-')).toBe(true);
    expect(ticket.assignee).toBeNull();
    expect(ticket.source_alert.id).toBe(source.id);
    expect(ticket.source_alert.alert_code).toBe(source.alert_code);
    expect(ticket.source_alert.status).toBe('ACKNOWLEDGED');
    expect(ticket.created_by.username).toBe('superadmin');
    expect(ticket.created_by.role).toBe('Superadmin');

    const again = await request(app.getHttpServer())
      .post(`/api/alerts/${source.id}/ticket`)
      .set(headers);
    expect(again.status).toBe(409);
    const stored = await request(app.getHttpServer()).get(`/api/alerts/${source.id}`);
    expect(stored.body.status).toBe('ACKNOWLEDGED');

    const listed = await request(app.getHttpServer())
      .get('/api/tickets')
      .set(headers)
      .query({ q: 'SOS', status: 'OPEN', priority: 'CRITICAL' });
    expect(listed.status).toBe(200);
    const item = listed.body.items[0];
    expect(item.title).toBe('SOS Signal Received');
    expect(item.description).toBe('SOS button pressed');
    expect(item.source_alert_code).toBe(source.alert_code);
    expect(listed.body.total).toBe(1);

    const summary = (
      await request(app.getHttpServer()).get('/api/tickets/summary').set(headers)
    ).body;
    expect(summary.total).toBe(1);
    expect(summary.by_status).toContainEqual({ value: 'OPEN', count: 1 });
    expect(summary.by_priority).toContainEqual({ value: 'CRITICAL', count: 1 });
    const options = (
      await request(app.getHttpServer())
        .get('/api/tickets/filters/options')
        .set(headers)
    ).body;
    expect(options.alert_types).toContain('SOS');
    expect(options.statuses).toContain('OPEN');
    expect(options.time_ranges).toEqual(['all', '30d']);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/tickets')
          .set(headers)
          .query({ timeRange: 'all' })
      ).body.total,
    ).toBe(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/tickets')
          .set(headers)
          .query({ timeRange: '30d' })
      ).body.total,
    ).toBe(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/tickets/summary')
          .set(headers)
          .query({ timeRange: '30d' })
      ).body.total,
    ).toBe(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/tickets')
          .set(headers)
          .query({ timeRange: '90d' })
      ).status,
    ).toBe(400);

    const rejected = await request(app.getHttpServer())
      .patch(`/api/tickets/${ticket.id}`)
      .set(headers)
      .send({ status: 'RESOLVED' });
    expect(rejected.status).toBe(422);
    const updated = await request(app.getHttpServer())
      .patch(`/api/tickets/${ticket.id}`)
      .set(headers)
      .send({ response_plan: 'Kirim Alpha response team.', priority: 'HIGH' });
    expect(updated.status).toBe(200);
    expect(updated.body.response_plan).toBe('Kirim Alpha response team.');
    expect(updated.body.priority).toBe('HIGH');
    expect(updated.body.status).toBe('OPEN');

    const activity = await request(app.getHttpServer())
      .get('/audit-logs')
      .set(headers)
      .query({ category: 'TICKETS' });
    expect(activity.body.items.some((row: any) => row.event === 'Ticket Created')).toBe(
      true,
    );
  });

  it('ticket_visibility_follows_the_current_user', async () => {
    const admin = await login(app);
    const [otherId, other] = await member(app, 'rina.field', 'field operator');
    const source = await alert(app);
    const created = await request(app.getHttpServer())
      .post(`/api/alerts/${source.id}/ticket`)
      .set(admin);
    expect(created.status).toBe(201);
    const ticketId = created.body.id;

    expect(
      (await request(app.getHttpServer()).get('/api/tickets').set(other)).body.total,
    ).toBe(0);
    expect(
      (await request(app.getHttpServer()).get('/api/tickets/summary').set(other)).body
        .total,
    ).toBe(0);
    expect(
      (await request(app.getHttpServer()).get(`/api/tickets/${ticketId}`).set(other))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/tickets/filters/options')
          .set(other)
      ).body.alert_types,
    ).toEqual([]);

    const hidden = await request(app.getHttpServer()).post('/api/alerts/1/ticket');
    expect(hidden.status).toBe(401);

    const assigned = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/assign`)
      .set(admin)
      .send({ user_id: otherId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignee.id).toBe(otherId);
    expect(assigned.body.assignee.username).toBe('rina.field');
    expect(assigned.body.assignee.role).toBe('Field Operator');
    expect(
      (await request(app.getHttpServer()).get('/api/tickets').set(other)).body.total,
    ).toBe(1);
    expect(
      (await request(app.getHttpServer()).get(`/api/tickets/${ticketId}`).set(other))
        .status,
    ).toBe(200);

    const outsider = await request(app.getHttpServer())
      .post('/users/human')
      .send({
        name: 'Idle User',
        username: 'idle.user',
        email: 'idle.user@trackforge.id',
        password: 'temporary-password',
      });
    const refused = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/assign`)
      .set(admin)
      .send({ user_id: outsider.body.id });
    expect(refused.status).toBe(409);
  });

  it('ticket_lifecycle_tasks_and_updates', async () => {
    const admin = await login(app);
    const [assigneeId, assignee] = await member(app, 'rina.field', 'field operator');
    const [helperId, helper] = await member(app, 'andi.helper', 'viewer');
    const source = await alert(app);
    const ticketId = (
      await request(app.getHttpServer())
        .post(`/api/alerts/${source.id}/ticket`)
        .set(admin)
    ).body.id;

    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/start-working`)
          .set(assignee)
      ).status,
    ).toBe(404);

    const assigned = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/assign`)
      .set(admin)
      .send({ user_id: assigneeId });
    expect(assigned.status).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/start-working`)
          .set(admin)
      ).status,
    ).toBe(403);
    const owned = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/start-working`)
      .set(assignee);
    expect(owned.status).toBe(200);
    expect(owned.body.status).toBe('IN_PROGRESS');
    expect(owned.body.assignee.username).toBe('rina.field');
    expect(owned.body.started_at).toBeTruthy();

    const waiting = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/waiting`)
      .set(assignee);
    expect(waiting.status).toBe(200);
    expect(waiting.body.status).toBe('WAITING');
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/waiting`)
          .set(admin)
      ).status,
    ).toBe(403);
    const resumed = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/start-working`)
      .set(assignee);
    expect(resumed.body.status).toBe('IN_PROGRESS');

    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/close`)
          .set(assignee)
      ).status,
    ).toBe(409);
    const collaborator = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/collaborators`)
      .set(assignee)
      .send({ user_id: helperId });
    expect(collaborator.status).toBe(200);
    expect(collaborator.body.collaborators[0].username).toBe('andi.helper');
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/resolve`)
          .set(helper)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/collaborators`)
          .set(assignee)
          .send({ user_id: helperId })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/collaborators`)
          .set(assignee)
          .send({ user_id: collaborator.body.created_by.id })
      ).status,
    ).toBe(409);

    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/tasks`)
          .set(assignee)
          .send({
            title: 'Dispatch response team',
            assignee_id: 999999,
            priority: 'HIGH',
          })
      ).status,
    ).toBe(409);
    const task = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/tasks`)
      .set(assignee)
      .send({
        title: 'Dispatch response team',
        description: 'Send one team to the last known position.',
        assignee_id: helperId,
        priority: 'HIGH',
      });
    expect(task.status).toBe(201);
    expect(task.body.status).toBe('TODO');
    expect(task.body.assignee.id).toBe(helperId);
    const done = await request(app.getHttpServer())
      .patch(`/api/tickets/${ticketId}/tasks/${task.body.id}`)
      .set(helper)
      .send({ status: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('DONE');
    expect(done.body.completed_at).toBeTruthy();

    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/tickets/${ticketId}/updates`)
          .set(helper)
          .send({ author_id: assigneeId, message: 'Not me' })
      ).status,
    ).toBe(422);
    const posted = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/updates`)
      .set(helper)
      .send({ message: 'Response team has been dispatched.' });
    expect(posted.status).toBe(201);
    expect(posted.body.author.id).toBe(helperId);

    const resolved = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/resolve`)
      .set(assignee);
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('RESOLVED');
    expect(
      (await request(app.getHttpServer()).get(`/api/alerts/${source.id}`)).body.status,
    ).toBe('RESOLVED');
    const closed = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/close`)
      .set(assignee);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.closed_at).toBeTruthy();

    const removed = await request(app.getHttpServer())
      .delete(`/api/tickets/${ticketId}/collaborators/${helperId}`)
      .set(admin);
    expect(removed.status).toBe(200);
    expect(removed.body.collaborators).toEqual([]);
    expect(
      (await request(app.getHttpServer()).get(`/users/${helperId}/permissions`)).status,
    ).toBe(200);
  });
});
