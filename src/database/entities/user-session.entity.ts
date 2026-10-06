import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for user_sessions — schema owned by DatabaseService.initDb(). */
@Entity('user_sessions')
export class UserSession {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
