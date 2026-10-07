import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AddGeofenceDto {
  @IsOptional()
  geofence_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

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
