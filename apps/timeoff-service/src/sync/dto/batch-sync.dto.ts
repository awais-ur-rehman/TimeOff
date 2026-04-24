import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

export class BatchRecordDto {
  @IsNumber()
  @IsPositive()
  employeeId: number;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsNumber()
  @IsPositive()
  totalDays: number;

  @IsString()
  @IsNotEmpty()
  hcmVersion: string;
}

export class BatchSyncDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchRecordDto)
  records: BatchRecordDto[];
}
