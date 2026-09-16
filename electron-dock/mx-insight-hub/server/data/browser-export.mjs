import { AppError } from '../core/errors.mjs'

function cell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  // CSV quoting alone does not stop spreadsheet formula execution.
  if (/^[\s]*[=+@-]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export function formatBrowserExport(result, format, filters) {
  const metadata = { filters: { ...filters, page: 1, pageSize: result.pageSize, summary: 'false' }, exportedRows: result.items.length, truncated: result.hasMore,
    computedAt: result.evidence.computedAt, scope: 'first-matching-rows', snapshot: 'single-read-transaction' }
  const columns = [...new Set(result.items.flatMap((row) => Object.keys(row)))].filter((key) => key !== 'sort_time')
  const content = format === 'json'
    ? JSON.stringify({ metadata, items: result.items }, null, 2)
    : '\ufeff' + [columns.map(cell).join(','), ...result.items.map((row) => columns.map((key) => cell(row[key])).join(','))].join('\r\n')
  if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) {
    throw new AppError(413, 'data_browser_export_too_large', '导出超过 16 MiB，请缩小条数或筛选范围；未生成截断文件')
  }
  return { ...metadata, content, filename: `hub-${filters.view}-${new Date().toISOString().slice(0, 10)}${result.hasMore ? '-partial' : ''}.${format}`,
    mimeType: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' }
}
