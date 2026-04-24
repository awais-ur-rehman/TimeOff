import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { RequestUser } from '../interfaces/request-user.interface';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user: RequestUser }>();
    const employeeIdHeader = req.headers['x-employee-id'];
    const roleHeader = req.headers['x-role'];

    if (!employeeIdHeader || !roleHeader) {
      throw new UnauthorizedException('Missing x-employee-id or x-role header');
    }

    const employeeId = parseInt(employeeIdHeader as string, 10);
    if (isNaN(employeeId)) {
      throw new UnauthorizedException('Invalid x-employee-id header');
    }

    const role = roleHeader as string;
    if (!['employee', 'manager', 'admin'].includes(role)) {
      throw new UnauthorizedException('Invalid x-role header value');
    }

    req.user = {
      employeeId,
      role: role as RequestUser['role'],
      locationId: req.headers['x-location-id'] as string | undefined,
    };

    return true;
  }
}
