import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { OutboxEventType } from '../common/enums/outbox-event-type.enum';

export enum OutboxEventStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DONE = 'DONE',
  FAILED = 'FAILED',
}

@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  eventType: OutboxEventType;

  @Column('text')
  payload: string;

  @Column({ default: OutboxEventStatus.PENDING })
  status: OutboxEventStatus;

  @Column({ default: 0 })
  attempts: number;

  @Column({ nullable: true, type: 'datetime' })
  nextRetryAt: Date;

  @Column()
  requestId: number;

  @CreateDateColumn()
  createdAt: Date;
}
