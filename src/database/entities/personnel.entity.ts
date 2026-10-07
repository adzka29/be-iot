import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for personnel — schema owned by DatabaseService.initDb(). */
@Entity('personnel')
export class Personnel {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  soldier_id!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'integer', nullable: true })
  group_id!: number | null;

  @Column({ type: 'text' })
  status!: string;

  @Column({ type: 'text' })
  created_at!: string;

  @Column({ type: 'text' })
  updated_at!: string;
}
