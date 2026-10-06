import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for roles — schema owned by DatabaseService.initDb(). */
@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
