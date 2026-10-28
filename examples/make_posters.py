"""합성 예제용 포스터 PDF를 만든다 — 회사·공고는 모두 가짜다.

수집 북마크가 만드는 PDF와 같은 모양으로 만든다: 쪽마다 위에 50px 이름표(`포스터_<id>_<n>  (k/N)`)를 붙이고,
JPEG 조각을 collect.js의 jpegsToPdf로 묶는다.
- 90008: 포스터 1장 — 업무·자격이 포스터에만 있다
- 90009: 포스터 2장 중 1장만 넣는다(포스터 일부를 못 받은 경우). 자격요건은 빠진 2장째에 있다는 문구를 넣었다
실행: python examples/make_posters.py  (Pillow, node 필요. 한글 글꼴은 Windows 맑은 고딕)
"""
import io
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT = "C:/Windows/Fonts/malgun.ttf"
LABEL_BAR = 50  # collect.js와 같은 이름표 높이

POSTERS = [
    ("포스터_90008_1", ["거너캐피탈", "투자심사 인턴 모집", "",
                        "담당 업무", "· 투자 대상 기업 재무 분석", "· 투자심사 보고서 초안 작성", "· 포트폴리오 기업 모니터링", "",
                        "지원 자격", "· 4년제 대학 재학생(학년 무관)", "",
                        "근무지: 서울 강남구", "기간: 6개월, 주 5일", "마감: 2099년 11월 30일"]),
    ("포스터_90009_1", ["너더인베스트", "VC 심사역 인턴", "",
                        "담당 업무", "· 스타트업 발굴·초기 검토", "· 산업 리서치", "",
                        "근무지: 서울", "", "※ 지원 자격과 우대 사항은 다음 장에 있습니다"]),
]


def page(name: str, lines: list[str]) -> dict:
    w, h = 900, 1100
    img = Image.new("RGB", (w, h + LABEL_BAR), "white")
    d = ImageDraw.Draw(img)
    d.text((12, 8), f"{name}  (1/1)", font=ImageFont.truetype(FONT, 26), fill="black")
    d.rectangle([20, LABEL_BAR + 20, w - 20, h + LABEL_BAR - 20], outline="#1f4e79", width=6)
    y = LABEL_BAR + 70
    for i, ln in enumerate(lines):
        size = 52 if i < 2 else 34
        d.text((70, y), ln, font=ImageFont.truetype(FONT, size), fill="#1f4e79" if i < 2 else "black")
        y += size + 22
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return {"bytes": list(buf.getvalue()), "width": img.width, "height": img.height}


pages = [page(n, ls) for n, ls in POSTERS]
js = ("const C=require(process.argv[1]);const t=JSON.parse(require('fs').readFileSync(0,'utf8'))"
      ".map(p=>({...p,bytes:Uint8Array.from(p.bytes)}));process.stdout.write(Buffer.from(C.jpegsToPdf(t)))")
pdf = subprocess.run(["node", "-e", js, str(HERE.parent / "collect.js")],
                     input=json.dumps(pages).encode(), capture_output=True, check=True).stdout
out = HERE / "포스터_2099-11-06.pdf"
out.write_bytes(pdf)
print(f"{len(pages)}쪽 → {out} ({len(pdf)} bytes)")
