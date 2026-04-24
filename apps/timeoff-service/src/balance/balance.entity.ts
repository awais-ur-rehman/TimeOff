import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('leave_balances')
@Unique(['employeeId', 'locationId', 'leaveType'])
export class LeaveBalance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  employeeId: number;

  @Column()
  locationId: string;

  @Column()
  leaveType: string;

  @Column('decimal', { precision: 5, scale: 1, default: 0 })
  totalDays: number;

  @Column('decimal', { precision: 5, scale: 1, default: 0 })
  usedDays: number;

  @Column('decimal', { precision: 5, scale: 1, default: 0 })
  reservedDays: number;

  @Column({ nullable: true, type: 'datetime' })
  lastSyncedAt: Date;

  @Column({ nullable: true })
  hcmVersion: string;

  @Column({ default: 0 })
  version: number;
}
