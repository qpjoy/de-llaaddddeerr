# Derived verbatim from AudioSpider; see upstream/LICENSE and provenance.json.

from dataclasses import dataclass

@dataclass
class AudioRecord:
    url: str
    source: str
    title: str = ""
    file_format: str = ""
    file_size: int = 0
    duration: int = 0
    language: str = ""
    category: str = ""
    speaker: str = ""
    status: str = "pending"
    local_path: str = ""
    content_hash: str = ""
    source_id: str = ""
    published_at: str = ""
    discovered_at: str = ""
    downloaded_at: str = ""

def _parse_pubdate(text: str) -> str:
    """解析 RSS pubDate 为 ISO 8601"""
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(text)
        return dt.isoformat()
    except Exception:
        return ""

def _parse_duration(text: str) -> int:
    text = text.strip()
    if ":" in text:
        parts = [int(p) for p in text.split(":") if p.isdigit()]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        elif len(parts) == 2:
            return parts[0] * 60 + parts[1]
    if text.isdigit():
        return int(text)
    return 0
