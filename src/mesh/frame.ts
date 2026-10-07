export const POSITION_SOURCES = [
  'GNSS',
  'DEAD_RECKONING',
  'TRILATERATION',
  'STALE',
] as const;

export const HEADER_LEN = 4;
export const PAYLOAD_LEN = 21;
export const FRAME_LEN = HEADER_LEN + PAYLOAD_LEN;

/** Satellite burst: opaque 6-byte transport header + N × 21-byte soldier payloads. */
export const BURST_HEADER_LEN = 6;
export const MAX_BURST_SOLDIERS = 15;

export type DecodedFlags = {
  raw: number;
  sos: boolean;
  casualty: boolean;
  arrhythmia: boolean;
  position_source: (typeof POSITION_SOURCES)[number];
  strap_connected: boolean;
  low_battery: boolean;
  heat_stress: boolean;
};

export type SoldierPayload = {
  soldier_id: number;
  seq: number;
  timestamp: number;
  lat: number;
  lon: number;
  hr: number;
  hrv: number;
  spo2: number;
  temp: number;
  batt: number;
  flags: number;
};

export type MeshFrame = {
  ver_type: number;
  ttl: number;
  hop_count: number;
  payload_length: number;
  payload: SoldierPayload;
  raw: Buffer;
};

function writeU16LE(buf: Buffer, offset: number, value: number) {
  buf.writeUInt16LE(value & 0xffff, offset);
}

function writeI32LE(buf: Buffer, offset: number, value: number) {
  buf.writeInt32LE(value | 0, offset);
}

function writeU32LE(buf: Buffer, offset: number, value: number) {
  buf.writeUInt32LE(value >>> 0, offset);
}

export function encodeFlags(opts: {
  sos?: boolean;
  casualty?: boolean;
  arrhythmia?: boolean;
  position?: string;
  strap?: boolean;
  low_battery?: boolean;
  heat_stress?: boolean;
}): number {
  const position = opts.position ?? 'GNSS';
  let value = POSITION_SOURCES.indexOf(position as any) << 3;
  if (opts.sos) value |= 0b1;
  if (opts.casualty) value |= 0b10;
  if (opts.arrhythmia) value |= 0b100;
  if (opts.strap ?? true) value |= 1 << 5;
  if (opts.low_battery) value |= 1 << 6;
  if (opts.heat_stress) value |= 1 << 7;
  return value;
}

export function decodeFlags(flags: number): DecodedFlags {
  return {
    raw: flags,
    sos: Boolean(flags & 0b1),
    casualty: Boolean(flags & 0b10),
    arrhythmia: Boolean(flags & 0b100),
    position_source: POSITION_SOURCES[(flags >> 3) & 0b11],
    strap_connected: Boolean(flags & (1 << 5)),
    low_battery: Boolean(flags & (1 << 6)),
    heat_stress: Boolean(flags & (1 << 7)),
  };
}

export function positionFromFlags(flags: number): string {
  return decodeFlags(flags).position_source;
}

export function degreesToE7(degrees: number): number {
  return Math.round(degrees * 10_000_000);
}

function degreesFromE7(e7: number): number {
  return Math.round((e7 / 10_000_000) * 1e7) / 1e7;
}

export function parseHex(rawHex: string): Buffer {
  const cleaned = rawHex.trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!cleaned || cleaned.length % 2 !== 0) {
    throw new Error('hex must be an even-length hexadecimal string');
  }
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error('hex is not hexadecimal');
  }
  return Buffer.from(cleaned, 'hex');
}

export function packPayload(opts: {
  soldier_id: number;
  seq: number;
  timestamp: number;
  lat: number;
  lon: number;
  hr: number;
  hrv: number;
  spo2: number;
  temp: number;
  batt: number;
  flags: number;
}): Buffer {
  // Struct "<HBIiiBBBBBB" : H(2) B(1) I(4) i(4) i(4) B B B B B B = 21
  const buf = Buffer.alloc(PAYLOAD_LEN);
  writeU16LE(buf, 0, opts.soldier_id);
  buf.writeUInt8(opts.seq & 0xff, 2);
  writeU32LE(buf, 3, opts.timestamp);
  writeI32LE(buf, 7, degreesToE7(opts.lat));
  writeI32LE(buf, 11, degreesToE7(opts.lon));
  buf.writeUInt8(opts.hr & 0xff, 15);
  buf.writeUInt8(opts.hrv & 0xff, 16);
  buf.writeUInt8(opts.spo2 & 0xff, 17);
  buf.writeUInt8(opts.temp & 0xff, 18);
  buf.writeUInt8(opts.batt & 0xff, 19);
  buf.writeUInt8(opts.flags & 0xff, 20);
  return buf;
}

export function packMeshFrame(
  verType: number,
  ttl: number,
  hopCount: number,
  payload: Buffer,
): Buffer {
  if (payload.length !== PAYLOAD_LEN) {
    throw new Error(
      `soldier payload must be ${PAYLOAD_LEN} bytes, got ${payload.length}`,
    );
  }
  return Buffer.concat([
    Buffer.from([verType & 0xff, ttl & 0xff, hopCount & 0xff, PAYLOAD_LEN]),
    payload,
  ]);
}

export function decodePayload(payload: Buffer): SoldierPayload {
  if (payload.length !== PAYLOAD_LEN) {
    throw new Error(
      `soldier payload must be ${PAYLOAD_LEN} bytes, got ${payload.length}`,
    );
  }
  return {
    soldier_id: payload.readUInt16LE(0),
    seq: payload.readUInt8(2),
    timestamp: payload.readUInt32LE(3),
    lat: degreesFromE7(payload.readInt32LE(7)),
    lon: degreesFromE7(payload.readInt32LE(11)),
    hr: payload.readUInt8(15),
    hrv: payload.readUInt8(16),
    spo2: payload.readUInt8(17),
    temp: payload.readUInt8(18),
    batt: payload.readUInt8(19),
    flags: payload.readUInt8(20),
  };
}

export function decodeMeshFrame(raw: Buffer): MeshFrame {
  if (raw.length !== FRAME_LEN) {
    throw new Error(
      `mesh frame must be ${FRAME_LEN} bytes (4-byte header + 21-byte payload), got ${raw.length}`,
    );
  }
  const ver_type = raw[0];
  const ttl = raw[1];
  const hop_count = raw[2];
  const payload_length = raw[3];
  if (payload_length !== PAYLOAD_LEN) {
    throw new Error(`payload_len must be ${PAYLOAD_LEN}, got ${payload_length}`);
  }
  return {
    ver_type,
    ttl,
    hop_count,
    payload_length,
    payload: decodePayload(raw.subarray(HEADER_LEN)),
    raw,
  };
}

export function soldierPayloadAsData(payload: SoldierPayload): Record<string, unknown> {
  const flags = decodeFlags(payload.flags);
  const data: Record<string, unknown> = {
    soldier_id: payload.soldier_id,
    seq: payload.seq,
    timestamp: payload.timestamp,
    lat: payload.lat,
    lon: payload.lon,
    hr: payload.hr,
    hrv: payload.hrv,
    spo2: payload.spo2,
    temp: payload.temp,
    batt: payload.batt,
    flags,
  };
  if (!flags.strap_connected) {
    data.vital = 'TANPA VITAL';
  }
  return data;
}

export type SatelliteBurst = {
  /** Original burst bytes (header + payloads), preserved as-is. */
  raw: Buffer;
  header: Buffer;
  header_hex: string;
  soldier_count: number;
  payloads: Array<{
    index: number;
    raw: Buffer;
    raw_hex: string;
    decoded: SoldierPayload;
  }>;
};

/**
 * Decode a satellite burst: 6-byte header + N×21-byte soldier payloads.
 * N is derived from length so we do not invent undocumented header fields.
 * Theoretical max N = 15.
 */
export function decodeSatelliteBurst(raw: Buffer): SatelliteBurst {
  if (raw.length < BURST_HEADER_LEN + PAYLOAD_LEN) {
    throw new Error(
      `satellite burst must be at least ${BURST_HEADER_LEN + PAYLOAD_LEN} bytes (6-byte header + one 21-byte payload), got ${raw.length}`,
    );
  }
  const bodyLen = raw.length - BURST_HEADER_LEN;
  if (bodyLen % PAYLOAD_LEN !== 0) {
    throw new Error(
      `satellite burst body must be a multiple of ${PAYLOAD_LEN} bytes after the ${BURST_HEADER_LEN}-byte header, got ${bodyLen}`,
    );
  }
  const soldier_count = bodyLen / PAYLOAD_LEN;
  if (soldier_count < 1 || soldier_count > MAX_BURST_SOLDIERS) {
    throw new Error(
      `satellite burst soldier count must be 1–${MAX_BURST_SOLDIERS}, got ${soldier_count}`,
    );
  }
  const header = Buffer.from(raw.subarray(0, BURST_HEADER_LEN));
  const payloads: SatelliteBurst['payloads'] = [];
  for (let index = 0; index < soldier_count; index += 1) {
    const start = BURST_HEADER_LEN + index * PAYLOAD_LEN;
    const slice = Buffer.from(raw.subarray(start, start + PAYLOAD_LEN));
    payloads.push({
      index,
      raw: slice,
      raw_hex: slice.toString('hex'),
      decoded: decodePayload(slice),
    });
  }
  return {
    raw: Buffer.from(raw),
    header,
    header_hex: header.toString('hex'),
    soldier_count,
    payloads,
  };
}

/** Build a burst for tests/tools: opaque 6-byte header + packed payloads. */
export function packSatelliteBurst(
  payloads: Buffer[],
  header?: Buffer,
): Buffer {
  if (!payloads.length || payloads.length > MAX_BURST_SOLDIERS) {
    throw new Error(
      `satellite burst must contain 1–${MAX_BURST_SOLDIERS} soldier payloads`,
    );
  }
  for (const payload of payloads) {
    if (payload.length !== PAYLOAD_LEN) {
      throw new Error(
        `soldier payload must be ${PAYLOAD_LEN} bytes, got ${payload.length}`,
      );
    }
  }
  const hdr =
    header && header.length === BURST_HEADER_LEN
      ? Buffer.from(header)
      : Buffer.alloc(BURST_HEADER_LEN, 0);
  if (header && header.length !== BURST_HEADER_LEN) {
    throw new Error(
      `burst header must be ${BURST_HEADER_LEN} bytes, got ${header.length}`,
    );
  }
  return Buffer.concat([hdr, ...payloads]);
}
