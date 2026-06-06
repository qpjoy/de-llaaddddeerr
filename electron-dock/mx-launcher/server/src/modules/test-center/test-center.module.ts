import { Module } from '@nestjs/common';

import { TestCenterController } from './test-center.controller.js';

@Module({
  controllers: [TestCenterController]
})
export class TestCenterModule {}
