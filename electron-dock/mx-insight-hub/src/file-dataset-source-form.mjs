const ARCHIVE_ROOT = 'email-phone-archive'

const isEmailPhoneDataset = product => ['email-directory', 'phone-directory'].includes(product.key)

export function initialFileDatasetSource(product, dataset, roots) {
  if (dataset.source) {
    return { ...dataset.source, entry: dataset.source.entry || '', expectedSha256: dataset.expectedSha256 || '' }
  }
  const defaults = product.defaultSource
  const expectedSha256 = dataset.expectedSha256 ?? defaults.sha256 ?? ''
  if (isEmailPhoneDataset(product) && roots.some(root => root.rootId === ARCHIVE_ROOT)) {
    return { rootId: ARCHIVE_ROOT, relativePath: 'email-phone.zip', entry: defaults.entry, expectedSha256 }
  }
  const root = roots.find(row => row.rootId === defaults.rootId) || roots.find(row => row.rootId !== ARCHIVE_ROOT)
  return { rootId: root?.rootId || '', relativePath: defaults.relativePath, entry: defaults.entry || '', expectedSha256 }
}

export function fileDatasetSourceError(error, product, roots, hostPaths = false) {
  if (error?.code === 'server_file_host_unavailable') {
    return { ...error, message: '连接不到 Internal 的文件读取服务。请在 Internal 主机检查 mx-insight-file-reader.socket 和 mx-insight-file-reader.service，恢复后重试。' }
  }
  if (hostPaths && error?.code === 'server_file_unreadable') {
    return { ...error, message: '源文件不可读。请检查读取账号对文件的读权限，以及进入上级目录的权限。' }
  }
  if (error?.code !== 'server_file_path_not_allowed') return error
  if (hostPaths) return { ...error, message: '请核对源文件位置。宿主机路径须指向普通数据目录中的文件；系统目录和隐藏路径不可用于清洗。使用挂载来源时请核对根目录 ID。' }
  let message = '当前服务未配置可读根目录。请先为 Hub Admin 和 dictionary worker 配置同一只读挂载，再刷新任务。'
  if (roots.length) {
    message = `源文件超出允许范围。可用根目录 ID：${roots.map(root => root.rootId).join('、')}。请将文件放在其中一个挂载目录内，然后清空“服务器路径”，填写该根目录 ID 和文件在其中的相对路径。`
  }
  if (isEmailPhoneDataset(product)) {
    if (roots.some(root => root.rootId === ARCHIVE_ROOT)) {
      message += ` 使用邮箱手机号压缩包时，填 ${ARCHIVE_ROOT} 和 email-phone.zip。`
    } else {
      message += ' 在 Internal 上，启用宿主文件读取服务并部署支持它的 Hub 后，可以直接填写其他磁盘上的源文件路径。'
    }
  }
  return { ...error, message }
}
