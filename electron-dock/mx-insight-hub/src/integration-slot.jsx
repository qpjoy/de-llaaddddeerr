import { SLOT_MODES, slotProfile } from '../shared/integration-slots.mjs'
import './integration-slot.css'

export function SlotTags({ provider }) {
  const slot = slotProfile(provider)
  if (!slot) return null
  return <div className="mih-slot-tags"><span className="qp-tag">{slot.ownership}</span>{slot.modes.map(mode => <span className="qp-tag" key={mode}>{SLOT_MODES[mode]}</span>)}</div>
}

export function IntegrationSlotFrame({ provider, children }) {
  const slot = slotProfile(provider)
  return <div className="mih-slot-frame">
    {slot ? <section className="qp-panel mih-slot-overview" aria-label="平台接入契约">
      <header><strong>数据插槽 · 接入概况</strong><SlotTags provider={provider} /></header>
      <dl><div><dt>操作入口</dt><dd>{slot.control}</dd></div><div><dt>数据交付</dt><dd>{slot.delivery}</dd></div><div><dt>数据契约</dt><dd>{slot.mapping}</dd></div><div><dt>运行证据</dt><dd>{slot.evidence}</dd></div></dl>
      <details><summary>查看统一接入边界</summary><p>契约版本 {slot.contractVersion}。平台、执行适配器和数据集分别管理；连接可用、任务完成、数据完整、Hub 入库是四种独立状态。以下现有平台控制、权限和计费规则继续生效。</p><p>独立采集器可交付 manifest.yaml、adapter.py/adapter.js、ADAPTER_VERIFICATION.json 与 README；远程平台用固定 HTTP 适配，无需迁移原运行环境。离线验证通过不代表实时可用。</p></details>
    </section> : null}
    {children}
  </div>
}
