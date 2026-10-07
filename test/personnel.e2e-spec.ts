import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TestApp } from './app.e2e-setup';
import { encodeFlags } from '../src/mesh/frame';
import { firstRecord, ingestBurst } from './ingest-helpers';

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

describe('personnel master enrichment', () => {
  let harness: TestApp;
  let headers: Record<string, string>;

  beforeEach(async () => {
    harness = await createTestApp();
    headers = await login(harness.app);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('requires session for groups/personnel reads', async () => {
    expect(
      (await request(harness.app.getHttpServer()).get('/api/groups')).status,
    ).toBe(401);
    expect(
      (await request(harness.app.getHttpServer()).get('/api/personnel')).status,
    ).toBe(401);
  });

  it('does not seed groups — settings start empty until operations/admin create them', async () => {
    const groups = (
      await request(harness.app.getHttpServer()).get('/api/groups').set(headers)
    ).body;
    expect(groups.items).toEqual([]);

    const people = (
      await request(harness.app.getHttpServer()).get('/api/personnel').set(headers)
    ).body;
    expect(people.total).toBe(0);
  });

  it('ingest leaves group null until personnel/group is assigned (no invent)', async () => {
    const known = await ingestBurst(harness.app, {
      soldier_id: 101,
      seq: 1,
      timestamp: '2026-10-05T12:00:00Z',
      flags: encodeFlags({}),
    });
    expect(known.status).toBe(200);
    expect(firstRecord(known).group_id).toBeNull();

    const unknown = await ingestBurst(harness.app, {
      soldier_id: 9999,
      seq: 1,
      timestamp: '2026-10-05T12:01:00Z',
      flags: encodeFlags({}),
    });
    expect(unknown.status).toBe(200);
    expect(firstRecord(unknown).group_id).toBeNull();

    const roster = (
      await request(harness.app.getHttpServer())
        .get('/api/personnel')
        .set(headers)
        .query({ unassigned: '1' })
    ).body;
    expect(roster.items.some((p: any) => p.soldier_id === 9999)).toBe(false);
  });

  it('assigning personnel to a group enriches subsequent ingest', async () => {
    const created = await request(harness.app.getHttpServer())
      .post('/api/groups')
      .set(headers)
      .send({ name: 'Bravo', description: 'Second squad' });
    expect(created.status).toBe(201);

    const assigned = await request(harness.app.getHttpServer())
      .put('/api/personnel/by-soldier/9998/group')
      .set(headers)
      .send({ group_id: created.body.id });
    expect(assigned.status).toBe(200);

    const ingested = await ingestBurst(harness.app, {
      soldier_id: 9998,
      seq: 2,
      timestamp: '2026-10-05T12:02:00Z',
      hr: 75,
      hrv: 35,
      spo2: 97,
      batt: 88,
      flags: encodeFlags({}),
    });
    expect(ingested.status).toBe(200);
    expect(firstRecord(ingested).group_id).toBe('Bravo');
  });
});
