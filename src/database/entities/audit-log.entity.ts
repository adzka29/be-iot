import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for audit_logs — schema owned by DatabaseService.initDb(). */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
