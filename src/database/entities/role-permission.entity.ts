import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** TypeORM stub for role_permissions — schema owned by DatabaseService.initDb(). */
@Entity('role_permissions')
export class RolePermission {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', nullable: true })
  _stub?: string;
}
