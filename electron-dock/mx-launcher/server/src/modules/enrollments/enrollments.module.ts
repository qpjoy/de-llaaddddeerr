import { Module } from '@nestjs/common';

import { EnrollmentsController } from './enrollments.controller.js';

@Module({
  controllers: [EnrollmentsController]
})
export class EnrollmentsModule {}
