import { Controller, Get, Header } from '@nestjs/common';

import { mxLauncherApiDocument, renderApiDocsHtml, renderApiDocsMarkdown } from './api-docs.contract.js';

@Controller()
export class ApiDocsController {
  @Get(['docs', 'docs/api'])
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  index() {
    return renderApiDocsHtml(mxLauncherApiDocument);
  }

  @Get('docs/api/openapi.json')
  @Header('cache-control', 'no-store')
  openApi() {
    return mxLauncherApiDocument;
  }

  @Get('docs/api/mx-launcher-api.md')
  @Header('content-type', 'text/markdown; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="mx-launcher-api.md"')
  @Header('cache-control', 'no-store')
  markdown() {
    return renderApiDocsMarkdown(mxLauncherApiDocument);
  }
}
