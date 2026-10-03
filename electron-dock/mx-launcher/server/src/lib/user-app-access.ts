import { ForbiddenException } from '@nestjs/common';
import { UserAppAccessDeniedError } from '../store/domain.js';

export function rethrowUserAppAccessError(error: unknown): never {
  if (error instanceof UserAppAccessDeniedError) {
    throw new ForbiddenException({ code: error.code, message: error.message, appId: error.appId, userId: error.userId });
  }
  throw error;
}
