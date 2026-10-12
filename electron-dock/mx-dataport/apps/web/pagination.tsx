import { useState } from "react";
import { Button } from "@/components/ui/button";

export type PageInfo = { page: number; pageSize: number; total: number };
export function Pagination({ label, page, pageSize, total, busy = false, onChange }: PageInfo & {
  label: string; busy?: boolean; onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return <nav className="harbor-pagination" aria-label={`${label}分页`}>
    <span aria-live="polite">共 {total} 条 · 第 {page} / {pages} 页</span>
    <div className="harbor-actions">
      <Button variant="outline" disabled={busy || page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
      <Button variant="outline" disabled={busy || page >= pages} onClick={() => onChange(page + 1)}>下一页</Button>
    </div>
  </nav>;
}

// For complete, small collections (members, keys, catalog); server-paged records use PageInfo directly.
export function useLocalPage<T>(values: T[], pageSize = 20) {
  const [requestedPage, setPage] = useState(1);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(values.length / pageSize)));
  return { items: values.slice((page - 1) * pageSize, page * pageSize), setPage,
    pagination: { page, pageSize, total: values.length } };
}
