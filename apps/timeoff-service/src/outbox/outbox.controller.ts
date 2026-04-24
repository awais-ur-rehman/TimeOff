import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { OutboxEvent, OutboxEventStatus } from './outbox.entity';

type AuthReq = Request & { user: RequestUser };

@Controller('outbox')
@UseGuards(AuthGuard)
export class OutboxController {
  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
  ) {}

  @Get()
  async list(@Query('status') status: string | undefined, @Req() req: AuthReq) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin role required');

    const where = status ? { status: status as OutboxEventStatus } : {};
    return this.outboxRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  @Post(':id/retry')
  async retry(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin role required');

    const event = await this.outboxRepo.findOne({ where: { id } });
    if (!event) throw new NotFoundException(`Outbox event ${id} not found`);
    if (event.status !== OutboxEventStatus.FAILED) {
      throw new BadRequestException(`Event ${id} is not in FAILED state (current: ${event.status})`);
    }

    await this.outboxRepo.update(id, {
      status: OutboxEventStatus.PENDING,
      nextRetryAt: new Date(),
    });

    return { id, status: OutboxEventStatus.PENDING };
  }
}
