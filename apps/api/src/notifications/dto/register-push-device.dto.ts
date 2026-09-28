import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterPushDeviceDto {
  @IsString()
  // FCM não fixa publicamente um teto curto para registration tokens. O banco
  // usa TEXT; aceitar até 4096 evita recusar um aparelho válido por suposição.
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: 'ios' | 'android';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

export class UnregisterPushDeviceDto {
  @IsString()
  @MaxLength(4096)
  token!: string;
}
