import { SetMetadata } from '@nestjs/common';
export const AllowInitialPassword = () => SetMetadata('allow_initial_password', true);
