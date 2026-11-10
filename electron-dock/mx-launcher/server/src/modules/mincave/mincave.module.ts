import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { RuntimeConfig } from '../../types.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from '../../tokens.js';
import { MinCaveService } from './mincave.service.js';

@Controller('internal/v1/mincave')
class MinCaveController {
  constructor(@Inject(MinCaveService) private readonly service: MinCaveService) {}
  @Post('session')
  @Header('Cache-Control', 'no-store')
  session(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    return this.service.session(authorization, body);
  }
  @Get('devices')
  @Header('Cache-Control', 'no-store')
  devices(@Headers('authorization') authorization?: string) {
    return this.service.devices(authorization);
  }
  @Get('members')
  @Header('Cache-Control', 'no-store')
  members(@Headers('authorization') authorization?: string) {
    return this.service.members(authorization);
  }
  @Patch('members/:userId')
  @Header('Cache-Control', 'no-store')
  update(
    @Headers('authorization') authorization: string | undefined,
    @Param('userId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.update(authorization, id, body);
  }
}
@Module({
  controllers: [MinCaveController],
  providers: [
    {
      provide: MinCaveService,
      useFactory: (config: RuntimeConfig, store: PlatformStore) =>
        new MinCaveService(config, store),
      inject: [RUNTIME_CONFIG, PLATFORM_STORE],
    },
  ],
})
export class MinCaveModule {}
