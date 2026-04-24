import { IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { RequestStatus } from '../../common/enums/request-status.enum';

export class ListRequestsQueryDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  employeeId?: number;

  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  cursor?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  limit?: number;
}
