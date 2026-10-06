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

async function reader(app: INestApplication) {
  const created = await request(app.getHttpServer())
    .post('/users/human')
    .send({
      name: 'Field Reader',
      username: 'field.reader',
      email: 'field.reader@trackforge.id',
      password: 'temporary-password',
    });
  expect(created.status).toBe(201);
  const role = (await request(app.getHttpServer()).get('/roles')).body.items.find(
    (item: any) => item.name === 'field operator',
  );
  const bound = await request(app.getHttpServer())
    .post('/user-roles')
    .send({ user_id: created.body.id, role_id: role.id });
  expect(bound.status).toBe(201);
  return login(app, 'field.reader', 'temporary-password');
}

async function geofence(app: INestApplication) {
  const created = await request(app.getHttpServer())
    .post('/api/geofences')
    .send({
      name: 'North Perimeter',
      polygon: [
        [106.8, -6.2],
        [106.81, -6.2],
        [106.805, -6.21],
      ],
    });
  expect(created.status).toBe(201);
  return created.body.id as number;
}

async function alpha(app: INestApplication, headers: Record<string, string>) {
  const options = await request(app.getHttpServer())
    .get('/api/operations/groups/options')
    .set(headers);
  expect(options.status).toBe(200);
  return options.body.items.find((item: any) => item.name === 'Alpha').id as number;
}

describe('Operations e2e (ported from test_operations.py)', () => {
  let harness: TestApp;
  let app: INestApplication;

  beforeEach(async () => {
    harness = await createTestApp();
    app = harness.app;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('operations_follow_existing_groups_and_lifecycle', async () => {
    expect((await request(app.getHttpServer()).get('/api/operations')).status).toBe(
      401,
    );
    const fieldReader = await reader(app);
    expect(
      (await request(app.getHttpServer()).get('/api/operations').set(fieldReader))
        .status,
    ).toBe(200);
    const refused = await request(app.getHttpServer())
      .post('/api/operations')
      .set(fieldReader)
      .send({
        name: 'Nope',
        start_at: '2026-10-05T08:00:00Z',
        end_at: '2026-10-06T08:00:00Z',
      });
    expect(refused.status).toBe(403);

    const admin = await login(app);
    const alphaId = await alpha(app, admin);
    const fence = await geofence(app);
    const choices = (
      await request(app.getHttpServer())
        .get('/api/operations/groups/options')
        .set(admin)
    ).body.items;
    const alphaChoice = choices.find((item: any) => item.id === alphaId);
    expect(alphaChoice.personnel_count).toBe(8);
    expect(alphaChoice.commander_name).toBeNull();

    let created = await request(app.getHttpServer())
      .post('/api/operations')
      .set(admin)
      .send({
        name: '  Operation Alpha  ',
        description: 'Reconnaissance and surveillance operation',
        start_at: '2026-10-05T08:00:00Z',
        end_at: '2026-10-07T18:00:00Z',
        group_ids: [alphaId],
        geofence_ids: [fence],
        status: 'ACTIVE',
      });
    expect(created.status).toBe(422);

    created = await request(app.getHttpServer())
      .post('/api/operations')
      .set(admin)
      .send({
        name: '  Operation Alpha  ',
        description: 'Reconnaissance and surveillance operation',
        start_at: '2026-10-05T08:00:00Z',
        end_at: '2026-10-07T18:00:00Z',
        group_ids: [alphaId],
        geofence_ids: [fence],
      });
    expect(created.status).toBe(201);
    const operation = created.body;
    const operationId = operation.id;
    expect(operation.status).toBe('PLANNING');
    expect(operation.name).toBe('Operation Alpha');
    expect(operation.operation_code.startsWith('OP-2026-')).toBe(true);
    expect(operation.summary).toEqual({
      group_count: 1,
      personnel_count: 8,
      geofence_count: 1,
    });
    expect(operation.groups[0].name).toBe('Alpha');
    expect(operation.created_by.name).toBe('Superadmin');

    const listed = await request(app.getHttpServer())
      .get('/api/operations')
      .set(admin)
      .query({ q: 'alpha', status: 'PLANNING', group_id: alphaId });
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].personnel_count).toBe(8);
    const summary = (
      await request(app.getHttpServer()).get('/api/operations/summary').set(admin)
    ).body;
    expect(summary.planning).toBe(1);
    expect(summary.total).toBe(1);
    const filters = (
      await request(app.getHttpServer())
        .get('/api/operations/filters/options')
        .set(admin)
    ).body;
    expect(filters.statuses).toContain('PLANNING');
    expect(filters.groups.some((item: any) => item.name === 'Alpha')).toBe(true);

    const rejected = await request(app.getHttpServer())
      .patch(`/api/operations/${operationId}`)
      .set(admin)
      .send({ status: 'ACTIVE' });
    expect(rejected.status).toBe(422);
    const renamed = await request(app.getHttpServer())
      .patch(`/api/operations/${operationId}`)
      .set(admin)
      .send({
        name: 'Operation Alpha - Northern Recon',
        end_at: '2026-10-08T18:00:00Z',
      });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Operation Alpha - Northern Recon');
    expect(renamed.body.status).toBe('PLANNING');

    const people = (
      await request(app.getHttpServer())
        .get(`/api/operations/${operationId}/personnel`)
        .set(admin)
    ).body.items;
    expect(new Set(people.map((item: any) => item.soldier_id))).toEqual(
      new Set([101, 102, 103, 104, 105, 106, 107, 108]),
    );
    const mapped = (
      await request(app.getHttpServer())
        .get(`/api/operations/${operationId}/map`)
        .set(admin)
    ).body;
    expect(mapped.operation.name).toBe('Operation Alpha - Northern Recon');
    expect(mapped.positions.length).toBeGreaterThan(0);
    expect(mapped.geofences[0].name).toBe('North Perimeter');
    const alerts = (
      await request(app.getHttpServer())
        .get(`/api/operations/${operationId}/alerts`)
        .set(admin)
    ).body.items;
    expect(
      alerts.some(
        (item: any) =>
          item.type === 'SOS' && item.soldier_id >= 101 && item.soldier_id <= 108,
      ),
    ).toBe(true);

    const alertId = alerts.find((item: any) => item.type === 'SOS').id;
    const ticket = await request(app.getHttpServer())
      .post(`/api/alerts/${alertId}/ticket`)
      .set(admin);
    expect(ticket.status).toBe(201);
    const tickets = (
      await request(app.getHttpServer())
        .get(`/api/operations/${operationId}/tickets`)
        .set(admin)
    ).body.items;
    expect(tickets[0].id).toBe(ticket.body.id);
    expect(tickets[0].source_alert_id).toBe(alertId);

    const active = await request(app.getHttpServer())
      .post(`/api/operations/${operationId}/activate`)
      .set(admin);
    expect(active.status).toBe(200);
    expect(active.body.status).toBe('ACTIVE');
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/operations/${operationId}/activate`)
          .set(admin)
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app.getHttpServer())
          .delete(`/api/operations/${operationId}`)
          .set(admin)
      ).status,
    ).toBe(409);
    const held = await request(app.getHttpServer())
      .post(`/api/operations/${operationId}/hold`)
      .set(admin);
    expect(held.body.status).toBe('ON_HOLD');
    const resumed = await request(app.getHttpServer())
      .post(`/api/operations/${operationId}/resume`)
      .set(admin);
    expect(resumed.body.status).toBe('ACTIVE');
    const done = await request(app.getHttpServer())
      .post(`/api/operations/${operationId}/complete`)
      .set(admin);
    expect(done.body.status).toBe('COMPLETED');
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/operations/${operationId}/cancel`)
          .set(admin)
      ).status,
    ).toBe(409);

    const other = await request(app.getHttpServer())
      .post('/api/operations')
      .set(admin)
      .send({
        name: 'Operation Bravo',
        start_at: '2026-10-06T08:00:00Z',
        end_at: '2026-10-09T18:00:00Z',
      });
    expect(other.status).toBe(201);
    const otherId = other.body.id;
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/operations/${otherId}/groups`)
          .set(admin)
          .send({ group_id: 999999 })
      ).status,
    ).toBe(404);
    const added = await request(app.getHttpServer())
      .post(`/api/operations/${otherId}/groups`)
      .set(admin)
      .send({ group_id: alphaId });
    expect(added.status).toBe(200);
    expect(added.body.groups[0].id).toBe(alphaId);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/operations/${otherId}/groups`)
          .set(admin)
          .send({ group_id: alphaId })
      ).status,
    ).toBe(409);
    const removed = await request(app.getHttpServer())
      .delete(`/api/operations/${otherId}/groups/${alphaId}`)
      .set(admin);
    expect(removed.status).toBe(200);
    expect(removed.body.groups).toEqual([]);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/operations/groups/options')
          .set(admin)
      ).body.items.length,
    ).toBeGreaterThan(0);

    const attached = await request(app.getHttpServer())
      .post(`/api/operations/${otherId}/geofences`)
      .set(admin)
      .send({ geofence_id: fence });
    expect(attached.status).toBe(200);
    const detached = await request(app.getHttpServer())
      .delete(`/api/operations/${otherId}/geofences/${fence}`)
      .set(admin);
    expect(detached.body.geofences).toEqual([]);

    const deleted = await request(app.getHttpServer())
      .delete(`/api/operations/${otherId}`)
      .set(admin);
    expect(deleted.status).toBe(204);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/operations/${otherId}`)
          .set(admin)
      ).status,
    ).toBe(404);
    expect(
      (await request(app.getHttpServer()).get('/api/geofences')).body.items.length,
    ).toBeGreaterThan(0);
  });
});
