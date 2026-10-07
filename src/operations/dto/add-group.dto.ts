import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class AddGroupDto {
  @IsOptional()
  group_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  leader_soldier_id?: number | string;

  @IsOptional()
  @IsArray()
  member_soldier_ids?: Array<number | string>;
}
