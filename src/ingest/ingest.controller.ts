import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { raiseAlerts } from '../database/alert-rules';
import {
  PAYLOAD_LEN,
  decodeMeshFrame,
  packPayload,
  parseHex,
  positionFromFlags,
  soldierPayloadAsData,
} from '../mesh/frame';
import {
  makeRecord,
  parseEventTime,
  telemetryData,
  utcNow,
} from '../common/records';

@Controller('api/ingest')
export class IngestController {
  constructor(private readonly db: DatabaseService) {}

  private clock(value: number | string): [string, number] {
    try {
      return parseEventTime(value);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 422);
    }
  }

  private received(value?: number | string | null): string {
    if (!value) return utcNow();
    return this.clock(value)[0];
  }

  private origin(value?: string | null): string {
    return value || 'INGEST';
  }

  private save(record: Record<string, unknown>, soldierPayload?: Record<string, unknown>) {
    const recordId = this.db.insertRecord(record);
    if (soldierPayload != null) {
      raiseAlerts(this.db.connection, {
        sourceRecordId: recordId,
        soldierId: record.soldier_id as number | null,
        groupId: record.group_id as string | null,
        gatewayId: record.gateway_id as string | null,
        eventTime: record.event_time as string,
        positionSource: record.position_source as string | null,
        recordOrigin: record.record_origin as string | null,
        payload: soldierPayload,
      });
    }
    const row = this.db.getRecord(recordId);
    if (row == null) throw new HttpException('record was not stored', 500);
    return this.db.recordToApi(row);
  }

  @Post('telemetry')
  @HttpCode(200)
  telemetry(@Body() body: any) {
    const [eventTime, unix] = this.clock(body.timestamp);
    const data = telemetryData({
      soldier_id: body.soldier_id,
      seq: body.seq,
      timestamp: unix,
      lat: body.lat,
      lon: body.lon,
      hr: body.hr,
      hrv: body.hrv,
      spo2: body.spo2,
      temp: body.temp,
      batt: body.batt,
      flags: body.flags,
    });
    const packed = packPayload({
      soldier_id: body.soldier_id,
      seq: body.seq,
      timestamp: unix,
      lat: body.lat,
      lon: body.lon,
      hr: body.hr,
      hrv: body.hrv,
      spo2: body.spo2,
      temp: body.temp,
      batt: body.batt,
      flags: body.flags,
    });
    let rawHex: string;
    if (body.raw_hex) {
      try {
        const supplied = parseHex(body.raw_hex);
        if (supplied.length !== PAYLOAD_LEN) {
          throw new HttpException(
            `telemetry payload must be ${PAYLOAD_LEN} bytes, got ${supplied.length}`,
            400,
          );
        }
        rawHex = supplied.toString('hex');
      } catch (exc: any) {
        if (exc instanceof HttpException) throw exc;
        throw new HttpException(String(exc.message || exc), 400);
      }
    } else {
      rawHex = packed.toString('hex');
    }
    return this.save(
      makeRecord({
        category: 'TELEMETRY',
        data_type: 'SOLDIER_TELEMETRY',
        entity_type: 'SOLDIER',
        entity_id: String(body.soldier_id),
        soldier_id: body.soldier_id,
        group_id: body.group_id,
        gateway_id: body.gateway_id,
        event_time: eventTime,
        received_at: this.received(body.received_at),
        position_source: (data.flags as any).position_source,
        transport: body.transport || 'MESH',
        freshness: body.freshness || 'FRESH',
        severity: null,
        record_origin: this.origin(body.record_origin),
        raw_format: 'PAYLOAD_21',
        raw_hex: rawHex,
        data,
      }),
      data,
    );
  }

  @Post('mesh-frame')
  @HttpCode(200)
  meshFrame(@Body() body: any) {
    let frame: ReturnType<typeof decodeMeshFrame>;
    try {
      frame = decodeMeshFrame(parseHex(body.frame_hex));
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
    const payload = frame.payload;
    const data: Record<string, unknown> = {
      source_id: payload.soldier_id,
      seq: payload.seq,
      ver_type: frame.ver_type,
      ttl: frame.ttl,
      hop_count: frame.hop_count,
      payload_length: frame.payload_length,
      payload: soldierPayloadAsData(payload),
    };
    for (const [key, value] of [
      ['rssi', body.rssi],
      ['snr', body.snr],
      ['pdr', body.pdr],
      ['spreading_factor', body.spreading_factor],
      ['tx_power_dbm', body.tx_power_dbm],
    ] as const) {
      if (value != null) data[key] = value;
    }
    return this.save(
      makeRecord({
        category: 'MESH',
        data_type: 'LORA_FRAME',
        entity_type: 'SOLDIER',
        entity_id: String(payload.soldier_id),
        soldier_id: payload.soldier_id,
        group_id: body.group_id,
        gateway_id: body.gateway_id,
        event_time: this.clock(String(payload.timestamp))[0],
        received_at: this.received(body.received_at),
        position_source: positionFromFlags(payload.flags),
        transport: 'LORA',
        freshness: body.freshness || 'FRESH',
        severity: null,
        record_origin: this.origin(body.record_origin),
        raw_format: 'FRAME_25',
        raw_hex: frame.raw.toString('hex'),
        data,
      }),
      data.payload as Record<string, unknown>,
    );
  }

  @Post('uplink')
  @HttpCode(200)
  uplink(@Body() body: any) {
    const allowedModes = new Set(['LIVE', 'STORE_AND_CARRY', 'RETRY', 'UNKNOWN']);
    if (!allowedModes.has(body.delivery_mode)) {
      throw new HttpException(
        `delivery_mode must be one of ${[...allowedModes].join(', ')}`,
        422,
      );
    }
    const [sentAt] = this.clock(body.sent_at);
    const receivedAt = this.received(body.received_at);
    return this.save(
      makeRecord({
        category: 'UPLINK',
        data_type: 'SATELLITE_UPLINK',
        entity_type: 'GATEWAY',
        entity_id: body.gateway_id,
        soldier_id: null,
        group_id: body.group_id,
        gateway_id: body.gateway_id,
        event_time: sentAt,
        received_at: receivedAt,
        position_source: null,
        transport: 'SATELLITE',
        freshness: body.delivery_mode === 'STORE_AND_CARRY' ? 'STALE' : 'FRESH',
        severity: null,
        record_origin: this.origin(body.record_origin),
        raw_format: 'HEX',
        raw_hex: body.raw_hex,
        data: {
          gateway_id: body.gateway_id,
          burst_id: body.burst_id,
          packet_count: body.packet_count,
          payload_size_bytes: body.payload_size_bytes,
          sent_at: sentAt,
          received_at: receivedAt,
          delivery_status: body.delivery_status,
          retry_count: body.retry_count,
          session_duration_seconds: body.session_duration_seconds,
          delivery_mode: body.delivery_mode,
        },
      }),
    );
  }

  @Post('beacon')
  @HttpCode(200)
  beacon(@Body() body: any) {
    const [eventTime] = this.clock(body.timestamp);
    return this.save(
      makeRecord({
        category: 'BEACON',
        data_type: 'BEACON_OBSERVATION',
        entity_type: 'BEACON',
        entity_id: body.beacon_id,
        soldier_id: null,
        group_id: body.group_id,
        gateway_id: body.gateway_id,
        beacon_id: body.beacon_id,
        event_time: eventTime,
        received_at: this.received(body.timestamp),
        position_source: null,
        transport: 'LORA',
        freshness: 'FRESH',
        severity: null,
        record_origin: this.origin(body.record_origin),
        raw_format: 'HEX',
        raw_hex: body.raw_hex,
        data: {
          beacon_id: body.beacon_id,
          observer_id: body.observer_id,
          rssi: body.rssi,
          timestamp: eventTime,
        },
      }),
    );
  }

  @Post('special')
  @HttpCode(200)
  special(@Body() body: any) {
    try {
      parseHex(body.payload_hex);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }
    const [eventTime] = this.clock(body.event_time);
    return this.save(
      makeRecord({
        category: 'SPECIAL',
        data_type: body.special_type,
        entity_type: 'SOLDIER',
        entity_id: String(body.soldier_id),
        soldier_id: body.soldier_id,
        group_id: body.group_id,
        gateway_id: body.gateway_id,
        event_time: eventTime,
        received_at: this.received(body.received_at),
        position_source: null,
        transport: body.transport,
        freshness: 'FRESH',
        severity: null,
        record_origin: this.origin(body.record_origin),
        raw_format: 'OPAQUE',
        raw_hex: body.payload_hex,
        data: {
          special_type: body.special_type,
          soldier_id: body.soldier_id,
          metadata: body.metadata || {},
        },
      }),
    );
  }

  @Post('system')
  @HttpCode(200)
  system(@Body() body: any) {
    const [eventTime] = this.clock(body.event_time);
    const soldierId =
      body.entity_type === 'SOLDIER' && /^\d+$/.test(body.entity_id)
        ? Number(body.entity_id)
        : null;
    return this.save(
      makeRecord({
        category: 'SYSTEM',
        data_type: body.event_type,
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        soldier_id: soldierId,
        group_id: body.group_id,
        gateway_id: body.gateway_id,
        event_time: eventTime,
        received_at: this.received(body.received_at),
        position_source: null,
        transport: null,
        freshness: body.freshness || 'FRESH',
        severity: body.severity,
        record_origin: this.origin(body.record_origin),
        raw_format: 'JSON',
        raw_hex: null,
        data: {
          event_type: body.event_type,
          entity_type: body.entity_type,
          entity_id: body.entity_id,
          details: body.details || {},
        },
      }),
    );
  }
}
