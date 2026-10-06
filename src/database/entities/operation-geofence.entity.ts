import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for operation_geofences — schema owned by DatabaseService.initDb(). */
@Entity('operation_geofences')
export class OperationGeofence {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
