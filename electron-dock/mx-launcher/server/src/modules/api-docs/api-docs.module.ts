import { Module } from '@nestjs/common';

import { ApiDocsController } from './api-docs.controller.js';

@Module({
  controllers: [ApiDocsController]
})
export class ApiDocsModule {}
