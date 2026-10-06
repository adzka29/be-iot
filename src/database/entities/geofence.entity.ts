import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for geofences — schema owned by DatabaseService.initDb(). */
@Entity('geofences')
export class Geofence {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
