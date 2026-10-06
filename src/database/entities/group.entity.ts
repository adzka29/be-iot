import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for groups — schema owned by DatabaseService.initDb(). */
@Entity('groups')
export class Group {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
