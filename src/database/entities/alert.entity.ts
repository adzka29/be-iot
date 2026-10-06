import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for alerts — schema owned by DatabaseService.initDb(). */
@Entity('alerts')
export class Alert {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
