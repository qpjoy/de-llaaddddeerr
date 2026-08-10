CREATE INDEX CONCURRENTLY mx_insight_hub_tg_monitor_messages_cursor_idx
  ON public.tg_monitor_messages (updated_at, id);
