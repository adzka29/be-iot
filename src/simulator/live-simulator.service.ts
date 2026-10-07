import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { runRetentionIfDue } from '../database/retention';
import {
  generateLiveTick,
  SEED_INTERVAL_MS,
  seedTickCount,
} from '../database/seed-explorer';

/**
 * Continues the unified SYNAPSE-T simulator after seed:
 * 15 soldiers × 1 packet / 30s = 30 TELEMETRY records / minute.
 *
 * Always uses wall-clock timestamps so UI jam stays current.
 * Disable with TRACKFORGE_LIVE_SIM=0 (tests do this).
 */
@Injectable()
export class LiveSimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveSimulatorService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private tickIndex = 0;
  private lastEmittedBucket = 0;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.TRACKFORGE_SEED === '0') return;
    if (process.env.TRACKFORGE_LIVE_SIM === '0') return;

    this.tickIndex = this.resolveStartTick();
    const now = Date.now();
    const lastSimMs = this.maxSimulatedEventMs();
    const staleMs = lastSimMs > 0 ? now - lastSimMs : 0;

    // Allow an immediate tick (same 30s bucket would otherwise no-op).
    this.lastEmittedBucket = this.wallBucket(now) - SEED_INTERVAL_MS;

    this.log.log(
      `Live simulator on — tick=${this.tickIndex}, every ${SEED_INTERVAL_MS / 1000}s (wall clock)` +
        (staleMs > SEED_INTERVAL_MS * 2
          ? `, stale=${Math.round(staleMs / 60000)}m → catch-up`
          : ''),
    );

    if (staleMs > SEED_INTERVAL_MS * 2) {
      this.catchUp(now);
    }

    setTimeout(() => this.tick(), 1_000);
    this.timer = setInterval(() => this.tick(), SEED_INTERVAL_MS);
    this.retentionTimer = setInterval(
      () => runRetentionIfDue(this.db.connection),
      60 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.timer = null;
    this.retentionTimer = null;
  }

  private wallBucket(ms: number): number {
    return ms - (ms % SEED_INTERVAL_MS);
  }

  private maxSimulatedEventMs(): number {
    const row = this.db.connection
      .prepare(
        `
        SELECT MAX(event_time) AS t
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND record_origin = 'SIMULATED'
        `,
      )
      .get() as { t: string | null };
    if (!row?.t) return 0;
    const ms = Date.parse(row.t);
    return Number.isFinite(ms) ? ms : 0;
  }

  /** Emit a short burst of recent wall-clock ticks so dashboards are not stuck on old seed. */
  private catchUp(now: number) {
    const bursts = Math.min(
      20,
      Math.max(2, Number(process.env.TRACKFORGE_LIVE_CATCHUP_TICKS || 10)),
    );
    let bucket = this.wallBucket(now) - bursts * SEED_INTERVAL_MS;
    for (let i = 0; i < bursts; i += 1) {
      bucket += SEED_INTERVAL_MS;
      if (bucket > now) break;
      try {
        generateLiveTick(this.db.connection, this.tickIndex, bucket);
        this.tickIndex += 1;
        this.lastEmittedBucket = bucket;
      } catch (err) {
        this.log.warn(`Live simulator catch-up failed: ${String(err)}`);
        break;
      }
    }
    this.log.log(`Live simulator catch-up wrote ${bursts} tick(s)`);
  }

  private resolveStartTick(): number {
    const row = this.db.connection
      .prepare(
        `
        SELECT MAX(event_time) AS t
        FROM explorer_records
        WHERE category = 'TELEMETRY' AND record_origin = 'SIMULATED'
        `,
      )
      .get() as { t: string | null };
    if (!row?.t) return seedTickCount();
    const n = (
      this.db.connection
        .prepare(
          `SELECT COUNT(*) AS n FROM explorer_records
           WHERE category = 'TELEMETRY' AND record_origin = 'SIMULATED'
             AND soldier_id = 101`,
        )
        .get() as any
    ).n as number;
    return Math.max(seedTickCount(), n);
  }

  private tick() {
    try {
      const bucket = this.wallBucket(Date.now());
      if (bucket <= this.lastEmittedBucket) return;
      this.lastEmittedBucket = bucket;
      generateLiveTick(this.db.connection, this.tickIndex, bucket);
      this.tickIndex += 1;
      runRetentionIfDue(this.db.connection);
    } catch (err) {
      this.log.warn(`Live simulator tick failed: ${String(err)}`);
    }
  }
}
