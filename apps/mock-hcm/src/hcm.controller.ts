import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { HcmService } from './hcm.service';

@Controller('hcm')
export class HcmController {
  constructor(private readonly hcmService: HcmService) {}

  @Get('balances/:employeeId/:locationId/:leaveType')
  getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveType') leaveType: string,
  ) {
    return this.hcmService.getBalance(employeeId, locationId, leaveType);
  }

  @Post('balances/batch')
  getAllBalances() {
    return this.hcmService.getAllBalances();
  }

  @Post('balances/seed')
  @HttpCode(HttpStatus.CREATED)
  seedBalance(
    @Body() body: { employeeId: number; locationId: string; leaveType: string; totalDays: number },
  ) {
    this.hcmService.seedBalance(body.employeeId, body.locationId, body.leaveType, body.totalDays);
    return { ok: true };
  }

  @Post('requests')
  deductBalance(
    @Body() body: { employeeId: number; locationId: string; leaveType: string; days: number },
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Res() res: Response,
  ): void {
    if (this.hcmService.shouldSimulateError()) {
      throw new InternalServerErrorException('Simulated HCM error');
    }
    const result = this.hcmService.deductBalance(
      body.employeeId,
      body.locationId,
      body.leaveType,
      body.days,
      idempotencyKey,
    );
    res.status(result.statusCode).json({ hcmRequestId: result.hcmRequestId });
  }

  @Delete('requests/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  reverseDeduction(@Param('id') id: string): void {
    this.hcmService.reverseDeduction(id);
  }

  @Get('requests/:id')
  getDeduction(@Param('id') id: string) {
    return this.hcmService.getDeduction(id);
  }

  @Post('simulate/anniversary/:employeeId')
  simulateAnniversary(
    @Param('employeeId') employeeId: string,
    @Body() body: { bonusDays: number },
  ) {
    this.hcmService.simulateAnniversary(employeeId, body.bonusDays);
    return { ok: true };
  }

  @Post('simulate/error-rate')
  setErrorRate() {
    return { ok: true };
  }

  @Delete('state')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetState(): void {
    this.hcmService.reset();
  }

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
