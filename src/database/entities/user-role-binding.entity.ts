import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for user_role_bindings — schema owned by DatabaseService.initDb(). */
@Entity('user_role_bindings')
export class UserRoleBinding {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
