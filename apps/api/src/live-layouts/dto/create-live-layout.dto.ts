import { Type } from 'class-transformer';
import { DestinatariosDto } from './destinatarios.dto';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

export class CreateLiveLayoutDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,100}$/)
  clientRequestId?: string;

  @IsString()
  @MaxLength(80)
  name!: string;

  @IsString()
  @Matches(/^[1-8]x[1-8]$/)
  gridSize!: string;

  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  cameraIds!: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  showOnMobile?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => DestinatariosDto)
  destinatarios?: DestinatariosDto;
}
