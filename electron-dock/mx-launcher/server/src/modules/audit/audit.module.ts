import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';

@Module({
  controllers: [AuditController]
})
export class AuditModule {}
