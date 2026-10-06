import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for ticket_collaborators — schema owned by DatabaseService.initDb(). */
@Entity('ticket_collaborators')
export class TicketCollaborator {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
