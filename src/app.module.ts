import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IngestModule } from './ingest/ingest.module';
import { ExplorerModule } from './explorer/explorer.module';
import { AlertsModule } from './alerts/alerts.module';
import { HistoryModule } from './history/history.module';
import { GeofencesModule } from './geofences/geofences.module';
import { PersonnelModule } from './personnel/personnel.module';
import { UsersModule } from './users/users.module';
import { ProfileModule } from './profile/profile.module';
import { RolesModule } from './roles/roles.module';
import { BindingsModule } from './bindings/bindings.module';
import { AuditModule } from './audit/audit.module';
import { TicketsModule } from './tickets/tickets.module';
import { OperationsModule } from './operations/operations.module';
import { SimulatorModule } from './simulator/simulator.module';

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    IngestModule,
    ExplorerModule,
    AlertsModule,
    HistoryModule,
    GeofencesModule,
    PersonnelModule,
    UsersModule,
    ProfileModule,
    RolesModule,
    BindingsModule,
    AuditModule,
    TicketsModule,
    OperationsModule,
    SimulatorModule,
  ],
})
export class AppModule {}
