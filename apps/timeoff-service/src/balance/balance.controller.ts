import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { BalanceService } from './balance.service';

@Controller('balances')
@UseGuards(AuthGuard)
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId')
  async getByEmployee(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Req() req: Request & { user: RequestUser },
  ) {
    this.enforceAccess(req.user, employeeId);
    return this.balanceService.getByEmployee(employeeId);
  }

  @Get(':employeeId/:locationId')
  async getByEmployeeAndLocation(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('locationId') locationId: string,
    @Req() req: Request & { user: RequestUser },
  ) {
    this.enforceAccess(req.user, employeeId);
    return this.balanceService.getByEmployeeAndLocation(employeeId, locationId);
  }

  private enforceAccess(user: RequestUser, targetEmployeeId: number): void {
    if (user.role === 'admin' || user.role === 'manager') return;
    if (user.employeeId !== targetEmployeeId) {
      throw new ForbiddenException('Employees can only access their own balance data');
    }
  }
}
