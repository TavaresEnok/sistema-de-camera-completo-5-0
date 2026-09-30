import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DetectionZoneDto } from './detection-zone.dto';

export class UpdateDetectionZonesDto {
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => DetectionZoneDto)
  detectionZones!: DetectionZoneDto[];

  /** Estado que o editor recebeu. Compara só o desenho, não status/FPS/saúde. */
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => DetectionZoneDto)
  expectedDetectionZones!: DetectionZoneDto[];
}
