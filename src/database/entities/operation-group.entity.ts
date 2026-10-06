import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for operation_groups — schema owned by DatabaseService.initDb(). */
@Entity('operation_groups')
export class OperationGroup {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
