import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum SyncType {
  BATCH = 'BATCH',
  WEBHOOK = 'WEBHOOK',
  SCHEDULED = 'SCHEDULED',
}

export enum SyncLogStatus {
  STARTED = 'STARTED',
  DONE = 'DONE',
  FAILED = 'FAILED',
}

@Entity('sync_log')
export class SyncLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  syncType: SyncType;

  @Column()
  triggeredBy: string;

  @Column({ default: SyncLogStatus.STARTED })
  status: SyncLogStatus;

  @Column({ default: 0 })
  recordsProcessed: number;

  @Column({ default: 0 })
  discrepancies: number;

  @Column({ nullable: true, type: 'text' })
  errorDetail: string;

  @Column({ type: 'datetime' })
  startedAt: Date;

  @Column({ nullable: true, type: 'datetime' })
  completedAt: Date;
}
