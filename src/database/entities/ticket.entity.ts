import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for tickets — schema owned by DatabaseService.initDb(). */
@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
