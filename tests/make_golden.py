"""픽스처를 기존 Python 파서(InternWatch/sources/snu_career.py)로 파싱해 golden.json을 만든다.

JS 파서(collect.js)는 이 결과와 같아야 한다. Python판은 읽기만 하고 고치지 않는다.
실행: python tests/make_golden.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, r"C:\projects\InternWatch")
from sources.base import Posting  # noqa: E402
from sources.snu_career import SnuCareer  # noqa: E402

fx = HERE / "fixtures"
src = SnuCareer.__new__(SnuCareer)  # 로그인 상태 없이 파서 메서드만 쓴다
src.name = "snu"

lists = {f: [p.to_dict() for p in src.parse_list((fx / f).read_text(encoding="utf-8"))]
         for f in ("list1.html", "list2.html")}



def detail(name: str) -> dict:
    page = (fx / name).read_text(encoding="utf-8")
    src.get = lambda url: page
    p = Posting(source="snu", id="0", title="", url="")
    src.fill_detail(p)
    return {k: getattr(p, k) for k in ("company", "deadline", "fields", "body", "images", "image_urls", "attachments")}


details = {f: detail(f) for f in ("detail.html", "detail_poster.html")}

(HERE / "golden.json").write_text(
    json.dumps({"lists": lists, "details": details}, ensure_ascii=False, indent=1), encoding="utf-8")
print({f: len(v) for f, v in lists.items()}, {f: len(d["body"]) for f, d in details.items()})
