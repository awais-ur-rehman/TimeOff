import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { SyncService } from './sync.service';
import { BatchSyncDto } from './dto/batch-sync.dto';
import { WebhookSyncDto } from './dto/webhook-sync.dto';

type AuthReq = Request & { user: RequestUser };

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly configService: ConfigService,
  ) {}

  @Post('batch')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async batch(@Body() dto: BatchSyncDto, @Req() req: AuthReq) {
    if (req.user.role !== 'admin') {
      throw new ForbiddenException('Admin role required');
    }
    return this.syncService.processBatchPayload(dto.records);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(
    @Headers('x-hcm-secret') secret: string | undefined,
    @Body() dto: WebhookSyncDto,
  ): Promise<void> {
    const expected = this.configService.get<string>('HCM_SECRET');
    if (!secret || secret !== expected) {
      throw new UnauthorizedException('Invalid or missing x-hcm-secret header');
    }
    await this.syncService.processWebhookPayload(dto);
  }

  @Post('trigger')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async trigger(@Req() req: AuthReq) {
    if (req.user.role !== 'admin') {
      throw new ForbiddenException('Admin role required');
    }
    return this.syncService.triggerReconciliation();
  }

  @Get('status')
  @UseGuards(AuthGuard)
  async status(@Req() req: AuthReq) {
    if (req.user.role !== 'admin') {
      throw new ForbiddenException('Admin role required');
    }
    return this.syncService.getSyncStatus();
  }
}
