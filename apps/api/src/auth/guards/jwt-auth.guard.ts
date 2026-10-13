import { ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest<TUser = any>(err: any, user: any, info: any, context: ExecutionContext): TUser {
    const result = super.handleRequest(err, user, info, context);
    const allowed = this.reflector.getAllAndOverride<boolean>('allow_initial_password', [context.getHandler(), context.getClass()]);
    if (result?.mustChangePassword && !allowed) throw new ForbiddenException({ code: 'password_change_required', message: 'Troque sua senha inicial para acessar as câmeras.' });
    return result;
  }
}
