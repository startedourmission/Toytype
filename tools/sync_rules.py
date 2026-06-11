#!/usr/bin/env python3
"""규칙 시트 → rules.json 동기화.

8개 탭, 오기→교정 2컬럼 쌍으로 구성된 규칙 시트를 gws CLI로 읽어
확장 프로그램이 쓰는 rules.json(확장 루트)으로 변환한다.

실행: python3 tools/sync_rules.py   (확장 루트에서)
요구: gws CLI 인증 완료 상태
"""
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

SHEET_ID = "1TONriTcFIHiT9Bstm0pv9iH0QiBjfBpodeo02CiY98Y"

# (탭 이름, 카테고리 id, 표시 라벨, 기본 활성화)
TABS = [
    ("1. 수정본20230314", "convert", "표기 변환", True),
    ("2. 맞춤법", "spelling", "맞춤법", True),
    ("3. 존대와 복수", "plural", "존대와 복수", True),
    ("4. 높임말 서술어", "honorific", "높임말 서술어", True),
    ("5. 공백1(추가불가)", "space1", "공백 1 (조사 앞 공백)", True),
    ("6. 공백2", "space2", "공백 2 (붙여쓰기)", True),
    ("7. 공백3", "space3", "공백 3 (값 붙이기)", True),
    ("8. 맨마지막", "final", "맨마지막 (최종 점검)", True),
]

OUT = Path(__file__).resolve().parent.parent / "rules.json"


def fetch_tab(title: str) -> list[list[str]]:
    params = json.dumps({"spreadsheetId": SHEET_ID, "range": f"{title}!A:B"})
    proc = subprocess.run(
        ["gws", "sheets", "spreadsheets", "values", "get", "--params", params],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"  ! {title}: gws 실패 — {proc.stderr.strip()[:200]}", file=sys.stderr)
        sys.exit(1)
    return json.loads(proc.stdout).get("values", [])


def main() -> None:
    categories = []
    total = 0
    for title, cat_id, label, default_on in TABS:
        rows = fetch_tab(title)
        seen: set[str] = set()
        rules: list[list[str]] = []
        for row in rows:
            if len(row) < 2:
                continue
            src, dst = row[0], row[1]
            # 공백 탭은 앞뒤 공백이 규칙의 일부이므로 strip하지 않는다.
            if not src or src == dst or src in seen:
                continue
            # 교정 결과가 비어 있는 행(삭제 규칙)도 그대로 둔다. 표시만 하므로 안전.
            seen.add(src)
            rules.append([src, dst])
        categories.append({
            "id": cat_id,
            "label": label,
            "defaultOn": default_on,
            "rules": rules,
        })
        total += len(rules)
        print(f"  {title}: {len(rules)}개")

    out = {
        "version": date.today().isoformat(),
        "source": SHEET_ID,
        "categories": categories,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"총 {total}개 규칙 → {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
