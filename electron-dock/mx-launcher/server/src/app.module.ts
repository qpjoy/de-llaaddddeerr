import { Module } from '@nestjs/common';

import { AppCenterModule } from './modules/app-center/app-center.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { DnsModule } from './modules/dns/dns.module.js';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module.js';
import { LauncherNetworkModule } from './modules/launcher-network/launcher-network.module.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';
import { PermissionsModule } from './modules/permissions/permissions.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { ReleaseModule } from './modules/release/release.module.js';
import { SdkGatewayModule } from './modules/sdk-gateway/sdk-gateway.module.js';
import { TestCenterModule } from './modules/test-center/test-center.module.js';
import { UserCenterModule } from './modules/user-center/user-center.module.js';
import { SharedModule } from './shared.module.js';

@Module({
  imports: [
    SharedModule,
    PlatformModule,
    EnrollmentsModule,
    AuditModule,
    ObservabilityModule,
    ReleaseModule,
    AppCenterModule,
    UserCenterModule,
    SdkGatewayModule,
    PermissionsModule,
    LauncherNetworkModule,
    DnsModule,
    TestCenterModule
  ]
})
export class AppModule {}
