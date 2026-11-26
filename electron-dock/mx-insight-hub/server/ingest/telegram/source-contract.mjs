export const TELEGRAM_MONITOR_MAPPING_VERSION = 2

export const TELEGRAM_MONITOR_INPUTS = Object.freeze([
  Object.freeze({
    role: 'chats',
    sourceKey: 'telegram-monitor-chats',
    schema: 'public',
    table: 'tg_monitor_chats',
    cursorColumn: 'updated_at',
    idColumn: 'chat_id',
    builtInMappingVersion: TELEGRAM_MONITOR_MAPPING_VERSION,
    builtInMappingId: 'f52f00f6-4326-4d0a-87ae-06b239450a1f',
  }),
  Object.freeze({
    role: 'messages',
    sourceKey: 'telegram-monitor-messages',
    schema: 'public',
    table: 'tg_monitor_messages',
    cursorColumn: 'updated_at',
    idColumn: 'id',
    builtInMappingVersion: TELEGRAM_MONITOR_MAPPING_VERSION,
    builtInMappingId: '32ac88ac-0c89-46c0-b22e-7885814ebd56',
  }),
])

export const TELEGRAM_MONITOR_SOURCE_KEYS = new Set(
  TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey),
)

export function isTelegramMonitorSourceKey(sourceKey) {
  return TELEGRAM_MONITOR_SOURCE_KEYS.has(sourceKey)
}
