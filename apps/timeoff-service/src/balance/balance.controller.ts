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
import { EmployeeService } from '../employee/employee.service';

@Controller('balances')
@UseGuards(AuthGuard)
export class BalanceController {
  constructor(
    private readonly balanceService: BalanceService,
    private readonly employeeService: EmployeeService,
  ) {}

  @Get(':employeeId')
  async getByEmployee(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Req() req: Request & { user: RequestUser },
  ) {
    await this.enforceAccess(req.user, employeeId);
    return this.balanceService.getByEmployee(employeeId);
  }

  @Get(':employeeId/:locationId')
  async getByEmployeeAndLocation(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('locationId') locationId: string,
    @Req() req: Request & { user: RequestUser },
  ) {
    await this.enforceAccess(req.user, employeeId);
    return this.balanceService.getByEmployeeAndLocation(employeeId, locationId);
  }

  private async enforceAccess(user: RequestUser, targetEmployeeId: number): Promise<void> {
    if (user.role === 'admin') {
      return;
    }
    if (user.role === 'manager') {
      const employee = await this.employeeService.findById(targetEmployeeId);
      if (!user.locationId || employee.locationId !== user.locationId) {
        throw new ForbiddenException('Manager scope does not cover this employee');
      }
      return;
    }
    if (user.employeeId !== targetEmployeeId) {
      throw new ForbiddenException('Employees can only access their own balance data');
    }
  }
}
