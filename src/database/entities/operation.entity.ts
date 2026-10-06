import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for operations — schema owned by DatabaseService.initDb(). */
@Entity('operations')
export class Operation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
