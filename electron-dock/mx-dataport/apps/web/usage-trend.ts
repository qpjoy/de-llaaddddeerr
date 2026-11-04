type UsageDay = { day: string; requests: number; committed: number };
export function usageTrend(data: { from: string; to: string; daily: UsageDay[] } | null): UsageDay[] {
  if (!data) return [];
  const start = new Date(data.from), end = new Date(data.to);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  const count = (end.getTime() - start.getTime()) / 86400000 + 1;
  if (!Number.isInteger(count) || count < 1 || count > 32) return [];
  const rows = new Map(data.daily.map(row => [row.day, row]));
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    return rows.get(day) || { day, requests: 0, committed: 0 };
  });
}
