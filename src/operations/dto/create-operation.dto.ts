import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateGroupInlineDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  leader_soldier_id?: number | string;

  @IsArray()
  member_soldier_ids!: Array<number | string>;
}

export class NewGeofenceDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  polygon?: number[][];

  @IsOptional()
  @IsString()
  geometry_json?: string;

  @IsOptional()
  area_km2?: number;
}

export class CreateOperationDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsString()
  start_at!: string;

  @IsString()
  end_at!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @IsOptional()
  @IsArray()
  group_ids?: number[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateGroupInlineDto)
  groups?: CreateGroupInlineDto[];

  @IsOptional()
  @IsArray()
  geofence_ids?: number[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NewGeofenceDto)
  new_geofences?: NewGeofenceDto[];
}
