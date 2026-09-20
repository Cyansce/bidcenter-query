import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
export class LoginStartDto {
  @IsOptional() @IsIn(['sms', 'password']) method?: 'sms' | 'password';
}
export class SmsDto {
  @IsString() @Matches(/^\d{4,6}$/) code!: string;
}
export class RunDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(200, { each: true }) queries?: string[];
}
export class ProjectQueryDto {
  @IsOptional() @IsString() @MaxLength(200) keyword?: string;
  @IsOptional() @IsString() @MaxLength(200) query?: string;
  @IsOptional() @IsString() @MaxLength(50) region?: string;
  @IsOptional() @Type(() => Number) @IsIn([1, 2]) type?: number;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsIn(['true', 'false']) validOnly?: string;
  @IsOptional() @IsIn(['RELATED', 'UNRELATED', 'REVIEW']) relevance?: string;
  @IsOptional() @IsIn(['FULL', 'RESTRICTED', 'UNKNOWN']) accessLevel?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}
