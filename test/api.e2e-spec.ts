import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestApp, TestApp } from './app.e2e-setup';
import { encodeFlags, packMeshFrame, packPayload } from '../src/mesh/frame';
import { makeRecord } from '../src/common/records';
import { DatabaseService } from '../src/database/database.service';
import { hasPermission, hashPassword } from '../src/database/access';

describe('API e2e (ported from test_api.py)', () => {
  let harness: TestApp;
  let app: INestApplication;

  beforeEach(async () => {
    harness = await createTestApp();
    app = harness.app;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('health', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', storage: 'sqlite-local' });
  });

  it('seed_counts', async () => {
    const summary = (await request(app.getHttpServer()).get('/api/explorer/summary'))
      .body;
    const counts = Object.fromEntries(
      summary.by_category.map((item: any) => [item.category, item.count]),
    );
    expect(summary.total).toBe(505);
    expect(counts).toEqual({
      TELEMETRY: 240,
      MESH: 240,
      BEACON: 18,
      SYSTEM: 3,
      UPLINK: 2,
      SPECIAL: 2,
    });
  });

  it('telemetry_keeps_sos_flag_visible', async () => {
    const flags = encodeFlags({ sos: true, strap: true, position: 'GNSS' });
    const response = await request(app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 4242,
        seq: 7,
        timestamp: '2026-10-04T12:00:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags,
        group_id: 'Alpha',
        gateway_id: 'GW-01',
        record_origin: 'INGEST',
      });
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.category).toBe('TELEMETRY');
    expect(body.data.flags.sos).toBe(true);
    expect(body.data.flags.position_source).toBe('GNSS');
    expect(body.position_source).toBe('GNSS');
    expect(body.raw_bytes_length).toBe(21);
    const listed = (
      await request(app.getHttpServer())
        .get('/api/explorer')
        .query({ soldier_id: 4242 })
    ).body;
    expect(listed.total).toBe(1);
    expect(listed.items[0].id).toBe(body.id);
  });

  it('direct_telemetry_uses_utc_and_21_byte_raw', async () => {
    const flags = encodeFlags({});
    const unix = 1791115200;
    const response = await request(app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 77,
        seq: 4,
        timestamp: unix,
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags,
        received_at: '2026-10-04T19:00:04+07:00',
      });
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.event_time).toBe('2026-10-04T12:00:00Z');
    expect(body.received_at).toBe('2026-10-04T12:00:04Z');
    expect(body.data.timestamp).toBe(unix);
    expect(body.raw_format).toBe('PAYLOAD_21');
    expect(body.raw_bytes_length).toBe(21);
    expect(body.raw_hex).toBe(
      packPayload({
        soldier_id: 77,
        seq: 4,
        timestamp: unix,
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags,
      }).toString('hex'),
    );

    const rejected = await request(app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 78,
        seq: 1,
        timestamp: '2026-10-04T12:00:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags,
        raw_hex: 'abcd',
      });
    expect(rejected.status).toBe(400);

    const listed = await request(app.getHttpServer())
      .get('/api/explorer')
      .query({
        from_time: '2026-10-04T15:00:00+07:00',
        to_time: String(unix),
        soldier_id: 77,
      });
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
  });

  it('mesh_frame_decodes_25_bytes', async () => {
    const flags = encodeFlags({ position: 'GNSS' });
    const payload = packPayload({
      soldier_id: 1024,
      seq: 125,
      timestamp: 1791115200,
      lat: -6.2012345,
      lon: 106.8123456,
      hr: 82,
      hrv: 41,
      spo2: 97,
      temp: 34,
      batt: 86,
      flags,
    });
    const frame = packMeshFrame(1, 3, 1, payload);
    const response = await request(app.getHttpServer())
      .post('/api/ingest/mesh-frame')
      .send({
        frame_hex: frame.toString('hex'),
        gateway_id: 'GW-01',
        group_id: 'Alpha',
        rssi: -87,
        snr: 8.5,
        pdr: 0.96,
        spreading_factor: 9,
        tx_power_dbm: 14,
        received_at: '2026-10-04T12:00:04Z',
      });
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.category).toBe('MESH');
    expect(body.data_type).toBe('LORA_FRAME');
    expect(body.raw_bytes_length).toBe(25);
    expect(body.data.ttl).toBe(3);
    expect(body.data.hop_count).toBe(1);
    expect(body.data.payload_length).toBe(21);
    expect(body.data.payload.seq).toBe(125);
    expect(body.data.payload.lat).toBe(-6.2012345);
    expect(body.data.spreading_factor).toBe(9);
  });

  it('mesh_frame_rejects_short_hex', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/ingest/mesh-frame')
      .send({ frame_hex: 'abcd' });
    expect(response.status).toBe(400);
  });

  it('uplink_beacon_special_and_system', async () => {
    const uplink = await request(app.getHttpServer())
      .post('/api/ingest/uplink')
      .send({
        gateway_id: 'GW-02',
        burst_id: 'burst-test',
        packet_count: 8,
        payload_size_bytes: 174,
        sent_at: '2026-10-04T06:00:00Z',
        received_at: '2026-10-04T09:00:00Z',
        delivery_status: 'delivered',
        retry_count: 1,
        session_duration_seconds: 30,
        delivery_mode: 'STORE_AND_CARRY',
      });
    expect(uplink.status).toBe(200);
    expect(uplink.body.data.delivery_mode).toBe('STORE_AND_CARRY');
    expect(uplink.body.event_time).toBe('2026-10-04T06:00:00Z');
    expect(uplink.body.received_at).toBe('2026-10-04T09:00:00Z');

    const rejected = await request(app.getHttpServer())
      .post('/api/ingest/uplink')
      .send({
        gateway_id: 'GW-02',
        burst_id: 'burst-bad',
        packet_count: 1,
        payload_size_bytes: 21,
        sent_at: '2026-10-04T06:00:00Z',
        received_at: '2026-10-04T06:00:10Z',
        delivery_status: 'delivered',
        retry_count: 0,
        session_duration_seconds: 10,
        delivery_mode: 'MAYBE',
      });
    expect(rejected.status).toBe(422);

    const beacon = await request(app.getHttpServer())
      .post('/api/ingest/beacon')
      .send({
        beacon_id: 'B-99',
        observer_id: '101',
        rssi: -88,
        timestamp: '2026-10-04T08:10:00Z',
        gateway_id: 'GW-01',
      });
    expect(beacon.status).toBe(200);
    expect(beacon.body.category).toBe('BEACON');
    expect(beacon.body.soldier_id).toBeNull();
    expect(beacon.body.entity_type).toBe('BEACON');

    const special = await request(app.getHttpServer())
      .post('/api/ingest/special')
      .send({
        special_type: 'RR_SERIES',
        soldier_id: 101,
        group_id: 'Alpha',
        event_time: '2026-10-04T08:12:00Z',
        received_at: '2026-10-04T08:12:05Z',
        payload_hex: '001122',
        transport: 'MESH',
        metadata: { note: 'opaque' },
      });
    expect(special.status).toBe(200);
    expect(special.body.data_type).toBe('RR_SERIES');
    expect(special.body.raw_format).toBe('OPAQUE');
    expect(special.body.data.metadata).toEqual({ note: 'opaque' });

    const system = await request(app.getHttpServer())
      .post('/api/ingest/system')
      .send({
        event_type: 'DEVICE_STATE_CHANGE',
        entity_type: 'SOLDIER',
        entity_id: '101',
        event_time: '2026-10-04T08:20:00Z',
        received_at: '2026-10-04T08:20:01Z',
        severity: 'WARNING',
        group_id: 'Alpha',
        gateway_id: 'GW-01',
        details: { state: 'online' },
      });
    expect(system.status).toBe(200);
    expect(system.body.category).toBe('SYSTEM');
    expect(system.body.severity).toBe('WARNING');
    expect(system.body.soldier_id).toBe(101);
  });

  it('explorer_search_detail_options_and_csv', async () => {
    const found = (
      await request(app.getHttpServer())
        .get('/api/explorer')
        .query({ q: 'STORE_AND_CARRY', category: 'UPLINK' })
    ).body;
    expect(found.total).toBe(1);
    expect(found.items[0].data.delivery_mode).toBe('STORE_AND_CARRY');

    const recordId = found.items[0].id;
    const detail = await request(app.getHttpServer()).get(
      `/api/explorer/${recordId}`,
    );
    expect(detail.status).toBe(200);
    const body = detail.body;
    for (const field of [
      'id',
      'category',
      'data_type',
      'entity_type',
      'entity_id',
      'soldier_id',
      'group_id',
      'gateway_id',
      'event_time',
      'received_at',
      'position_source',
      'transport',
      'freshness',
      'severity',
      'record_origin',
      'raw_format',
      'raw_hex',
      'raw_bytes_length',
      'created_at',
      'data',
    ]) {
      expect(body).toHaveProperty(field);
    }

    const missing = await request(app.getHttpServer()).get('/api/explorer/999999');
    expect(missing.status).toBe(404);

    const options = (
      await request(app.getHttpServer()).get('/api/explorer/filters/options')
    ).body;
    expect(options.categories).toContain('TELEMETRY');
    expect(options.record_origins).toContain('SIMULATED');
    expect(options.gateways).toContain('GW-01');
    expect(options.raw_formats).toContain('PAYLOAD_21');

    const exported = await request(app.getHttpServer())
      .get('/api/explorer/export.csv')
      .query({ category: 'UPLINK' });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    const text = exported.text.replace(/^\ufeff/, '');
    expect(text.startsWith('id,category,data_type,')).toBe(true);
    expect(text.split('\n').filter((line) => line.includes(',UPLINK,')).length).toBe(
      2,
    );
  });

  it('explorer_and_alerts_accept_all_time_and_30_day_ranges', async () => {
    const flags = encodeFlags({ sos: true, strap: true });
    const posted = await request(app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 5151,
        seq: 1,
        timestamp: '2020-01-01T00:00:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 80,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags,
      });
    expect(posted.status).toBe(200);
    expect(
      (await request(app.getHttpServer()).get('/api/explorer/filters/options')).body
        .time_ranges,
    ).toEqual(['all', '30d']);
    expect(
      (await request(app.getHttpServer()).get('/api/alerts/filters/options')).body
        .time_ranges,
    ).toEqual(['all', '30d']);

    const params = { soldier_id: 5151 };
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/explorer')
          .query({ ...params, timeRange: 'all' })
      ).body.total,
    ).toBe(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/explorer')
          .query({ ...params, timeRange: 'alltime' })
      ).body.total,
    ).toBe(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/explorer')
          .query({ ...params, timeRange: '30d' })
      ).body.total,
    ).toBe(0);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/explorer/summary')
          .query({ ...params, timeRange: '30day' })
      ).body.total,
    ).toBe(0);
    expect(
      (await request(app.getHttpServer()).get('/api/explorer').query({ timeRange: '90d' }))
        .status,
    ).toBe(400);

    expect(
      (
        await request(app.getHttpServer())
          .get('/api/alerts')
          .query({ ...params, timeRange: 'all' })
      ).body.total,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/alerts')
          .query({ ...params, timeRange: '30days' })
      ).body.total,
    ).toBe(0);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/alerts/summary')
          .query({ ...params, timeRange: '30d' })
      ).body.total,
    ).toBe(0);
  });

  it('sos_opens_alert_and_stays_in_explorer', async () => {
    const seeded = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ alert_type: 'SOS', soldier_id: 101 })
    ).body;
    expect(seeded.total).toBe(1);
    expect(seeded.items[0].severity).toBe('CRITICAL');
    expect(seeded.items[0].message).toBe('SOS button pressed');
    expect(seeded.items[0].source_record.soldier_id).toBe(101);
    const explorerBefore = (
      await request(app.getHttpServer()).get('/api/explorer/summary')
    ).body.total;

    const flags = encodeFlags({ sos: true, strap: true, position: 'GNSS' });
    const created = await request(app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 5150,
        seq: 9,
        timestamp: '2026-10-04T13:00:00Z',
        lat: -6.21,
        lon: 106.82,
        hr: 140,
        hrv: 20,
        spo2: 96,
        temp: 37,
        batt: 70,
        flags,
        group_id: 'Alpha',
      });
    expect(created.status).toBe(200);
    const listed = (
      await request(app.getHttpServer())
        .get('/api/explorer')
        .query({ soldier_id: 5150 })
    ).body;
    expect(listed.total).toBe(1);
    const alerts = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 5150, alert_type: 'SOS' })
    ).body;
    expect(alerts.total).toBe(1);
    expect(alerts.items[0].source_record_id).toBe(created.body.id);
    expect(
      (await request(app.getHttpServer()).get('/api/explorer/summary')).body.total,
    ).toBe(explorerBefore + 1);
    const exported = await request(app.getHttpServer())
      .get('/api/alerts/export.csv')
      .query({ alert_type: 'SOS' });
    expect(exported.status).toBe(200);
    expect(exported.text).toContain(',SOS,');
  });

  it('sos_rows_stay_out_of_explorer', async () => {
    const db = harness.moduleRef.get(DatabaseService);
    const hiddenId = db.insertRecord(
      makeRecord({
        category: 'SYSTEM',
        data_type: 'OTHER',
        entity_type: 'SOLDIER',
        entity_id: '4242',
        soldier_id: 4242,
        group_id: 'Alpha',
        gateway_id: 'GW-01',
        event_time: '2026-10-04T12:10:00Z',
        received_at: '2026-10-04T12:10:01Z',
        position_source: null,
        transport: null,
        freshness: 'FRESH',
        severity: 'CRITICAL',
        record_origin: 'INGEST',
        raw_format: 'JSON',
        raw_hex: 'sos-hidden-marker',
        data: { event_type: 'OTHER' },
        is_sos: 1,
      }),
    );
    const listed = (
      await request(app.getHttpServer())
        .get('/api/explorer')
        .query({ q: 'sos-hidden-marker' })
    ).body;
    expect(listed.total).toBe(0);
    expect(
      (await request(app.getHttpServer()).get(`/api/explorer/${hiddenId}`)).status,
    ).toBe(404);
  });

  it('alert_seed_distribution', async () => {
    const summary = (await request(app.getHttpServer()).get('/api/alerts/summary'))
      .body;
    expect(summary.total).toBe(36);
    const severities = Object.fromEntries(
      summary.by_severity.map((item: any) => [item.severity, item.count]),
    );
    const kinds = Object.fromEntries(
      summary.by_type.map((item: any) => [item.alert_type, item.count]),
    );
    expect(severities).toEqual({ CRITICAL: 6, WARNING: 12, INFO: 18 });
    expect(kinds).toEqual({
      SOS: 3,
      CASUALTY: 1,
      ARRHYTHMIA: 2,
      LOW_BATTERY: 7,
      HEAT_STRESS: 5,
      STRAP_DISCONNECTED: 4,
      NO_CONTACT: 14,
    });
    const sos = (await request(app.getHttpServer()).get('/api/alerts/sos')).body;
    expect(sos.total).toBe(3);
    const options = (
      await request(app.getHttpServer()).get('/api/alerts/filters/options')
    ).body;
    expect(options.alert_types).toContain('SOS');
    expect(options.severities).toContain('CRITICAL');
    const schema = (await request(app.getHttpServer()).get('/openapi.json')).body;
    expect(schema.paths).toHaveProperty('/api/alerts/sos');
    expect(schema.paths).toHaveProperty('/api/alerts/{alert_id}/acknowledge');
    expect(schema.components.schemas.AlertOut.properties).toHaveProperty('alert_code');
    expect(schema.components.schemas.AlertOut.properties).toHaveProperty(
      'source_record',
    );
  });

  it('arrhythmia_episode_does_not_duplicate', async () => {
    const post = async (minute: number, active: boolean) => {
      const flags = encodeFlags({ arrhythmia: active, strap: true });
      const response = await request(app.getHttpServer())
        .post('/api/ingest/telemetry')
        .send({
          soldier_id: 8800,
          seq: minute,
          timestamp: `2026-10-04T12:${String(minute).padStart(2, '0')}:00Z`,
          lat: -6.2,
          lon: 106.8,
          hr: 90,
          hrv: 30,
          spo2: 97,
          temp: 36,
          batt: 80,
          flags,
          group_id: 'Alpha',
          gateway_id: 'GW-01',
        });
      expect(response.status).toBe(200);
      return response.body.id as number;
    };

    const first = await post(0, true);
    const second = await post(1, true);
    const third = await post(2, true);
    const page = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 8800, alert_type: 'ARRHYTHMIA' })
    ).body;
    expect(page.total).toBe(1);
    const episode = page.items[0];
    expect(episode.source_record_id).toBe(third);
    expect(episode.first_seen_at).toBe('2026-10-04T12:00:00Z');
    expect(episode.last_seen_at).toBe('2026-10-04T12:02:00Z');
    expect(episode.status).toBe('ACTIVE');
    expect(first).not.toBe(second);

    await post(3, false);
    const cleared = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 8800, alert_type: 'ARRHYTHMIA' })
    ).body;
    expect(cleared.total).toBe(1);
    expect(cleared.items[0].status).toBe('CLEARED');

    await post(10, true);
    const reopened = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 8800, alert_type: 'ARRHYTHMIA' })
    ).body;
    expect(reopened.total).toBe(2);
    expect(reopened.items[0].status).toBe('ACTIVE');
    expect(reopened.items[0].event_time).toBe('2026-10-04T12:10:00Z');
  });

  it('acknowledge_and_resolve', async () => {
    const alertId = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ alert_type: 'CASUALTY' })
    ).body.items[0].id;
    const acknowledged = await request(app.getHttpServer())
      .post(`/api/alerts/${alertId}/acknowledge`)
      .send({ by: 'medic-1' });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.status).toBe('ACKNOWLEDGED');
    expect(acknowledged.body.acknowledged_by).toBe('medic-1');
    const resolved = await request(app.getHttpServer())
      .post(`/api/alerts/${alertId}/resolve`)
      .send({ by: 'medic-1' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('RESOLVED');
    expect(resolved.body.resolved_by).toBe('medic-1');
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/alerts/${alertId}/resolve`)
          .send({ by: 'medic-1' })
      ).status,
    ).toBe(409);
  });

  it('no_contact_resolves_when_telemetry_returns', async () => {
    const before = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 301, alert_type: 'NO_CONTACT' })
    ).body;
    expect(before.total).toBe(1);
    expect(before.items[0].status).toBe('ACTIVE');
    expect(before.items[0].derived_from).toBe('NO_TELEMETRY');
    const flags = encodeFlags({ strap: true });
    const response = await request(app.getHttpServer())
      .post('/api/ingest/telemetry')
      .send({
        soldier_id: 301,
        seq: 1,
        timestamp: '2026-10-04T08:00:00Z',
        lat: -6.2,
        lon: 106.8,
        hr: 70,
        hrv: 40,
        spo2: 98,
        temp: 36,
        batt: 90,
        flags,
      });
    expect(response.status).toBe(200);
    const after = (
      await request(app.getHttpServer())
        .get('/api/alerts')
        .query({ soldier_id: 301, alert_type: 'NO_CONTACT' })
    ).body;
    expect(after.total).toBe(1);
    expect(after.items[0].status).toBe('RESOLVED');
    expect(after.items[0].resolved_by).toBe('engine');
  });

  it('history_reads_explorer_without_double_counting', async () => {
    const params = {
      scope: 'SOLDIER',
      soldier_id: 104,
      from_time: '2026-10-04T08:00:00Z',
      to_time: '2026-10-04T08:30:00Z',
    };
    const summary = await request(app.getHttpServer())
      .get('/api/history/summary')
      .query(params);
    expect(summary.status).toBe(200);
    const cards = summary.body.cards;
    expect(cards.total_records).toBe(60);
    expect(cards.distance_is_derived).toBe(true);
    expect(cards.total_distance_km).toBeGreaterThan(0);
    expect(cards.heart_rate_avg_bpm).not.toBeNull();
    expect(cards.battery_avg_percent).not.toBeNull();

    const telemetry = (
      await request(app.getHttpServer())
        .get('/api/history')
        .query({ ...params, history_data_type: 'TELEMETRY', limit: 500 })
    ).body;
    expect(telemetry.total).toBe(30);
    expect(new Set(telemetry.items.map((item: any) => item.data_type))).toEqual(
      new Set(['TELEMETRY']),
    );

    const track = (
      await request(app.getHttpServer()).get('/api/history/track').query(params)
    ).body.points;
    expect(track.length).toBe(30);
    expect(track.map((point: any) => point.event_time)).toEqual(
      [...track.map((point: any) => point.event_time)].sort(),
    );

    const gnss = (
      await request(app.getHttpServer())
        .get('/api/history/track')
        .query({ ...params, position_source: 'GNSS' })
    ).body.points;
    expect(gnss.length).toBeGreaterThan(0);
    expect(gnss.length).toBeLessThan(track.length);

    const detail = await request(app.getHttpServer()).get(
      `/api/history/point/${track[0].source_id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(`R-${track[0].source_id}`);
    expect(detail.body.details.vitals.hr).not.toBeNull();
    expect(detail.body.details.raw_data.raw_bytes_length).toBe(21);
    expect(
      (await request(app.getHttpServer()).get('/api/history/point/999999')).status,
    ).toBe(404);

    const charts = (
      await request(app.getHttpServer()).get('/api/history/charts').query(params)
    ).body.buckets;
    expect(charts.length).toBeGreaterThan(0);
    expect(charts[0].samples).toBe(30);

    const stats = (
      await request(app.getHttpServer()).get('/api/history/statistics').query(params)
    ).body;
    expect(stats.position_points).toBe(30);
    expect(stats.soldiers).toBe(1);

    const options = (
      await request(app.getHttpServer())
        .get('/api/history/filters/options')
        .query(params)
    ).body;
    expect(options.data_types).toContain('MESH_FRAME');
    expect(options.position_sources).toContain('GNSS');
    expect(options.time_ranges).toEqual(['all', '30d']);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/history/summary')
          .query({ ...params, timeRange: 'all' })
      ).body.cards.total_records,
    ).toBe(60);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/history')
          .query({ scope: 'GROUP', group_id: 'Alpha', timeRange: '90d' })
      ).status,
    ).toBe(400);

    const exported = await request(app.getHttpServer())
      .get('/api/history/export.csv')
      .query({ ...params, history_data_type: 'UPLINK' });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');

    expect(
      (await request(app.getHttpServer()).get('/api/history/summary').query({ scope: 'SOLDIER' }))
        .status,
    ).toBe(400);
    const group = (
      await request(app.getHttpServer())
        .get('/api/history/summary')
        .query({ scope: 'GROUP', group_id: 'Alpha' })
    ).body;
    expect(group.cards.total_records).toBe(505);
    const schema = (await request(app.getHttpServer()).get('/openapi.json')).body;
    expect(schema.paths).toHaveProperty('/api/history/track');
    expect(schema.paths).toHaveProperty('/api/history/point/{record_id}');
  });

  it('user_access_registry_role_and_binding', async () => {
    expect(hasPermission(new Set(['history']), 'history', 'read')).toBe(true);
    expect(hasPermission(new Set(['history']), 'history', 'all')).toBe(true);
    expect(hasPermission(new Set(['history.read']), 'history', 'read')).toBe(true);
    expect(hasPermission(new Set(['history.read']), 'history', 'all')).toBe(false);

    expect((await request(app.getHttpServer()).get('/permissions')).status).toBe(
      404,
    );
    expect(
      (await request(app.getHttpServer()).get('/roles/permissions')).status,
    ).toBe(404);

    const roles = (await request(app.getHttpServer()).get('/roles')).body.items;
    expect(roles.map((role: any) => role.name)).toEqual([
      'superadmin',
      'operations commander',
      'operations officer',
      'field operator',
      'device & fleet admin',
      'viewer',
    ]);
    expect(roles.every((role: any) => role.is_protected && role.is_system)).toBe(
      true,
    );
    const byName = Object.fromEntries(roles.map((role: any) => [role.name, role]));
    const commander = (
      await request(app.getHttpServer()).get(
        `/roles/${byName['operations commander'].id}/detail`,
      )
    ).body;
    expect(commander.display_name).toBe('Operations Commander');
    expect(commander).not.toHaveProperty('permissions');
    expect(
      (
        await request(app.getHttpServer()).get(
          `/roles/${byName.viewer.id}/permissions`,
        )
      ).status,
    ).toBe(404);
    const superadmin = byName.superadmin;
    expect(
      (
        await request(app.getHttpServer())
          .put(`/roles/${superadmin.id}`)
          .send({
            name: 'superadmin',
            duty_category: 'Platform Administration',
            description: 'Changed.',
          })
      ).status,
    ).toBe(403);
    expect(
      (await request(app.getHttpServer()).delete(`/roles/${superadmin.id}`)).status,
    ).toBe(403);

    const seeded = await request(app.getHttpServer())
      .post('/users/login')
      .send({ account: 'superadmin', password: 'superadmin' });
    expect(seeded.status).toBe(200);
    expect(seeded.body.username).toBe('superadmin');
    expect(seeded.body.status).toBe('ACTIVE');
    expect(seeded.body.access.role).toBe('superadmin');
    expect(seeded.body.access.permissions.length).toBe(30);
    const summary = (await request(app.getHttpServer()).get('/users/summary')).body;
    expect(summary.total_humans).toBe(1);
    expect(summary.active_humans).toBe(1);
    expect(summary.inactive_humans).toBe(0);
    expect(summary.pending_verification).toBe(0);
    const created = await request(app.getHttpServer())
      .post('/users/human')
      .send({
        name: 'Andi Pratama',
        username: 'andi.pratama',
        email: 'Andi@trackforge.id',
        password: 'temporary-password',
        department: 'Command Operations',
        title: 'Operations Commander',
        status: 'ACTIVE',
        access_binding: 'BOUND',
      });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: created.body.id,
      name: 'Andi Pratama',
      verification: 'VERIFIED',
      access_binding: 'NO_BINDING',
      status: 'INACTIVE',
    });
    expect(created.body).not.toHaveProperty('password');
    const userId = created.body.id;
    const stored = new Database(harness.dbPath);
    const passwordHash = stored
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(userId) as { password_hash: string };
    stored.close();
    expect(passwordHash.password_hash.startsWith('pbkdf2_sha256$')).toBe(true);
    expect(passwordHash.password_hash).not.toContain('temporary-password');

    const listed = (
      await request(app.getHttpServer())
        .get('/users')
        .query({ q: 'andi', access_binding: 'NO_BINDING' })
    ).body;
    expect(listed.total).toBe(1);
    expect(listed.items[0].email).toBe('andi@trackforge.id');
    expect(listed.items[0].status).toBe('INACTIVE');
    expect(
      (
        await request(app.getHttpServer())
          .post('/users/human')
          .send({
            name: 'Andi Again',
            username: 'andi.pratama',
            email: 'other@trackforge.id',
            password: 'temporary-password',
          })
      ).status,
    ).toBe(409);

    const custom = await request(app.getHttpServer())
      .post('/roles')
      .send({
        name: '  Operations Planner  ',
        duty_category: 'Operations Control',
        description: 'Operational planning role.',
        privilege_narrative: 'Provides required planning authority.',
        least_privilege_baseline: 'Only planning-related capabilities.',
      });
    expect(custom.status).toBe(201);
    expect(custom.body.name).toBe('operations planner');
    expect(custom.body.is_protected).toBe(false);
    expect(custom.body).not.toHaveProperty('permissions');
    expect(
      (
        await request(app.getHttpServer())
          .patch(`/roles/${custom.body.id}/permissions`)
          .send({ permissionIds: [1] })
      ).status,
    ).toBe(404);

    const bound = await request(app.getHttpServer())
      .post('/user-roles')
      .send({
        user_id: userId,
        role_id: custom.body.id,
        description: 'Planning desk',
      });
    expect(bound.status).toBe(201);
    expect(bound.body.status).toBe('ACTIVE');
    expect(bound.body.user_status).toBe('ACTIVE');
    expect(bound.body.access_binding).toBe('BOUND');
    expect(
      (
        await request(app.getHttpServer())
          .post('/user-roles')
          .send({ user_id: userId, role_id: byName.viewer.id })
      ).status,
    ).toBe(409);
    const access = (
      await request(app.getHttpServer()).get(`/users/${userId}/permissions`)
    ).body;
    expect(access.role).toBe('operations planner');
    expect(access.permissions).toEqual([]);
    expect(
      (await request(app.getHttpServer()).get('/users/summary')).body.active_humans,
    ).toBe(2);

    const pending = await request(app.getHttpServer())
      .patch(`/users/${userId}/human`)
      .send({ verification: 'PENDING' });
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('INACTIVE');
    expect(pending.body.access_binding).toBe('BOUND');
    expect(
      (await request(app.getHttpServer()).get('/users/summary')).body
        .pending_verification,
    ).toBe(1);
    const restored = await request(app.getHttpServer())
      .patch(`/users/${userId}/human`)
      .send({ verification: 'VERIFIED' });
    expect(restored.body.status).toBe('ACTIVE');

    const revoked = await request(app.getHttpServer())
      .patch(`/user-roles/${bound.body.id}/status`)
      .send({ status: 'REVOKED' });
    expect(revoked.status).toBe(200);
    expect(revoked.body.user_status).toBe('INACTIVE');
    expect(revoked.body.access_binding).toBe('NO_BINDING');
    expect(
      (await request(app.getHttpServer()).get(`/users/${userId}/permissions`)).body
        .permissions,
    ).toEqual([]);

    const rebound = await request(app.getHttpServer())
      .post('/user-roles')
      .send({ user_id: userId, role_id: byName.viewer.id });
    expect(rebound.status).toBe(201);
    expect(rebound.body.id).toBe(bound.body.id);
    expect(rebound.body.user_status).toBe('ACTIVE');
    const viewerAccess = (
      await request(app.getHttpServer()).get(`/users/${userId}/permissions`)
    ).body;
    expect(viewerAccess.role).toBe('viewer');
    expect(viewerAccess.permissions).toContain('history.read');
    expect(viewerAccess.permissions).not.toContain('history');

    const held = new Database(harness.dbPath);
    held.prepare("UPDATE users SET status = 'SUSPENDED' WHERE id = ?").run(userId);
    held.close();
    const suspended = await request(app.getHttpServer())
      .patch(`/user-roles/${bound.body.id}/status`)
      .send({ status: 'REVOKED' });
    expect(suspended.body.user_status).toBe('SUSPENDED');
    expect(
      (await request(app.getHttpServer()).delete(`/roles/${custom.body.id}`)).status,
    ).toBe(204);
    expect(
      (await request(app.getHttpServer()).get(`/roles/${custom.body.id}/detail`))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/history/summary')
          .query({ scope: 'GROUP', group_id: 'Alpha' })
      ).status,
    ).toBe(200);
  });

  it('login_checks_password_and_returns_active_access', async () => {
    const created = await request(app.getHttpServer())
      .post('/users/human')
      .send({
        name: 'Andi Login',
        username: 'andi.login',
        email: 'andi.login@trackforge.id',
        password: 'temporary-password',
        department: 'Command Operations',
      });
    expect(created.status).toBe(201);
    const userId = created.body.id;
    const body = { account: 'andi.login', password: 'temporary-password' };
    const inactive = await request(app.getHttpServer()).post('/users/login').send(body);
    expect(inactive.status).toBe(403);
    expect(inactive.body.detail).toBe('account is not active');
    expect(
      (
        await request(app.getHttpServer())
          .post('/users/login')
          .send({ account: 'andi.login', password: 'wrong-password' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/users/login')
          .send({ account: 'missing.user', password: 'temporary-password' })
      ).status,
    ).toBe(401);

    const viewer = (await request(app.getHttpServer()).get('/roles')).body.items.find(
      (role: any) => role.name === 'viewer',
    );
    const bound = await request(app.getHttpServer())
      .post('/user-roles')
      .send({ user_id: userId, role_id: viewer.id });
    expect(bound.status).toBe(201);

    const logged = await request(app.getHttpServer())
      .post('/users/login')
      .send({ account: 'Andi.Login', password: 'temporary-password' });
    expect(logged.status).toBe(200);
    const session = logged.body;
    expect(session.id).toBe(userId);
    expect(session.email).toBe('andi.login@trackforge.id');
    expect(session.status).toBe('ACTIVE');
    expect(session.access.role).toBe('viewer');
    expect(session.access.user_id).toBe(userId);
    expect(session.access.permissions).toContain('history.read');
    expect(session.access.permissions).not.toContain('history');
    expect(session).not.toHaveProperty('password');
    expect(session).not.toHaveProperty('password_hash');

    const byEmail = await request(app.getHttpServer())
      .post('/users/login')
      .send({
        account: 'ANDI.LOGIN@trackforge.id',
        password: 'temporary-password',
      });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.access.permissions).toEqual(session.access.permissions);

    const pending = await request(app.getHttpServer())
      .patch(`/users/${userId}/human`)
      .send({ verification: 'PENDING' });
    expect(pending.body.status).toBe('INACTIVE');
    const unverified = await request(app.getHttpServer()).post('/users/login').send(body);
    expect(unverified.status).toBe(403);
    expect(unverified.body.detail).toBe('account is not verified');

    const stored = new Database(harness.dbPath);
    stored
      .prepare(
        `
        INSERT INTO users (
            identity_type, name, username, email, password_hash, verification, status, created_at, updated_at
        )
        VALUES ('SERVICE', 'Gateway Bot', 'gateway.bot', 'gateway.bot@trackforge.id', ?, 'VERIFIED', 'ACTIVE', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')
        `,
      )
      .run(hashPassword('temporary-password'));
    stored.close();
    const service = await request(app.getHttpServer())
      .post('/users/login')
      .send({ account: 'gateway.bot', password: 'temporary-password' });
    expect(service.status).toBe(403);
    expect(service.body.detail).toBe('account is not human');
    expect(
      (await request(app.getHttpServer()).get('/openapi.json')).body.paths,
    ).toHaveProperty('/users/login');
  });

  it('activity_log_records_user_access_without_trusting_actor', async () => {
    const logged = await request(app.getHttpServer())
      .post('/users/login')
      .send({ account: 'superadmin', password: 'superadmin' });
    expect(logged.status).toBe(200);
    const token = logged.body.session_id;
    const headers = { Authorization: `Bearer ${token}` };

    const created = await request(app.getHttpServer())
      .post('/users/human')
      .set(headers)
      .send({
        name: 'Sari Audit',
        username: 'sari.audit',
        email: 'sari.audit@trackforge.id',
        password: 'temporary-password',
        department: 'Command Operations',
      });
    expect(created.status).toBe(201);
    const listed = (
      await request(app.getHttpServer())
        .get('/audit-logs')
        .query({ search: 'Sari Audit', category: 'USER_ACCESS' })
    ).body;
    expect(listed.total).toBeGreaterThanOrEqual(1);
    const item = listed.items[0];
    expect(item.event).toBe('User Created');
    expect(item.category).toBe('User Access');
    expect(item.action).toBe('Create');
    expect(item.outcome).toBe('Success');
    expect(item.actor.name).toBe('Superadmin');
    expect(item.actor.role).toBe('Superadmin');
    expect(item.target.name).toBe('Sari Audit');
    expect(JSON.stringify(item)).not.toContain('password');

    const detail = await request(app.getHttpServer()).get(
      `/audit-logs/${item.eventId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.eventType).toBe('USER_CREATED');
    expect(detail.body.category).toBe('USER_ACCESS');
    expect(detail.body.action).toBe('CREATE');
    expect(detail.body.outcome).toBe('SUCCESS');
    expect(detail.body.metadata.username).toBe('sari.audit');
    expect(detail.body.metadata).not.toHaveProperty('password');

    const forged = await request(app.getHttpServer())
      .post('/audit-logs')
      .set(headers)
      .send({
        category: 'HISTORY',
        event_type: 'HISTORY_EXPORTED',
        action: 'EXPORT',
        actor_id: 99,
        actor_role: 'Superadmin',
        description: 'Exported history.',
        metadata: { password: 'should-not-stick', format: 'csv' },
      });
    expect(forged.status).toBe(201);
    expect(forged.body.actor.id).toBe(logged.body.id);
    expect(forged.body.metadata).toEqual({ format: 'csv' });
    expect(
      (
        await request(app.getHttpServer())
          .post('/audit-logs')
          .send({
            category: 'HISTORY',
            event_type: 'HISTORY_EXPORTED',
            action: 'EXPORT',
          })
      ).status,
    ).toBe(401);

    const duplicate = await request(app.getHttpServer())
      .post('/users/human')
      .set(headers)
      .send({
        name: 'Sari Audit',
        username: 'sari.audit',
        email: 'other.audit@trackforge.id',
        password: 'temporary-password',
      });
    expect(duplicate.status).toBe(409);
    const failed = (
      await request(app.getHttpServer())
        .get('/audit-logs')
        .query({ outcome: 'FAILED', search: 'Sari Audit' })
    ).body;
    expect(failed.total).toBeGreaterThanOrEqual(1);
    expect(failed.items[0].outcome).toBe('Failed');

    const summary = (await request(app.getHttpServer()).get('/audit-logs/summary'))
      .body;
    expect(summary.total_activities).toBeGreaterThanOrEqual(2);
    expect(summary.failed_actions).toBeGreaterThanOrEqual(1);
    const categories = (
      await request(app.getHttpServer()).get('/audit-logs/categories')
    ).body.categories;
    expect(
      categories.some(
        (category: any) => category.code === 'USER_ACCESS' && category.count >= 1,
      ),
    ).toBe(true);

    const mine = await request(app.getHttpServer())
      .get('/audit-logs/me')
      .set(headers);
    expect(mine.status).toBe(200);
    expect(mine.body.items.every((row: any) => row.actor.name === 'Superadmin')).toBe(
      true,
    );
    expect((await request(app.getHttpServer()).get('/audit-logs/me')).status).toBe(
      401,
    );

    const exported = await request(app.getHttpServer())
      .get('/audit-logs/export')
      .query({ category: 'USER_ACCESS', timeRange: '24h' });
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('Sari Audit');
    expect(exported.text).toContain('User Access');
    expect(exported.headers['content-type']).toContain('text/csv');

    const denied = await request(app.getHttpServer())
      .put(
        `/roles/${
          (await request(app.getHttpServer()).get('/roles')).body.items.find(
            (role: any) => role.name === 'superadmin',
          ).id
        }`,
      )
      .set(headers)
      .send({
        name: 'superadmin',
        duty_category: 'Platform Administration',
        description: 'Changed.',
      });
    expect(denied.status).toBe(403);
    const deniedLogs = (
      await request(app.getHttpServer()).get('/audit-logs').query({ outcome: 'DENIED' })
    ).body;
    expect(deniedLogs.total).toBeGreaterThanOrEqual(1);

    expect(
      (await request(app.getHttpServer()).post('/users/logout').set(headers)).status,
    ).toBe(204);
    expect(
      (await request(app.getHttpServer()).get('/audit-logs/me').set(headers)).status,
    ).toBe(401);
    expect(
      (await request(app.getHttpServer()).delete(`/audit-logs/${item.eventId}`))
        .status,
    ).toBe(405);
    expect(
      (await request(app.getHttpServer()).get('/openapi.json')).body.paths,
    ).toHaveProperty('/audit-logs/me');
  });
});
