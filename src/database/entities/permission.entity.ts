import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for permissions — schema owned by DatabaseService.initDb(). */
@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
