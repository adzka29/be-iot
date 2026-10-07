import request from 'supertest';
import { createTestApp, TestApp } from './app.e2e-setup';
import { encodeFlags } from '../src/mesh/frame';

describe('personnel master enrichment', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('seeds groups and personnel master separately from wire packet', async () => {
    const groups = (await request(harness.app.getHttpServer()).get('/api/groups')).body;
    expect(groups.items.some((g: any) => g.name === 'Alpha')).toBe(true);
    const alpha = groups.items.find((g: any) => g.name === 'Alpha');
    expect(alpha.personnel_count).toBe(8);

    const people = (
      await request(harness.app.getHttpServer())
        .get('/api/personnel')
        .query({ group_id: alpha.id })
    ).body;
    expect(people.total).toBe(8);
    expect(people.items[0].access_group).toBe('Alpha');
  });

  it('ingest enriches group from personnel and auto-registers unknown as UNASSIGNED', async () => {
    const known = await request(harness.app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 101,
        seq: 1,
        timestamp: '2026-10-05T12:00:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags: encodeFlags({}),
      });
    expect(known.status).toBe(200);
    expect(known.body.group_id).toBe('Alpha');

    const unknown = await request(harness.app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 9999,
        seq: 1,
        timestamp: '2026-10-05T12:01:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags: encodeFlags({}),
        group_id: 'Alpha',
      });
    expect(unknown.status).toBe(200);
    expect(unknown.body.group_id).toBeNull();

    const roster = (
      await request(harness.app.getHttpServer())
        .get('/api/personnel')
        .query({ unassigned: '1' })
    ).body;
    expect(roster.items.some((p: any) => p.soldier_id === 9999)).toBe(true);
    expect(
      roster.items.find((p: any) => p.soldier_id === 9999).access_group,
    ).toBe('UNASSIGNED');
  });

  it('assigning personnel to a group enriches subsequent ingest', async () => {
    const created = await request(harness.app.getHttpServer())
      .post('/api/groups')
      .send({ name: 'Bravo', description: 'Second squad' });
    expect(created.status).toBe(201);

    await request(harness.app.getHttpServer())
      .put('/api/personnel/by-soldier/9998/group')
      .send({ group_id: created.body.id });

    const ingested = await request(harness.app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 9998,
        seq: 2,
        timestamp: '2026-10-05T12:02:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 75,
        hrv: 35,
        spo2: 97,
        temp: 36,
        batt: 88,
        flags: encodeFlags({}),
      });
    expect(ingested.status).toBe(200);
    expect(ingested.body.group_id).toBe('Bravo');
  });
});
