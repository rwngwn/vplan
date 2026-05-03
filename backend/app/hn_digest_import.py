from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class ImportedDigest:
    title: str
    body: str
    source_file: str


def parse_digest_markdown(raw: str, source_file: str) -> ImportedDigest | None:
    marker = "## Ranní HN digest"
    idx = raw.find(marker)
    if idx < 0:
        return None

    body = raw[idx:].strip()
    # prefer run date from cron header if present
    run_time = ""
    for line in raw.splitlines()[:20]:
        if line.startswith("**Run Time:**"):
            run_time = line.replace("**Run Time:**", "").strip()
            break

    title = f"HN digest {run_time}".strip()
    if title == "HN digest":
        title = f"HN digest ({Path(source_file).name})"

    return ImportedDigest(title=title, body=body, source_file=source_file)


def load_digests_from_dir(dir_path: str, limit: int = 10) -> list[ImportedDigest]:
    root = Path(dir_path).expanduser()
    if not root.exists():
        return []

    files = sorted(root.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    out: list[ImportedDigest] = []
    for fp in files:
        if len(out) >= limit:
            break
        try:
            raw = fp.read_text(encoding="utf-8")
        except Exception:
            continue
        parsed = parse_digest_markdown(raw, str(fp))
        if parsed:
            out.append(parsed)
    return out
