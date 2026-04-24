import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { RequestService } from './request.service';
import { SubmitRequestDto } from './dto/submit-request.dto';
import { RejectRequestDto } from './dto/reject-request.dto';
import { ListRequestsQueryDto } from './dto/list-requests-query.dto';
import { RequestStatus } from '../common/enums/request-status.enum';

type AuthReq = Request & { user: RequestUser };

@Controller('requests')
@UseGuards(AuthGuard)
export class RequestController {
  constructor(private readonly requestService: RequestService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submit(@Body() dto: SubmitRequestDto, @Req() req: AuthReq) {
    return this.requestService.submitRequest(dto, req.user);
  }

  @Get()
  async list(@Query() query: ListRequestsQueryDto, @Req() req: AuthReq) {
    return this.requestService.listRequests(query, req.user);
  }

  @Get('team')
  async listTeam(
    @Query('managerId', ParseIntPipe) managerId: number,
    @Query('status') status: RequestStatus | undefined,
    @Req() req: AuthReq,
  ) {
    return this.requestService.listTeamRequests(managerId, status);
  }

  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    return this.requestService.getRequest(id, req.user);
  }

  @Patch(':id/approve')
  async approve(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    return this.requestService.approveRequest(id, req.user);
  }

  @Patch(':id/reject')
  async reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectRequestDto,
    @Req() req: AuthReq,
  ) {
    return this.requestService.rejectRequest(id, req.user, dto.reason);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: AuthReq) {
    await this.requestService.cancelRequest(id, req.user);
  }
}
