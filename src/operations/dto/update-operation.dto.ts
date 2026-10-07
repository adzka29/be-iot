import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateOperationDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  start_at?: string;

  @IsOptional()
  @IsString()
  end_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @IsOptional()
  @IsArray()
  group_ids?: number[];

  @IsOptional()
  @IsArray()
  geofence_ids?: number[];
}
