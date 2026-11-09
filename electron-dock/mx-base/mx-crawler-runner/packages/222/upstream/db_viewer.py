# Copyright (c) 2026 Hao Yin. All rights reserved.

"""AudioSpider 数据库查看器 —— 查看 audiospider.db 中每条记录的完整细节"""

import sqlite3
import sys
import os

import config  # noqa: F401 — 触发 TMPDIR 设置

DB_PATH = config.DB_PATH


def fmt_size(n: int) -> str:
    if n <= 0:
        return "-"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def fmt_duration(sec: int) -> str:
    if sec <= 0:
        return "-"
    m, s = divmod(sec, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def connect():
    if not os.path.exists(DB_PATH):
        print(f"数据库不存在: {DB_PATH}")
        sys.exit(1)
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA temp_store = MEMORY")
    # 与 Storage 保持一致：补齐 published_at 列
    try:
        conn.execute("ALTER TABLE audio_urls ADD COLUMN published_at TEXT DEFAULT ''")
        conn.commit()
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            raise
    return conn


def show_overview(conn: sqlite3.Connection):
    print("=" * 70)
    print("  AudioSpider 数据库概览")
    print("=" * 70)

    total = conn.execute("SELECT COUNT(*) FROM audio_urls").fetchone()[0]
    print(f"\n  总记录数: {total}")

    rows = conn.execute(
        "SELECT status, COUNT(*) AS cnt FROM audio_urls GROUP BY status ORDER BY cnt DESC"
    ).fetchall()
    if rows:
        print("\n  按状态统计:")
        for r in rows:
            print(f"    {r['status']:12s}  {r['cnt']}")

    rows = conn.execute(
        "SELECT source, COUNT(*) AS cnt FROM audio_urls GROUP BY source ORDER BY cnt DESC"
    ).fetchall()
    if rows:
        print("\n  按来源统计:")
        for r in rows:
            print(f"    {r['source']:16s}  {r['cnt']}")

    rows = conn.execute(
        "SELECT category, COUNT(*) AS cnt FROM audio_urls WHERE category != '' GROUP BY category ORDER BY cnt DESC"
    ).fetchall()
    if rows:
        print("\n  按分类统计:")
        for r in rows:
            print(f"    {r['category']:12s}  {r['cnt']}")

    rows = conn.execute(
        "SELECT language, COUNT(*) AS cnt FROM audio_urls WHERE language != '' GROUP BY language ORDER BY cnt DESC"
    ).fetchall()
    if rows:
        print("\n  按语种统计:")
        for r in rows:
            print(f"    {r['language']:12s}  {r['cnt']}")

    show_published_stats(conn)
    show_duration_stats(conn)

    cp = conn.execute("SELECT COUNT(*) FROM crawl_checkpoints").fetchone()[0]
    print(f"\n  爬取检查点数: {cp}")
    print()


def show_published_stats(conn: sqlite3.Connection):
    print("\n  发布时间 (published_at):")
    has = conn.execute(
        "SELECT COUNT(*) FROM audio_urls WHERE published_at != '' AND published_at IS NOT NULL"
    ).fetchone()[0]
    empty = conn.execute(
        "SELECT COUNT(*) FROM audio_urls WHERE published_at = '' OR published_at IS NULL"
    ).fetchone()[0]
    print(f"    已填写          {has}")
    print(f"    未填写          {empty}")
    if has:
        row = conn.execute(
            "SELECT MIN(published_at) AS earliest, MAX(published_at) AS latest "
            "FROM audio_urls WHERE published_at != '' AND published_at IS NOT NULL"
        ).fetchone()
        print(f"    最早            {row['earliest'][:19]}")
        print(f"    最晚            {row['latest'][:19]}")


def _query_published_months(
    conn: sqlite3.Connection, since: str = "", before: str = ""
) -> list[sqlite3.Row]:
    where = "WHERE published_at != '' AND published_at IS NOT NULL"
    params: list = []
    if since:
        where += " AND published_at >= ?"
        params.append(since)
    if before:
        where += " AND published_at <= ?"
        params.append(before)
    return conn.execute(
        f"SELECT substr(published_at, 1, 7) AS month, COUNT(*) AS cnt "
        f"FROM audio_urls {where} "
        f"GROUP BY month ORDER BY month DESC",
        params,
    ).fetchall()


def show_published_month_menu(
    conn: sqlite3.Connection, since: str = "", before: str = ""
):
    """按月分组展示数量，可选中某月查看详情"""
    while True:
        rows = _query_published_months(conn, since=since, before=before)
        if not rows:
            has = conn.execute(
                "SELECT COUNT(*) FROM audio_urls "
                "WHERE published_at != '' AND published_at IS NOT NULL"
            ).fetchone()[0]
            if has == 0:
                print("  当前没有任何已填写 published_at 的记录。")
                print("  请先跑 discover.py（会回填历史空值），再回来查看按月分布。")
            else:
                print("  该日期范围内没有匹配的发布时间记录。")
            return

        total = sum(r["cnt"] for r in rows)
        print(f"\n{'=' * 60}")
        print("  按发布时间（月）浏览")
        if since or before:
            print(f"  范围: {since or '...'} ~ {before or '...'}")
        print(f"{'=' * 60}")
        print(f"  共 {len(rows)} 个月, {total} 条\n")

        months: list[str] = []
        for i, r in enumerate(rows, 1):
            months.append(r["month"])
            print(f"    {i:>3}. {r['month']}    {r['cnt']:>8} 条")

        print(f"\n    f. 按日期范围重新筛选")
        print(f"    0. 返回上级菜单")
        sel = input("\n  输入编号查看该月详情> ").strip().lower()
        if sel == "0" or sel == "":
            return
        if sel == "f":
            since = input("  起始日期 (如 2024-01-01, 直接回车不限): ").strip()
            before = input("  截止日期 (如 2024-12-31, 直接回车不限): ").strip()
            continue
        if not sel.isdigit():
            print("  无效选择。")
            continue
        idx = int(sel)
        if idx < 1 or idx > len(months):
            print("  无效编号。")
            continue

        ym = months[idx - 1]
        print(f"\n  [{ym}] 共 {_month_count(conn, ym)} 条")
        n = input("  显示该月的记录? 输入条数 (直接回车跳过, a=全部): ").strip().lower()
        if n == "a":
            show_month_records(conn, ym)
        elif n.isdigit() and int(n) > 0:
            show_month_records(conn, ym, limit=int(n))


def _month_count(conn: sqlite3.Connection, ym: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM audio_urls "
        "WHERE published_at != '' AND published_at LIKE ?",
        (f"{ym}%",),
    ).fetchone()[0]


def show_month_records(conn: sqlite3.Connection, ym: str, limit: int = 0):
    """查看指定月份 YYYY-MM 的记录"""
    where = "WHERE published_at != '' AND published_at LIKE ?"
    params: list = [f"{ym}%"]
    total = conn.execute(
        f"SELECT COUNT(*) FROM audio_urls {where}", params
    ).fetchone()[0]
    query = f"SELECT * FROM audio_urls {where} ORDER BY published_at DESC, id DESC"
    if limit > 0:
        query += " LIMIT ?"
        params = params + [limit]
    rows = conn.execute(query, params).fetchall()
    if not rows:
        print("  没有匹配的记录。")
        return
    if limit > 0 and total > limit:
        print(f"\n  [{ym}] 共 {total} 条, 显示前 {limit} 条\n")
    else:
        print(f"\n  [{ym}] 共 {total} 条\n")
    for i, r in enumerate(rows, 1):
        _print_record(r, i)


def show_all_records(conn: sqlite3.Connection, source_filter: str = "", status_filter: str = "",
                     category_filter: str = "", language_filter: str = "",
                     published_since: str = "", published_before: str = "",
                     limit: int = 0):
    where = "WHERE 1=1"
    filter_params: list = []
    if source_filter:
        where += " AND source = ?"
        filter_params.append(source_filter)
    if status_filter:
        where += " AND status = ?"
        filter_params.append(status_filter)
    if category_filter:
        where += " AND category = ?"
        filter_params.append(category_filter)
    if language_filter:
        where += " AND language = ?"
        filter_params.append(language_filter)
    if published_since:
        where += " AND published_at != '' AND published_at >= ?"
        filter_params.append(published_since)
    if published_before:
        where += " AND published_at != '' AND published_at <= ?"
        filter_params.append(published_before)

    total = conn.execute(f"SELECT COUNT(*) FROM audio_urls {where}", filter_params).fetchone()[0]

    query = f"SELECT * FROM audio_urls {where} ORDER BY published_at DESC, id DESC"
    if not published_since and not published_before:
        query = f"SELECT * FROM audio_urls {where} ORDER BY id"
    params = list(filter_params)
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(query, params).fetchall()
    if not rows:
        print("  没有匹配的记录。")
        return

    if limit > 0 and total > limit:
        print(f"\n  共 {total} 条记录, 显示前 {limit} 条\n")
    else:
        print(f"\n  共 {total} 条记录\n")
    for i, r in enumerate(rows, 1):
        _print_record(r, i)


def _print_record(r: sqlite3.Row, index: int | None = None):
    if index is not None:
        print(f"── 记录 #{index} (ID={r['id']}) {'─' * 48}")
    else:
        print(f"\n{'=' * 60}")
        print(f"  记录详情  (ID={r['id']})")
        print(f"{'=' * 60}")
    print(f"  标题:       {r['title'] or '-'}")
    print(f"  来源:       {r['source']}")
    print(f"  状态:       {r['status']}")
    print(f"  URL:        {r['url']}")
    print(f"  格式:       {r['file_format'] or '-'}")
    print(f"  大小:       {fmt_size(r['file_size'])}")
    print(f"  时长:       {fmt_duration(r['duration'])}")
    print(f"  语言:       {r['language'] or '-'}")
    print(f"  分类:       {r['category'] or '-'}")
    print(f"  说话人:     {r['speaker'] or '-'}")
    print(f"  本地路径:   {r['local_path'] or '-'}")
    print(f"  内容哈希:   {r['content_hash'] or '-'}")
    print(f"  源站 ID:    {r['source_id'] or '-'}")
    print(f"  发布时间:   {r['published_at'] or '-'}")
    print(f"  发现时间:   {r['discovered_at'] or '-'}")
    print(f"  下载时间:   {r['downloaded_at'] or '-'}")
    print()


def show_single_record(conn: sqlite3.Connection, record_id: int):
    r = conn.execute("SELECT * FROM audio_urls WHERE id = ?", (record_id,)).fetchone()
    if not r:
        print(f"  未找到 ID={record_id} 的记录。")
        return
    _print_record(r)

def show_checkpoints(conn: sqlite3.Connection):
    rows = conn.execute(
        "SELECT * FROM crawl_checkpoints ORDER BY source, checkpoint_key"
    ).fetchall()
    if not rows:
        print("  没有爬取检查点记录。")
        return
    print(f"\n  共 {len(rows)} 条检查点\n")
    for r in rows:
        print(f"  [{r['source']}]  {r['checkpoint_key']} = {r['checkpoint_value']}  (更新于 {r['updated_at']})")
    print()


def show_duration_stats(conn: sqlite3.Connection):
    print("\n  时长统计:")

    row = conn.execute(
        "SELECT COALESCE(SUM(duration), 0) AS sec, COUNT(*) AS cnt "
        "FROM audio_urls WHERE status = 'pending'"
    ).fetchone()
    print(f"    待下载 (pending)    {row['cnt']:>5} 条  总时长 {fmt_duration(row['sec'])}")

    row = conn.execute(
        "SELECT COALESCE(SUM(duration), 0) AS sec, COUNT(*) AS cnt "
        "FROM audio_urls WHERE status = 'done'"
    ).fetchone()
    print(f"    已完成 (done)       {row['cnt']:>5} 条  总时长 {fmt_duration(row['sec'])}")

    row = conn.execute(
        "SELECT COALESCE(SUM(duration), 0) AS sec, COUNT(*) AS cnt "
        "FROM audio_urls WHERE status = 'done' AND local_path != '' AND local_path NOT LIKE 'dup:%'"
    ).fetchone()
    print(f"    本地保留 (去重后)   {row['cnt']:>5} 条  总时长 {fmt_duration(row['sec'])}")

    row = conn.execute(
        "SELECT COALESCE(SUM(duration), 0) AS sec, COUNT(*) AS cnt "
        "FROM audio_urls"
    ).fetchone()
    print(f"    全部记录             {row['cnt']:>5} 条  总时长 {fmt_duration(row['sec'])}")


def show_category_menu(conn: sqlite3.Connection):
    rows = conn.execute(
        "SELECT category, COUNT(*) AS cnt, "
        "COALESCE(SUM(duration), 0) AS total_sec, "
        "COALESCE(SUM(file_size), 0) AS total_size "
        "FROM audio_urls WHERE category != '' "
        "GROUP BY category ORDER BY cnt DESC"
    ).fetchall()
    if not rows:
        print("  没有分类数据。")
        return

    print(f"\n{'=' * 60}")
    print("  按分类浏览")
    print(f"{'=' * 60}\n")
    cats = []
    for i, r in enumerate(rows, 1):
        cats.append(r["category"])
        print(f"    {i:>2}. {r['category']:<16s}  {r['cnt']:>5} 条  "
              f"时长 {fmt_duration(r['total_sec']):>10s}  "
              f"大小 {fmt_size(r['total_size']):>10s}")

    uncategorized = conn.execute(
        "SELECT COUNT(*) FROM audio_urls WHERE category = '' OR category IS NULL"
    ).fetchone()[0]
    if uncategorized:
        print(f"\n    (未分类: {uncategorized} 条)")

    print(f"\n    0. 返回上级菜单")
    sel = input("\n  输入编号查看该分类详情> ").strip()
    if not sel.isdigit():
        return
    idx = int(sel)
    if idx == 0:
        return
    if idx < 1 or idx > len(cats):
        print("  无效编号。")
        return

    cat = cats[idx - 1]
    show_category_detail(conn, cat)


def show_category_detail(conn: sqlite3.Connection, category: str):
    stats = conn.execute(
        "SELECT COUNT(*) AS cnt, "
        "COALESCE(SUM(duration), 0) AS total_sec, "
        "COALESCE(SUM(file_size), 0) AS total_size, "
        "COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END), 0) AS done_cnt, "
        "COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) AS pending_cnt, "
        "COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed_cnt "
        "FROM audio_urls WHERE category = ?", (category,)
    ).fetchone()

    print(f"\n{'=' * 60}")
    print(f"  分类: {category}")
    print(f"{'=' * 60}")
    print(f"  记录数:   {stats['cnt']}")
    print(f"  总时长:   {fmt_duration(stats['total_sec'])}")
    print(f"  总大小:   {fmt_size(stats['total_size'])}")
    print(f"  已完成:   {stats['done_cnt']}  待下载: {stats['pending_cnt']}  失败: {stats['failed_cnt']}")

    sources = conn.execute(
        "SELECT source, COUNT(*) AS cnt FROM audio_urls "
        "WHERE category = ? GROUP BY source ORDER BY cnt DESC", (category,)
    ).fetchall()
    if sources:
        print("  来源分布:")
        for s in sources:
            print(f"    {s['source']:<16s}  {s['cnt']}")

    speakers = conn.execute(
        "SELECT speaker, COUNT(*) AS cnt FROM audio_urls "
        "WHERE category = ? AND speaker != '' GROUP BY speaker ORDER BY cnt DESC LIMIT 10",
        (category,)
    ).fetchall()
    if speakers:
        print("  说话人 (前 10):")
        for s in speakers:
            print(f"    {s['speaker']:<20s}  {s['cnt']}")

    print()
    n = input("  显示该分类的记录? 输入条数 (直接回车跳过, a=全部): ").strip().lower()
    if n == "a":
        show_all_records(conn, category_filter=category)
    elif n.isdigit() and int(n) > 0:
        show_all_records(conn, category_filter=category, limit=int(n))


def interactive(conn: sqlite3.Connection):
    show_overview(conn)
    while True:
        print("─" * 50)
        print("  操作菜单:")
        print("    1  查看记录详情 (可指定条数)")
        print("    2  按来源筛选记录")
        print("    3  按状态筛选记录")
        print("    4  按分类筛选记录")
        print("    5  按语种筛选记录")
        print("    6  按发布时间筛选")
        print("    7  查看单条记录 (输入 ID)")
        print("    8  查看爬取检查点")
        print("    9  查看时长统计")
        print("    10 查看发布时间统计")
        print("    11 重新显示概览")
        print("    q  退出")
        print("─" * 50)
        choice = input("  请选择> ").strip().lower()

        if choice == "1":
            n = input("  显示前 N 条 (直接回车显示全部): ").strip()
            limit = int(n) if n.isdigit() else 0
            show_all_records(conn, limit=limit)
        elif choice == "2":
            sources = conn.execute(
                "SELECT DISTINCT source FROM audio_urls ORDER BY source"
            ).fetchall()
            source_names = " / ".join(r["source"] for r in sources)
            src = input(f"  输入来源名称 ({source_names}): ").strip()
            n = input("  显示前 N 条 (直接回车显示全部): ").strip()
            limit = int(n) if n.isdigit() else 0
            show_all_records(conn, source_filter=src, limit=limit)
        elif choice == "3":
            st = input("  输入状态 (pending / downloading / done / failed): ").strip()
            n = input("  显示前 N 条 (直接回车显示全部): ").strip()
            limit = int(n) if n.isdigit() else 0
            show_all_records(conn, status_filter=st, limit=limit)
        elif choice == "4":
            show_category_menu(conn)
        elif choice == "5":
            langs = conn.execute(
                "SELECT DISTINCT language FROM audio_urls WHERE language != '' ORDER BY language"
            ).fetchall()
            lang_names = " / ".join(r["language"] for r in langs)
            lang = input(f"  输入语种代码 ({lang_names}): ").strip()
            n = input("  显示前 N 条 (直接回车显示全部): ").strip()
            limit = int(n) if n.isdigit() else 0
            show_all_records(conn, language_filter=lang, limit=limit)
        elif choice == "6":
            show_published_month_menu(conn)
        elif choice == "7":
            try:
                rid = int(input("  输入记录 ID: ").strip())
                show_single_record(conn, rid)
            except ValueError:
                print("  无效 ID")
        elif choice == "8":
            show_checkpoints(conn)
        elif choice == "9":
            show_duration_stats(conn)
        elif choice == "10":
            show_published_stats(conn)
            print()
        elif choice == "11":
            show_overview(conn)
        elif choice == "q":
            print("  再见！")
            break
        else:
            print("  无效选择，请重试。")


def _parse_limit(args: list[str]) -> int:
    """从参数列表中提取 -n NUM，返回 limit 值"""
    for i, a in enumerate(args):
        if a == "-n" and i + 1 < len(args) and args[i + 1].isdigit():
            return int(args[i + 1])
    return 0


def _parse_flag_value(args: list[str], flag: str) -> str:
    """从参数列表中提取 --flag VALUE"""
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args) and not args[i + 1].startswith("-"):
            return args[i + 1]
    return ""


def main():
    args = sys.argv[1:]
    limit = _parse_limit(args)
    before = _parse_flag_value(args, "--before")

    conn = connect()
    try:
        if not args:
            interactive(conn)
        elif args[0] == "overview":
            show_overview(conn)
        elif args[0] == "all":
            show_all_records(conn, limit=limit)
        elif args[0] == "source" and len(args) > 1:
            show_all_records(conn, source_filter=args[1], limit=limit)
        elif args[0] == "status" and len(args) > 1:
            show_all_records(conn, status_filter=args[1], limit=limit)
        elif args[0] == "id" and len(args) > 1:
            show_single_record(conn, int(args[1]))
        elif args[0] == "category" and len(args) > 1:
            show_all_records(conn, category_filter=args[1], limit=limit)
        elif args[0] == "language" and len(args) > 1:
            show_all_records(conn, language_filter=args[1], limit=limit)
        elif args[0] == "since" and len(args) > 1:
            show_published_month_menu(conn, since=args[1], before=before)
        elif args[0] == "months":
            since = args[1] if len(args) > 1 and not args[1].startswith("-") else ""
            show_published_month_menu(conn, since=since, before=before)
        elif args[0] == "month" and len(args) > 1:
            show_month_records(conn, args[1], limit=limit)
        elif args[0] == "published":
            show_published_stats(conn)
            print()
            rows = _query_published_months(conn)
            if rows:
                print("  按月分布:")
                for r in rows[:24]:
                    print(f"    {r['month']}    {r['cnt']:>8} 条")
                if len(rows) > 24:
                    print(f"    ... 另有 {len(rows) - 24} 个月 "
                          f"(python db_viewer.py months 查看全部)")
                print()
        elif args[0] == "categories":
            show_category_menu(conn)
        elif args[0] == "checkpoints":
            show_checkpoints(conn)
        elif args[0] == "duration":
            show_duration_stats(conn)
        else:
            print("用法:")
            print("  python db_viewer.py                    交互式查看")
            print("  python db_viewer.py overview           数据库概览")
            print("  python db_viewer.py all [-n NUM]       所有记录详情")
            print("  python db_viewer.py source NAME [-n N] 按来源筛选")
            print("  python db_viewer.py status NAME [-n N] 按状态筛选")
            print("  python db_viewer.py category NAME [-n N] 按分类筛选")
            print("  python db_viewer.py language CODE [-n N] 按语种筛选 (如 zh, en)")
            print("  python db_viewer.py months [SINCE] [--before DATE]")
            print("                                     按月分组浏览发布时间")
            print("  python db_viewer.py since DATE [--before DATE]")
            print("                                     同 months，须指定起始日期")
            print("  python db_viewer.py month YYYY-MM [-n N]")
            print("                                     查看指定月记录")
            print("  python db_viewer.py published          发布时间填写统计")
            print("  python db_viewer.py categories         查看分类概览")
            print("  python db_viewer.py id NUM             查看指定 ID")
            print("  python db_viewer.py checkpoints        查看爬取检查点")
            print("  python db_viewer.py duration           查看时长统计")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
