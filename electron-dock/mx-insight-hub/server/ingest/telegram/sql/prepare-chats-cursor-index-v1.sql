CREATE INDEX CONCURRENTLY mx_insight_hub_tg_monitor_chats_cursor_idx
  ON public.tg_monitor_chats (updated_at, chat_id);
