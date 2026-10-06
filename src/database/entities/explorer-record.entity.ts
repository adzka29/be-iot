import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for explorer_records — schema owned by DatabaseService.initDb(). */
@Entity('explorer_records')
export class ExplorerRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
