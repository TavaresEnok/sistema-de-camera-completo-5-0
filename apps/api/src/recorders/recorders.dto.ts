import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsIP, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
export class CreateRecorderDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsIP() ip!: string;
  @IsInt() @Min(1) @Max(65535) rtspPort!: number;
  @IsInt() @Min(1) @Max(65535) httpPort!: number;
  @IsOptional() @IsInt() @Min(1) @Max(65535) onvifPort?: number;
  @IsString() @MinLength(1) @MaxLength(128) username!: string;
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
  @IsUUID() groupId!: string;
  @IsIn(['generic', 'intelbras', 'dahua', 'hikvision']) manufacturer!: string;
}
export class ImportRecorderChannelDto {
  @IsInt() @Min(1) @Max(256) channel!: number;
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(1024) rtspPath?: string;
}
export class ImportRecorderChannelsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(64)
  @ValidateNested({ each: true }) @Type(() => ImportRecorderChannelDto)
  channels!: ImportRecorderChannelDto[];
}
export class UpdateRecorderDto extends CreateRecorderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) declare password: string;
}
export class LinkRecorderChannelDto { @IsUUID() cameraId!: string; }
