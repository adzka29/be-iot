import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for ticket_updates — schema owned by DatabaseService.initDb(). */
@Entity('ticket_updates')
export class TicketUpdate {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
