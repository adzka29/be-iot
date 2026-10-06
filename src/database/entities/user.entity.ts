import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for users — schema owned by DatabaseService.initDb(). */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
