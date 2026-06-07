import { Module } from '@nestjs/common';

import { DnsController } from './dns.controller.js';

@Module({
  controllers: [DnsController]
})
export class DnsModule {}
