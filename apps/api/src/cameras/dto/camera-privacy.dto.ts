import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsUUID, Matches, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';

/** Ausência preserva o cadastro; null e strings não são booleanos válidos. */
export class CameraPrivacyDto {
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[a-f0-9]{64}$/)
  expectedPrivacyRevision?: string;

  @ValidateIf((_o, value) => value !== undefined)
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  isPrivate?: boolean;

  @ValidateIf((_o, value) => value !== undefined)
  @IsUUID()
  ownerUserId?: string;

  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  privateViewerIds?: string[];

  @ValidateIf((_o, value) => value !== undefined)
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  privacyConfirmed?: boolean;
}
