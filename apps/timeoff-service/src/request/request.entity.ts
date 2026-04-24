import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RequestStatus } from '../common/enums/request-status.enum';

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  employeeId: number;

  @Column()
  locationId: string;

  @Column()
  leaveType: string;

  @Column()
  startDate: string;

  @Column()
  endDate: string;

  @Column('decimal', { precision: 5, scale: 1 })
  daysRequested: number;

  @Column({ default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column('integer', { nullable: true })
  managerId: number | null;

  @Column('text', { nullable: true })
  rejectionReason: string | null;

  @Column('text', { nullable: true })
  hcmRequestId: string | null;

  @Column({ default: 0 })
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
