import { Body, Controller, Get, Headers, Param, Post, ServiceUnavailableException, BadRequestException, HttpException } from '@nestjs/common';
import { assertInternalOpsToken, INTERNAL_OPS_TOKEN_HEADER } from '../../lib/internal-ops-auth.js';

@Controller('internal/v1/admin/service-operations')
export class ServiceOperationsController {
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const raw = process.env.MX_SERVICE_OPERATIONS_URL?.trim();
    const token = process.env.MX_SERVICE_OPERATIONS_TOKEN?.trim();
    if (!raw || !token) throw new ServiceUnavailableException('独立运维执行器未接入；可编辑并复制命令，接入后可查询和执行任务。');
    let url: URL;
    try {
      url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error();
    } catch { throw new ServiceUnavailableException('运维执行器地址配置无效'); }
    let response: Response;
    try {
      response = await fetch(new URL(path, url), {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'x-mx-operations-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { throw new ServiceUnavailableException('运维执行器暂不可达；已提交任务可能仍在主机执行，请恢复连接后查询原任务。'); }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ServiceUnavailableException('运维执行器返回无效响应'); }
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : '运维执行器请求失败';
      throw new HttpException(message, [400, 404, 409, 413].includes(response.status) ? response.status : 503);
    }
    return payload;
  }

  @Get('instances')
  instances(@Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/instances');
  }

  @Get('identity')
  identity(@Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/identity');
  }

  @Post('identity/validate')
  validateIdentity(@Body() body: unknown, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/identity/validate', 'POST', body);
  }

  @Post('identity/applications')
  saveIdentity(@Body() body: unknown, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/identity/applications', 'POST', body);
  }

  @Post('profiles')
  profiles(@Body() body: unknown, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/profiles', 'POST', body);
  }

  @Post('plans')
  plans(@Body() body: unknown, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/plans', 'POST', body);
  }

  @Post('execute')
  execute(@Body() body: unknown, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/execute', 'POST', body);
  }

  @Get('operations')
  operations(@Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/operations');
  }

  @Get('operations/:id')
  operation(@Param('id') id: string, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('任务 ID 不正确');
    return this.request(`/v1/operations/${id}`);
  }

  @Post('reconcile')
  reconcile(@Body() body: unknown, @Headers(INTERNAL_OPS_TOKEN_HEADER) token?: string) {
    assertInternalOpsToken(token);
    return this.request('/v1/reconcile', 'POST', body);
  }
}
