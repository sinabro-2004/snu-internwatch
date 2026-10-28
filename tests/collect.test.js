// collect.js 테스트. 실행: node --test tests/collect.test.js
// 파서는 기존 Python판(golden.json, tests/make_golden.py로 생성)과 같은 결과를 내야 한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../collect.js");

const fx = (f) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "golden.json"), "utf8"));
const LIST_KEYS = ["id", "title", "url", "company", "category", "posted", "deadline"];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

for (const f of ["list1.html", "list2.html"]) {
  test(`parseList: ${f}가 Python 파서와 같은 공고를 뽑는다`, () => {
    const got = C.parseList(fx(f)).map((p) => pick(p, LIST_KEYS));
    const want = golden.lists[f].map((p) => pick(p, LIST_KEYS));
    assert.deepEqual(got, want);
  });
}

test("parseList: 제목 앞에 새 글 배지(N)가 붙은 공고도 뽑는다(실측 10-28: 1쪽 10건 전부 배지)", () => {
  const html = fx("list1.html").replace(/(id=92295" class="tit">)/, '$1\n<span class="new">N</span>');
  const got = C.parseList(html).map((p) => pick(p, LIST_KEYS));
  assert.deepEqual(got, golden.lists["list1.html"].map((p) => pick(p, LIST_KEYS)));
});

test("parseList: 목록 표가 없으면(로그인 페이지 등) 구조 변경으로 알린다", () => {
  assert.throws(() => C.parseList("<html><body>로그인</body></html>"), /t_list/);
});

// Python판 버그 두 가지는 JS판에서 고쳤다 — 그 둘만 보정한 Python 결과와 같아야 한다.
// ① 첨부 칸 앞에서 본문을 자를 때 `<td colspan="6"` 조각이 본문 끝에 남는다(실데이터 30건 중 21건)
// ② 링크 항목(채용URL 등)의 &amp;를 풀지 않는다
// ③ 사이트의 깨진 <img src="alt=''/">를 BASE에 그대로 붙여 "https://career.snu.ac.kralt=''/" 같은 주소를 만든다
function fixPythonBugs(d) {
  const body = d.body.replace(/\n?<td[^\n]*$/, "");
  const fields = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, v.startsWith("http") ? v.replaceAll("&amp;", "&") : v]));
  const junk = (u) => u.startsWith("https://career.snu.ac.kr") && !u.startsWith("https://career.snu.ac.kr/");
  const image_urls = d.image_urls.filter((u) => !junk(u));
  return { ...d, body, fields, image_urls, images: d.images - (d.image_urls.length - image_urls.length) };
}

for (const f of ["detail.html", "detail_poster.html"]) {
  test(`parseDetail: ${f}에서 Python 파서와 같은 회사·마감·항목·본문·이미지·첨부를 뽑는다`, () => {
    assert.deepEqual(C.parseDetail(fx(f)), fixPythonBugs(golden.details[f]));
  });
}

// 가짜 사이트: 목록 1·2쪽은 픽스처, 3쪽부터는 1쪽을 다시 준다(실제 게시판은 끝없이 이어진다). 상세는 모두 detail.html
function fakeSite({ login = false } = {}) {
  const calls = [];
  const pages = { 1: fx("list1.html"), 2: fx("list2.html") };
  const fetchText = async (url) => {
    calls.push(url);
    if (login) return '<script>location.href="/student/login/login?returnUrl=x"</script>';
    const page = url.match(/internship\?page=(\d+)/);
    if (page) return pages[page[1]] ?? pages[1];
    if (url.includes("internship/view")) return fx("detail.html");
    throw new Error("예상 밖 URL " + url);
  };
  return { calls, fetchText, sleep: async () => {} };
}
const ids = (ps) => ps.map((p) => p.id);
const listIds = (f) => golden.lists[f].map((p) => p.id);

test("collect: 마감 안 지난 새 공고만 상세까지 받고, 지난 공고는 사유와 함께 건너뛴다", async () => {
  const site = fakeSite();
  const r = await C.collect({ ...site, seen: new Set(), today: "2026-10-12", maxPages: 2 });
  const expired = ["92294", "92258"]; // 마감 10-11, 10-09
  const want = [...listIds("list1.html"), ...listIds("list2.html")].filter((id) => !expired.includes(id));
  assert.deepEqual(ids(r.postings), want);
  assert.deepEqual(ids(r.skipped), expired);
  assert.match(r.skipped[0].reason, /마감/);
  assert.equal(r.postings[0].body, C.parseDetail(fx("detail.html")).body);
  assert.equal(site.calls.filter((u) => u.includes("internship/view")).length, want.length);
});

test("collect: 한 쪽이 전부 본 공고면 거기서 멈춘다", async () => {
  const site = fakeSite();
  const seen = new Set(listIds("list2.html"));
  const r = await C.collect({ ...site, seen, today: "2026-10-01", maxPages: 15 });
  assert.deepEqual(ids(r.postings), listIds("list1.html"));
  assert.equal(site.calls.filter((u) => u.includes("internship?page=")).length, 2);
});

test("collect: 쪽이 밀려 같은 공고가 두 번 보여도 한 번만 받는다", async () => {
  const site = fakeSite(); // 3쪽 = 1쪽 반복
  const r = await C.collect({ ...site, seen: new Set(), today: "2026-10-01", maxPages: 3 });
  assert.equal(new Set(ids(r.postings)).size, r.postings.length);
});

test("collect: 로그인 페이지로 튕기면 로그인 안내 오류를 낸다", async () => {
  const site = fakeSite({ login: true });
  await assert.rejects(C.collect({ ...site, seen: new Set(), today: "2026-10-12", maxPages: 2 }), /로그인/);
});

async function collected() {
  return (await C.collect({ ...fakeSite(), seen: new Set(), today: "2026-10-12", maxPages: 2 })).postings;
}

test("toFiles: 정해진 건수씩 나누고 파일 이름에 날짜와 순번을 단다", async () => {
  const files = C.toFiles(await collected(), { date: "2026-10-12", size: 10 });
  assert.deepEqual(files.map((f) => f.name), ["인턴공고_2026-10-12_1of2.md", "인턴공고_2026-10-12_2of2.md"]);
});

test("toFiles: 파일마다 건수를 고르게 나눈다(81건·상한 20 → 17·16·16·16·16)", () => {
  const ps = Array.from({ length: 81 }, (_, i) => ({ id: String(i), title: "t", url: "u", deadline: "", fields: {}, body: "" }));
  const counts = C.toFiles(ps, { date: "d", size: 20 }).map((f) => Number(f.text.match(/^공고 (\d+)건/m)[1]));
  assert.deepEqual(counts, [17, 16, 16, 16, 16]);
});

test("toFiles: 모든 공고가 정확히 한 번 들어가고, 파일 머리의 id 목록이 본문 공고와 같다", async () => {
  const ps = await collected();
  const files = C.toFiles(ps, { date: "2026-10-12", size: 10 });
  const sections = files.flatMap((f) => [...f.text.matchAll(/^## 공고 (\d+)$/gm)].map((m) => m[1]));
  assert.deepEqual(sections, ids(ps));
  for (const f of files) {
    const header = f.text.match(/^공고 (\d+)건 — id: (.+)$/m);
    const inFile = [...f.text.matchAll(/^## 공고 (\d+)$/gm)].map((m) => m[1]);
    assert.equal(Number(header[1]), inFile.length);
    assert.deepEqual(header[2].split(", "), inFile);
  }
});

test("toFiles: 공고마다 제목·회사·마감·링크·본문을 담고, 긴 본문은 잘랐다고 밝힌다", async () => {
  const p = (await collected())[0];
  const text = C.toFiles([p], { date: "2026-10-12", bodyChars: 100 })[0].text;
  for (const s of [p.title, p.company, p.deadline, p.url, p.fields["근무지역"], p.body.slice(0, 100)]) assert.ok(text.includes(s), s);
  assert.ok(!text.includes(p.body.slice(0, 101)));
  assert.match(text, new RegExp(`본문 ${p.body.length}자 중 앞 100자`));
});

test("toFiles: 본문 이미지·첨부가 있으면 개수를 적는다", () => {
  const d = C.parseDetail(fx("detail_poster.html"));
  const p = { id: "1", title: "t", url: "u", company: "c", category: "", posted: "", deadline: "채용시까지", ...d };
  const text = C.toFiles([p], { date: "2026-10-12" })[0].text;
  assert.match(text, /본문 이미지 3개/);
  assert.match(text, /첨부 2개/);
});

const post = (id, body, image_urls) => ({ id, title: "t", url: "u", deadline: "", fields: {}, body, image_urls, images: image_urls.length });

test("posterTargets: 본문 텍스트가 짧고 이미지가 있는 공고만 포스터로 고르고, 공고당 3장까지 이름을 붙인다", () => {
  const ps = [
    post("1", "", ["https://career.snu.ac.kr/a", "https://career.snu.ac.kr/b"]),
    post("2", "x".repeat(1000), ["https://career.snu.ac.kr/c"]), // 본문이 충분 — 포스터 아님
    post("3", "짧음", []),                                        // 이미지 없음
    post("4", "#해시태그", ["1", "2", "3", "4"].map((n) => "https://x.com/" + n)),
  ];
  assert.deepEqual(C.posterTargets(ps), [
    { id: "1", url: "https://career.snu.ac.kr/a", name: "포스터_1_1" },
    { id: "1", url: "https://career.snu.ac.kr/b", name: "포스터_1_2" },
    { id: "4", url: "https://x.com/1", name: "포스터_4_1" },
    { id: "4", url: "https://x.com/2", name: "포스터_4_2" },
    { id: "4", url: "https://x.com/3", name: "포스터_4_3" },
  ]);
});

test("toFiles: 포스터 공고에는 따로 받은 포스터 파일 이름을 적어 GPT가 짝지을 수 있게 한다", () => {
  const text = C.toFiles([post("7", "", ["https://career.snu.ac.kr/a", "https://career.snu.ac.kr/b"])], { date: "d" })[0].text;
  assert.match(text, /포스터 파일: 포스터_7_1, 포스터_7_2/);
});

test("imageExt: 서버 Content-Type이 틀려도(실측: PNG를 image/jpg로 보냄) 파일 첫 바이트로 확장자를 정한다", () => {
  assert.equal(C.imageExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), ".png");
  assert.equal(C.imageExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), ".jpg");
  assert.equal(C.imageExt(new Uint8Array([0x47, 0x49, 0x46, 0x38])), ".gif");
  assert.equal(C.imageExt(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), ".webp");
  assert.equal(C.imageExt(new Uint8Array([0x3c, 0x68, 0x74, 0x6d])), null); // HTML(로그인 페이지 등)은 이미지가 아니다
});

test("jpegsToPdf: JPEG 조각마다 그 크기의 쪽을 하나씩 만들고, xref 오프셋이 각 객체를 정확히 가리킨다", () => {
  const tiles = [
    { bytes: new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "tile_a.jpg"))), width: 100, height: 140 },
    { bytes: new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "tile_b.jpg"))), width: 120, height: 60 },
  ];
  const pdf = Buffer.from(C.jpegsToPdf(tiles));
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 2);
  assert.match(text, /\/MediaBox \[0 0 100 140\]/);
  assert.match(text, /\/MediaBox \[0 0 120 60\]/);
  // 원본 JPEG 바이트가 그대로 들어 있다(재인코딩 없음)
  assert.ok(pdf.includes(Buffer.from(tiles[0].bytes)) && pdf.includes(Buffer.from(tiles[1].bytes)));
  const xref = Number(text.match(/startxref\s+(\d+)/)[1]);
  assert.equal(text.slice(xref, xref + 4), "xref");
  const entries = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n\s*$/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

test("tileRects: 폭을 1000px 이하로 줄이고 1400px 높이씩 자른다(GPT가 긴 이미지를 줄여 작은 글씨를 못 읽어서)", () => {
  // 실측 최장 포스터 2062×17620 → 1000×8545, 7조각
  const r = C.tileRects(2062, 17620);
  assert.equal(r.width, 1000);
  assert.equal(r.height, 8545);
  assert.equal(r.tiles.length, 7);
  assert.deepEqual(r.tiles[0], { y: 0, h: 1400 });
  assert.deepEqual(r.tiles.at(-1), { y: 8400, h: 145 });
  // 작은 포스터는 키우지 않고 한 조각
  assert.deepEqual(C.tileRects(734, 1090), { width: 734, height: 1090, tiles: [{ y: 0, h: 1090 }] });
});

test("parseDetail: 본문 끝에 첨부 칸의 태그 조각이 남지 않는다", () => {
  assert.doesNotMatch(C.parseDetail(fx("detail.html")).body, /<td/);
});
