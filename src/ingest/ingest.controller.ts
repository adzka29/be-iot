import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import { raiseAlerts } from '../database/alert-rules';
import {
  decodeSatelliteBurst,
  parseHex,
  positionFromFlags,
  soldierPayloadAsData,
} from '../mesh/frame';
import { makeRecord, parseEventTime, utcNow } from '../common/records';
import { resolveGroupName } from '../database/personnel';

/**
 * Sole public telemetry ingress.
 * Field → LoRa Mesh → Gateway → Satellite Burst → POST /api/ingest
 */
@Controller('api/ingest')
export class IngestController {
  constructor(private readonly db: DatabaseService) {}

  /** Organizational group from Personnel master — not from wire packet. */
  private enrichGroup(soldierId?: number | null): string | null {
    return resolveGroupName(this.db.connection, soldierId ?? null);
  }

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

  private save(
    record: Record<string, unknown>,
    soldierPayload?: Record<string, unknown>,
  ) {
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

  private parseBurstBytes(body: any): Buffer {
    const hex = body?.burst_hex ?? body?.raw_hex;
    if (hex) {
      try {
        return parseHex(String(hex));
      } catch (exc: any) {
        throw new HttpException(String(exc.message || exc), 400);
      }
    }
    if (body?.burst_base64) {
      try {
        const buf = Buffer.from(String(body.burst_base64), 'base64');
        if (!buf.length) throw new Error('burst_base64 is empty');
        return buf;
      } catch (exc: any) {
        throw new HttpException(String(exc.message || exc), 400);
      }
    }
    throw new HttpException(
      'burst_hex, raw_hex, or burst_base64 is required',
      422,
    );
  }

  /**
   * Satellite burst: 6-byte header + N×21-byte soldier payloads.
   * Stores raw burst as transport audit (UPLINK/SATELLITE_BURST), then one
   * TELEMETRY explorer record per soldier with alerts from flags.
   */
  @Post()
  @HttpCode(200)
  satelliteBurst(@Body() body: any) {
    const raw = this.parseBurstBytes(body);
    let burst: ReturnType<typeof decodeSatelliteBurst>;
    try {
      burst = decodeSatelliteBurst(raw);
    } catch (exc: any) {
      throw new HttpException(String(exc.message || exc), 400);
    }

    const receivedAt = this.received(body.received_at);
    const gatewayId = body.gateway_id ?? null;
    const burstId =
      (body.burst_id && String(body.burst_id).trim()) ||
      `burst-${burst.header_hex}-${crypto.randomBytes(4).toString('hex')}`;
    const origin = this.origin(body.record_origin);

    const burstRecord = makeRecord({
      category: 'UPLINK',
      data_type: 'SATELLITE_BURST',
      entity_type: 'GATEWAY',
      entity_id: gatewayId != null ? String(gatewayId) : burstId,
      soldier_id: null,
      group_id: null,
      gateway_id: gatewayId,
      event_time: receivedAt,
      received_at: receivedAt,
      position_source: null,
      transport: 'SATELLITE',
      freshness: body.freshness || 'FRESH',
      severity: null,
      record_origin: origin,
      raw_format: 'SATELLITE_BURST',
      raw_hex: burst.raw.toString('hex'),
      data: {
        burst_id: burstId,
        header_hex: burst.header_hex,
        soldier_count: burst.soldier_count,
        payload_size_bytes: burst.raw.length,
        gateway_id: gatewayId,
      },
    });
    const burstRecordId = this.db.insertRecord(burstRecord);

    const records: Record<string, unknown>[] = [];
    for (const item of burst.payloads) {
      const payload = item.decoded;
      const data = {
        ...soldierPayloadAsData(payload),
        burst_id: burstId,
        burst_record_id: burstRecordId,
        burst_index: item.index,
      };
      const [eventTime] = this.clock(payload.timestamp);
      const groupId = this.enrichGroup(payload.soldier_id);
      const saved = this.save(
        makeRecord({
          category: 'TELEMETRY',
          data_type: 'SOLDIER_TELEMETRY',
          entity_type: 'SOLDIER',
          entity_id: String(payload.soldier_id),
          soldier_id: payload.soldier_id,
          group_id: groupId,
          gateway_id: gatewayId,
          event_time: eventTime,
          received_at: receivedAt,
          position_source: positionFromFlags(payload.flags),
          transport: 'SATELLITE',
          freshness: body.freshness || 'FRESH',
          severity: null,
          record_origin: origin,
          raw_format: 'PAYLOAD_21',
          raw_hex: item.raw_hex,
          data,
        }),
        data,
      );
      records.push(saved);
    }

    const burstRow = this.db.getRecord(burstRecordId);
    return {
      burst: burstRow ? this.db.recordToApi(burstRow) : null,
      burst_id: burstId,
      soldier_count: records.length,
      records,
    };
  }
}
