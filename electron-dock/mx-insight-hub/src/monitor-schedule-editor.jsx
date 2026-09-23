import { useState } from 'react'
import { DropdownField, Field } from './components.jsx'
import { describeMonitorSchedule, previewMonitorRuns, scheduleControls, scheduleEveryMinutes } from '../shared/monitor-schedule.mjs'

const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const options = [
  { value: 'every', label: '每隔一段时间（整点对齐）' },
  { value: 'daily', label: '每天定点' },
  { value: 'custom', label: '自定义 Cron' },
  { value: 'interval', label: '固定间隔（从起点计算）' },
]

export function MonitorScheduleEditor({ label, value, onChange, disabled, intervalHint }) {
  const controls = scheduleControls(value)
  const [mode, setMode] = useState(controls.mode)
  const [minutes, setMinutes] = useState(String(controls.minutes ?? 30))
  const [time, setTime] = useState(controls.time ?? '09:00')
  let previews = [], error = ''
  try { previews = previewMonitorRuns(value) } catch (failure) { error = failure.message }
  const changeMinutes = (text, selectedMode = mode) => {
    setMinutes(text)
    const number = Number(text)
    let next = { mode: 'interval', minutes: number }
    if (selectedMode === 'every' && Number.isInteger(number) && number >= 1 && number <= 1440) next = scheduleEveryMinutes(number)
    onChange(next)
  }
  const changeTime = text => {
    setTime(text)
    const [hour, minute] = text.split(':')
    onChange({ mode: 'cron', expression: text ? `${Number(minute)} ${Number(hour)} * * *` : '' })
  }
  const changeMode = selected => {
    setMode(selected)
    if (selected === 'every' || selected === 'interval') changeMinutes(minutes, selected)
    else if (selected === 'daily') changeTime(time)
    else onChange({ mode: 'cron', expression: value.mode === 'cron' ? value.expression : '' })
  }
  const changeCron = expression => {
    const next = { mode: 'cron', expression }
    onChange(next)
    const parsed = scheduleControls(next)
    setMode(parsed.mode)
    if (parsed.minutes) setMinutes(String(parsed.minutes))
    if (parsed.time) setTime(parsed.time)
  }
  return <fieldset className="mih-monitor-schedule" disabled={disabled}>
    <legend>{label} <small>北京时间 · Asia/Shanghai</small></legend>
    <div className="mih-balance-fields">
      <DropdownField label={`${label}方式`} value={mode} options={options} disabled={disabled} onChange={changeMode} />
      {mode === 'every' || mode === 'interval' ? <Field label={`${label}间隔（分钟）`}>
        <input className="qp-input" type="number" min="1" max="1440" step="1" required value={minutes} onChange={event => changeMinutes(event.target.value)} />
      </Field> : mode === 'daily' ? <Field label={`${label}时间`}>
        <input className="qp-input" type="time" required value={time} onChange={event => changeTime(event.target.value)} />
      </Field> : <p className="mih-schedule-help">可设置多个时间、工作日或每周执行；复杂表达式保留原样。</p>}
    </div>
    <Field label={`${label} Cron 表达式`} hint="五段：分 时 日 月 周。例如每半小时 */30 * * * *；每天 09:00 为 0 9 * * *。">
      <input className="qp-input mih-mono" value={value.mode === 'cron' ? value.expression : ''} spellCheck={false}
        placeholder="输入 Cron 可切换为固定时刻计划" onChange={event => changeCron(event.target.value)} />
    </Field>
    {value.mode === 'interval' ? <p>固定间隔依赖起点，无法无损转换为整点 Cron。{intervalHint}输入 Cron 将切换为固定时刻计划。</p> : null}
    {error ? <p className="mih-schedule-error" role="alert">{error}</p> : <>
      <p>{describeMonitorSchedule(value)}</p>
      <div className="mih-schedule-preview"><span>{value.mode === 'interval' ? '按当前时间示例（实际起点以保存结果为准）' : '接下来执行（保存后生效）'}</span>
        <ol>{previews.map(at => <li key={at}><time dateTime={at}>{dateFormat.format(new Date(at))}</time></li>)}</ol>
      </div>
    </>}
  </fieldset>
}
