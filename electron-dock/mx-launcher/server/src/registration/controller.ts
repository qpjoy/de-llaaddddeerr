import { Body, Controller, Get, Header, Headers, HttpException, Inject, Post, ServiceUnavailableException, UnauthorizedException, type OnModuleDestroy } from '@nestjs/common';
import { RUNTIME_CONFIG, PLATFORM_STORE } from '../tokens.js';
import type { PlatformStore } from '../store/platform-store.js';
import { FeishuAuthService } from '../modules/sdk-gateway/feishu-auth.service.js';
import type { RuntimeConfig } from '../types.js';
import { assertInternalOpsToken, INTERNAL_OPS_TOKEN_HEADER } from '../lib/internal-ops-auth.js';
import { loadAdminSsoConfig, loadPublicAdminSsoConfig } from '../admin-sso/config.js';
import { RegistrationError, RegistrationRepository, type CreateInvitationInput, type RegistrationInput, type RegistrationPolicy } from './repository.js';
import { verifyRegistrationSignature } from './backchannel.js';

@Controller()
export class RegistrationController implements OnModuleDestroy {
  private repository?: RegistrationRepository;
  constructor(@Inject(RUNTIME_CONFIG) private config: RuntimeConfig, @Inject(PLATFORM_STORE) private platformStore: PlatformStore) {}
  private settings() {
    let sso;
    try { sso = loadAdminSsoConfig(); } catch { /* fail closed only for this feature */ }
    if (!sso?.localSubjects || !this.config.databaseUrl || this.config.storeDriver !== 'postgres')
      throw new ServiceUnavailableException('请先启用托管身份服务；现有账号登录不受影响。');
    return sso;
  }
  private store() {
    const sso = this.settings();
    return this.repository ??= new RegistrationRepository(this.config.databaseUrl!, this.config.environment, sso.clientId, this.config.siteId);
  }
  async onModuleDestroy() { await this.repository?.close(); }
  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof RegistrationError) throw new HttpException({ code: error.code, message: error.message }, error.status);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('注册服务暂不可用，请稍后重试。');
    }
  }
  @Get('internal/v1/user-center/registration')
  @Header('Cache-Control', 'no-store')
  async overview(@Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.perform(async () => ({ policy: await this.store().policy(), invitations: await this.store().invitations(), apps: await this.store().apps(), scope: 'mx-account' }));
  }
  @Post('internal/v1/user-center/registration/policy')
  @Header('Cache-Control', 'no-store')
  async policy(@Headers(INTERNAL_OPS_TOKEN_HEADER) token: string | undefined, @Body() body: RegistrationPolicy) {
    assertInternalOpsToken(token); return this.perform(async () => ({ policy: await this.store().updatePolicy(body) }));
  }
  @Post('internal/v1/user-center/registration/invitations')
  @Header('Cache-Control', 'no-store')
  async invite(@Headers(INTERNAL_OPS_TOKEN_HEADER) token: string | undefined, @Body() body: CreateInvitationInput) {
    assertInternalOpsToken(token); return this.perform(() => this.store().createInvitation(body));
  }
  @Post('internal/v1/user-center/registration/invitations/revoke')
  @Header('Cache-Control', 'no-store')
  async revoke(@Headers(INTERNAL_OPS_TOKEN_HEADER) token: string | undefined, @Body() body: { id: string }) {
    assertInternalOpsToken(token); return this.perform(async () => { await this.store().revokeInvitation(body.id); return { ok: true }; });
  }
  @Post('identity-backend/registration')
  @Header('Cache-Control', 'no-store')
  async backchannel(@Headers('x-mx-identity-signature') signature: string | undefined,
    @Body() body: { timestamp: number; clientId: string; action: string; input: RegistrationInput & Record<string, unknown> }) {
    const privateSso = this.settings();
    let publicSso;
    try { publicSso = loadPublicAdminSsoConfig(); } catch { /* private registration remains usable */ }
    const sso = body?.clientId === publicSso?.clientId ? publicSso : privateSso;
    if (!sso || !body || !verifyRegistrationSignature(sso.clientSecret, body, signature) || body.clientId !== sso.clientId) throw new UnauthorizedException();
    return this.perform(async () => {
      if (body.action === 'policy') return this.store().policy();
      if (body.action.startsWith('feishu-')) {
        // Add a Web callback on this server-only service instance. Do not change
        // the Electron SDK's redirect allowlist or historical provisioning.
        const redirectUri = `${new URL(sso.issuer).origin}/identity/feishu/callback`;
        const web = new FeishuAuthService({ ...this.config, feishuRedirectUris: [redirectUri] }, this.platformStore);
        if (body.action === 'feishu-info') return { enabled: web.publicConfig().enabled };
        if (body.action === 'feishu-authorize') return web.authorize({ redirectUri, state: String(body.input.state), codeChallenge: String(body.input.codeChallenge), sourceKey: String(body.input.sourceKey), exchangeHandleVersion: 'mxfx1' });
        if (body.action === 'feishu-exchange') {
          const verified = await web.verifyExternalIdentity({ redirectUri, code: String(body.input.code), codeVerifier: String(body.input.verifier), exchangeHandle: String(body.input.exchangeHandle), sourceKey: String(body.input.sourceKey) });
          return { ...verified, ...await this.store().feishuAccount(verified.subject) };
        }
        if (body.action === 'feishu-bind') return this.store().bindFeishu(String(body.input.subject), String(body.input.login), String(body.input.password));
        throw new UnauthorizedException();
      }
      if (body.action !== 'register') throw new UnauthorizedException();
      // The client id is from the authenticated server envelope, never the form.
      return this.store().register({ ...body.input, clientId: privateSso.clientId });
    });
  }
}
