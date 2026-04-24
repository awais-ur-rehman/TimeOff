import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OutboxEvent, OutboxEventStatus } from './outbox/outbox.entity';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
  ) {}

  @Get()
  async check(): Promise<{ status: string; dbConnected: boolean; outboxQueueDepth: number }> {
    let dbConnected = false;
    try {
      await this.dataSource.query('SELECT 1');
      dbConnected = true;
    } catch {
    }

    const outboxQueueDepth = await this.outboxRepo.count({
      where: { status: OutboxEventStatus.PENDING },
    });

    return { status: 'ok', dbConnected, outboxQueueDepth };
  }
}
