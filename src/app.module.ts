import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IngestModule } from './ingest/ingest.module';
import { ExplorerModule } from './explorer/explorer.module';
import { AlertsModule } from './alerts/alerts.module';
import { HistoryModule } from './history/history.module';
import { GeofencesModule } from './geofences/geofences.module';
import { UsersModule } from './users/users.module';
import { ProfileModule } from './profile/profile.module';
import { RolesModule } from './roles/roles.module';
import { BindingsModule } from './bindings/bindings.module';
import { AuditModule } from './audit/audit.module';
import { TicketsModule } from './tickets/tickets.module';
import { OperationsModule } from './operations/operations.module';

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    IngestModule,
    ExplorerModule,
    AlertsModule,
    HistoryModule,
    GeofencesModule,
    UsersModule,
    ProfileModule,
    RolesModule,
    BindingsModule,
    AuditModule,
    TicketsModule,
    OperationsModule,
  ],
})
export class AppModule {}
