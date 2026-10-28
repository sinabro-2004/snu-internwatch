"""정답 라벨 vs GPT 판정 교차표.

labels.txt — 라벨 페이지 "결과 복사" 내용(첫 줄 '라벨', 그다음 `id<TAB>관심|애매|없음|-`)
gpt.txt    — GPT 답 전문(브라우저 innerText). 구획 제목(추천·참고·직접 확인·제외) 아래에 `(id)`가 붙어 있다.
실행: python eval/compare.py eval/labels.txt eval/gpt_2026-10-28_bbagi.tsv  (판정 파일은 .tsv: id<TAB>구획)
"""
import re
import sys
from collections import Counter
from pathlib import Path

SECTIONS = [("추천", r"^\s*\d\)?\.?\s*\**추천"), ("참고", r"^\s*\d\)?\.?\s*\**참고"),
            ("직접 확인", r"^\s*\d\)?\.?\s*\**직접 확인"), ("제외", r"^\s*\d\)?\.?\s*\**제외")]


def gpt_verdicts(text: str) -> dict[str, str]:
    """id → 구획. 한 id가 여러 번 나오면 처음 나온 구획(요약 문단의 재언급은 뒤에 온다)."""
    out, cur = {}, None
    for ln in text.splitlines():
        for name, pat in SECTIONS:
            if re.match(pat, ln):
                cur = name
        if ln.startswith("검사:"):
            break
        for i in re.findall(r"\((\d{5})\)", ln):
            if cur and i not in out:
                out[i] = cur
    return out


def labels(text: str) -> dict[str, str]:
    return dict(ln.split("\t") for ln in text.splitlines()[1:] if "\t" in ln)


lab = labels(Path(sys.argv[1]).read_text(encoding="utf-8"))
src = Path(sys.argv[2])
if src.suffix == ".tsv":  # 브라우저에서 뽑아 둔 id<TAB>구획[<TAB>이유](추천5 등 점수는 떼어 낸다). '#' 줄은 메모
    rows = (ln.split("\t") for ln in src.read_text(encoding="utf-8-sig").splitlines() if ln and not ln.startswith("#"))
    gpt = {k: re.sub(r"\d", "", v) for k, v, *_ in rows}
else:
    gpt = gpt_verdicts(src.read_text(encoding="utf-8"))
ids = [i for i in lab if lab[i] != "-"]
missing = [i for i in ids if i not in gpt]
print(f"라벨 {len(ids)}건, GPT 판정에서 찾은 것 {len(ids) - len(missing)}건, 빠짐 {missing}")

cols = ["추천", "참고", "직접 확인", "제외", "(없음)"]
tab = Counter((lab[i], gpt.get(i, "(없음)")) for i in ids)
print("\n라벨 \\ GPT | " + " | ".join(cols))
for r in ["관심", "애매", "없음"]:
    print(f"{r} | " + " | ".join(str(tab[(r, c)]) for c in cols))

want = [i for i in ids if lab[i] == "관심"]
hit = [i for i in want if gpt.get(i) == "추천"]
check = [i for i in want if gpt.get(i) == "직접 확인"]
lost = [i for i in want if gpt.get(i) in ("참고", "제외", None)]
fp = [i for i in ids if gpt.get(i) == "추천" and lab[i] == "없음"]
print(f"\n관심 {len(want)}건 → 추천 {len(hit)} · 직접 확인 {len(check)} · 놓침(참고·제외·누락) {len(lost)} {lost}")
print(f"추천했는데 관심 없음(오탐) {len(fp)} {fp}")
