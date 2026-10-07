import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TestApp } from './app.e2e-setup';
import {
  encodeFlags,
  packPayload,
  packSatelliteBurst,
  decodePayload,
  BURST_HEADER_LEN,
  PAYLOAD_LEN,
} from '../src/mesh/frame';

async function login(app: INestApplication) {
  const logged = await request(app.getHttpServer())
    .post('/users/login')
    .send({ account: 'superadmin', password: 'superadmin' });
  expect(logged.status).toBe(200);
  return { Authorization: `Bearer ${logged.body.session_id}` };
}

describe('satellite burst ingest', () => {
  let harness: TestApp;
  let headers: Record<string, string>;

  beforeEach(async () => {
    harness = await createTestApp();
    headers = await login(harness.app);
  });

  afterEach(async () => {
    await harness.close();
  });

  // Keep event times near seed window so NO_CONTACT engine does not fire immediately.
  const TS = Math.floor(Date.parse('2026-10-07T10:00:00Z') / 1000);

  function soldierPayload(opts: {
    soldier_id: number;
    seq?: number;
    timestamp?: number;
    flags?: number;
  }) {
    return packPayload({
      soldier_id: opts.soldier_id,
      seq: opts.seq ?? 1,
      timestamp: opts.timestamp ?? TS,
      lat: -6.2,
      lon: 106.8,
      hr: 80,
      hrv: 40,
      spo2: 98,
      temp: 36,
      batt: 90,
      flags: opts.flags ?? encodeFlags({}),
    });
  }

  it('A: one soldier payload is exactly 21 bytes and decodes', () => {
    const raw = soldierPayload({ soldier_id: 101, seq: 3 });
    expect(raw.length).toBe(PAYLOAD_LEN);
    const decoded = decodePayload(raw);
    expect(decoded.soldier_id).toBe(101);
    expect(decoded.seq).toBe(3);
    expect(decoded.lat).toBeCloseTo(-6.2, 5);
    expect(decoded.lon).toBeCloseTo(106.8, 5);
  });

  it('B: multi-soldier burst creates one TELEMETRY record per soldier', async () => {
    const header = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    expect(header.length).toBe(BURST_HEADER_LEN);
    const payloads = [
      soldierPayload({ soldier_id: 101, seq: 1 }),
      soldierPayload({ soldier_id: 102, seq: 2 }),
      soldierPayload({ soldier_id: 103, seq: 3 }),
    ];
    const burst = packSatelliteBurst(payloads, header);

    const response = await request(harness.app.getHttpServer())
      .post('/api/ingest')
      .send({
        burst_hex: burst.toString('hex'),
        gateway_id: 'GW-SAT-1',
        burst_id: 'burst-e2e-multi',
        received_at: '2026-10-07T10:00:00Z',
      });

    expect(response.status).toBe(200);
    expect(response.body.soldier_count).toBe(3);
    expect(response.body.records).toHaveLength(3);
    expect(response.body.burst.category).toBe('UPLINK');
    expect(response.body.burst.data_type).toBe('SATELLITE_BURST');
    expect(response.body.burst.soldier_id).toBeNull();
    expect(response.body.burst.raw_format).toBe('SATELLITE_BURST');

    for (const record of response.body.records) {
      expect(record.category).toBe('TELEMETRY');
      expect(record.data_type).toBe('SOLDIER_TELEMETRY');
      expect(record.transport).toBe('SATELLITE');
      expect(record.raw_format).toBe('PAYLOAD_21');
      expect(record.raw_bytes_length).toBe(21);
      expect(record.data.burst_id).toBe('burst-e2e-multi');
      expect(record.data.burst_record_id).toBe(response.body.burst.id);
    }
    expect(response.body.records.map((r: any) => r.soldier_id).sort()).toEqual([
      101, 102, 103,
    ]);

    const listed = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ gateway_id: 'GW-SAT-1', transport: 'SATELLITE' })
    ).body;
    expect(listed.total).toBe(3);
    expect(listed.items.every((item: any) => item.category === 'TELEMETRY')).toBe(
      true,
    );
  });

  it('C: original raw burst bytes are preserved', async () => {
    const payloads = [
      soldierPayload({ soldier_id: 104 }),
      soldierPayload({ soldier_id: 105 }),
    ];
    const burst = packSatelliteBurst(payloads);
    const burstHex = burst.toString('hex');

    const response = await request(harness.app.getHttpServer())
      .post('/api/ingest')
      .send({ burst_hex: burstHex, gateway_id: 'GW-RAW' });

    expect(response.status).toBe(200);
    expect(response.body.burst.raw_hex).toBe(burstHex);
    expect(response.body.burst.raw_bytes_length).toBe(burst.length);

    // Per-soldier raw_hex is the original slice, not a re-packed substitute.
    expect(response.body.records[0].raw_hex).toBe(payloads[0].toString('hex'));
    expect(response.body.records[1].raw_hex).toBe(payloads[1].toString('hex'));
  });

  it('D: soldier_id resolves to personnel/group when master exists', async () => {
    const group = await request(harness.app.getHttpServer())
      .post('/api/groups')
      .set(headers)
      .send({ name: 'Alpha', description: 'Created for enrichment test' });
    expect(group.status).toBe(201);
    await request(harness.app.getHttpServer())
      .put('/api/personnel/by-soldier/101/group')
      .set(headers)
      .send({ group_id: group.body.id });

    const burst = packSatelliteBurst([soldierPayload({ soldier_id: 101 })]);
    const response = await request(harness.app.getHttpServer())
      .post('/api/ingest')
      .send({ burst_hex: burst.toString('hex'), gateway_id: 'GW-ENRICH' });

    expect(response.status).toBe(200);
    expect(response.body.records[0].group_id).toBe('Alpha');

    const listed = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ soldier_id: 101, transport: 'SATELLITE', limit: 1 })
    ).body;
    expect(listed.items[0].group_id).toBe('Alpha');
    expect(listed.items[0].personnel_name).toBe('Soldier 101');
  });

  it('E: missing personnel still stores telemetry without fabricating roster', async () => {
    const burst = packSatelliteBurst([soldierPayload({ soldier_id: 8888 })]);
    const response = await request(harness.app.getHttpServer())
      .post('/api/ingest')
      .send({ burst_hex: burst.toString('hex'), gateway_id: 'GW-UNKNOWN' });

    expect(response.status).toBe(200);
    expect(response.body.records[0].soldier_id).toBe(8888);
    expect(response.body.records[0].group_id).toBeNull();

    const roster = (
      await request(harness.app.getHttpServer())
        .get('/api/personnel')
        .set(headers)
        .query({ q: '8888' })
    ).body;
    expect(roster.items.some((p: any) => p.soldier_id === 8888)).toBe(false);
  });

  it('F: flags create SOS/casualty/arrhythmia/low-battery/heat-stress alerts', async () => {
    const cases: Array<{ soldier_id: number; flag: any; alert_type: string }> = [
      { soldier_id: 701, flag: { sos: true }, alert_type: 'SOS' },
      { soldier_id: 702, flag: { casualty: true }, alert_type: 'CASUALTY' },
      { soldier_id: 703, flag: { arrhythmia: true }, alert_type: 'ARRHYTHMIA' },
      { soldier_id: 704, flag: { low_battery: true }, alert_type: 'LOW_BATTERY' },
      { soldier_id: 705, flag: { heat_stress: true }, alert_type: 'HEAT_STRESS' },
    ];

    for (const item of cases) {
      const burst = packSatelliteBurst([
        soldierPayload({
          soldier_id: item.soldier_id,
          flags: encodeFlags(item.flag),
        }),
      ]);
      const ingested = await request(harness.app.getHttpServer())
        .post('/api/ingest')
        .send({
          burst_hex: burst.toString('hex'),
          gateway_id: 'GW-ALERTS',
          burst_id: `burst-alert-${item.soldier_id}`,
        });
      expect(ingested.status).toBe(200);

      const alerts = (
        await request(harness.app.getHttpServer())
          .get('/api/alerts')
          .query({ soldier_id: item.soldier_id, alert_type: item.alert_type })
      ).body;
      expect(alerts.total).toBeGreaterThanOrEqual(1);
      expect(alerts.items[0].alert_type).toBe(item.alert_type);
      expect(alerts.items[0].source_record_id).toBe(ingested.body.records[0].id);
    }
  });

  it('G: burst alone is not a fake soldier telemetry record and creates no alert', async () => {
    // Header-only is invalid; use one soldier with no alert flags.
    const burst = packSatelliteBurst([
      soldierPayload({ soldier_id: 801, flags: encodeFlags({}) }),
    ]);
    const response = await request(harness.app.getHttpServer())
      .post('/api/ingest')
      .send({
        burst_hex: burst.toString('hex'),
        gateway_id: 'GW-NOFAKE',
        burst_id: 'burst-nofake',
      });
    expect(response.status).toBe(200);

    // Burst transport record is UPLINK, not TELEMETRY soldier.
    expect(response.body.burst.category).toBe('UPLINK');
    expect(response.body.burst.soldier_id).toBeNull();

    const transportInExplorer = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ q: 'burst-nofake' })
    ).body;
    // Default explorer is TELEMETRY-only — burst uplink must not appear as soldier row.
    expect(
      transportInExplorer.items.every((item: any) => item.category === 'TELEMETRY'),
    ).toBe(true);
    expect(
      transportInExplorer.items.every((item: any) => item.soldier_id != null),
    ).toBe(true);

    const uplinkOnly = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ category: 'UPLINK', q: 'burst-nofake' })
    ).body;
    expect(uplinkOnly.total).toBe(1);
    expect(uplinkOnly.items[0].data_type).toBe('SATELLITE_BURST');

    const alerts = (
      await request(harness.app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 801 })
    ).body;
    // No flag-derived alerts (SOS/casualty/etc.) from a clean burst payload.
    const flagAlerts = alerts.items.filter(
      (item: any) => item.alert_type !== 'NO_CONTACT',
    );
    expect(flagAlerts).toHaveLength(0);
  });

  it('H: decoded soldier telemetry is searchable in Explorer', async () => {
    const burst = packSatelliteBurst([
      soldierPayload({ soldier_id: 106, seq: 9 }),
      soldierPayload({ soldier_id: 107, seq: 10 }),
    ]);
    const ingested = await request(harness.app.getHttpServer())
      .post('/api/ingest')
      .send({
        burst_hex: burst.toString('hex'),
        gateway_id: 'GW-SEARCH',
        burst_id: 'burst-search-xyz',
      });
    expect(ingested.status).toBe(200);

    const bySoldier = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ soldier_id: 106, transport: 'SATELLITE' })
    ).body;
    expect(bySoldier.total).toBeGreaterThanOrEqual(1);
    expect(bySoldier.items[0].data.hr).toBe(80);
    expect(bySoldier.items[0].data.flags).toBeDefined();

    const byBurstRef = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ q: 'burst-search-xyz' })
    ).body;
    expect(byBurstRef.total).toBe(2);

    const searchSquad = await request(harness.app.getHttpServer())
      .post('/api/groups')
      .set(headers)
      .send({ name: 'SearchSquad' });
    expect(searchSquad.status).toBe(201);
    const assigned = await request(harness.app.getHttpServer())
      .put('/api/personnel/by-soldier/106/group')
      .set(headers)
      .send({ group_id: searchSquad.body.id });
    expect(assigned.status).toBe(200);

    const byName = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ q: 'Soldier 106', transport: 'SATELLITE' })
    ).body;
    // Name search works after personnel row exists (from group assign).
    expect(byName.items.some((item: any) => item.soldier_id === 106)).toBe(true);

    const bySoldier107 = (
      await request(harness.app.getHttpServer())
        .get('/api/explorer')
        .query({ soldier_id: 107, transport: 'SATELLITE' })
    ).body;
    expect(bySoldier107.total).toBeGreaterThanOrEqual(1);
  });
});
