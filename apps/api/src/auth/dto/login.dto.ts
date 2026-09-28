import { IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  /** `email` permanece aceito por compatibilidade com versões já instaladas. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  email?: string;

  @IsString()
  // O login não impõe uma política nova às senhas já cadastradas. A força
  // exigida é validada ao criar/alterar a senha, inclusive em instalações
  // que permitem senhas legadas de quatro caracteres.
  @MinLength(1)
  password!: string;
}
