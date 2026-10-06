import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for ticket_tasks — schema owned by DatabaseService.initDb(). */
@Entity('ticket_tasks')
export class TicketTask {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
