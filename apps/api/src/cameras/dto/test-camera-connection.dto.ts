import { IsIP, IsInt, IsIn, IsOptional, IsString, Max, Min } from 'class-validator';

export class TestCameraConnectionDto {
  @IsString()
  @IsIP()
  ip!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  rtspPort!: number;

  @IsOptional()
  @IsIn(['manual', 'automatic'])
  rtspPortMode?: 'manual' | 'automatic';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  onvifPort?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  httpPort?: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  rtspPath?: string;

  @IsOptional()
  @IsString()
  onvifPath?: string;

  @IsOptional()
  @IsString()
  onvifProfileToken?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  channel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  subtype?: number;
}
