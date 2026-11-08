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

export function fileDatasetSourceError(error, product, roots) {
  if (error?.code !== 'server_file_path_not_allowed') return error
  let message = '当前服务未配置可读根目录。请先为 Hub Admin 和 dictionary worker 配置同一只读挂载，再刷新任务。'
  if (roots.length) {
    message = `源文件超出允许范围。可用根目录 ID：${roots.map(root => root.rootId).join('、')}。请将文件放在其中一个挂载目录内，然后清空“服务器路径”，填写该根目录 ID 和文件在其中的相对路径。`
  }
  if (isEmailPhoneDataset(product)) {
    if (roots.some(root => root.rootId === ARCHIVE_ROOT)) {
      message += ` 使用邮箱手机号压缩包时，填 ${ARCHIVE_ROOT} 和 email-phone.zip。`
    } else {
      message += ` 如需读取原位置的 email-phone.zip，请在部署配置中为 Hub Admin 和 dictionary worker 启用只读挂载 ${ARCHIVE_ROOT}，部署后重新打开任务。`
    }
  }
  return { ...error, message }
}
