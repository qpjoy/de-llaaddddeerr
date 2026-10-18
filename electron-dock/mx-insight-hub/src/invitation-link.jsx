import { useRef, useState } from 'react'
import { Copy } from '@phosphor-icons/react'
import { Field } from './components.jsx'

async function writeInvitation(value) {
  if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') return false
  await globalThis.navigator.clipboard.writeText(value)
  return true
}

export function InvitationLink({ value, copy = writeInvitation }) {
  const input = useRef(null)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [notice, setNotice] = useState('')
  const select = () => {
    input.current?.focus()
    input.current?.select()
  }
  const copyLink = async () => {
    setCopying(true)
    setNotice('')
    let success = false
    try { success = await copy(value) } catch { /* Keep the manual path available. */ }
    setCopied(success)
    setCopying(false)
    if (success) setNotice('邀请链接已复制。')
    else {
      select()
      setNotice('自动复制失败，已选中链接。请按 Ctrl+C（Mac：⌘C），或长按复制。')
    }
  }
  return <>
    <Field label="一次性邀请链接">
      <textarea ref={input} className="qp-input" rows={4} value={value} readOnly onFocus={event => event.target.select()} />
    </Field>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" className="qp-button qp-button--outline" disabled={copying} onClick={copyLink}>
        <Copy size={16} aria-hidden="true" />{copying ? '正在复制…' : copied ? '已复制' : '复制链接'}
      </button>
      <button type="button" className="qp-button qp-button--outline" onClick={() => {
        select()
        setCopied(false)
        setNotice('链接已选中。请按 Ctrl+C（Mac：⌘C），或长按复制。')
      }}>选中链接</button>
      <a className="qp-button qp-button--outline" href={value} target="_blank" rel="noopener noreferrer">打开邀请页</a>
    </div>
    {notice ? <p role="status">{notice}</p> : null}
  </>
}
