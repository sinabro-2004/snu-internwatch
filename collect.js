// SNU InternWatch 수집 스크립트 — 경력개발센터 인턴 게시판에서 새 공고를 모아 GPT에 올릴 파일로 내려받는다.
// 파서는 InternWatch Python판(sources/snu_career.py)을 옮긴 것이다. 같은 HTML에서 같은 결과를 낸다(tests/).
(function () {
  "use strict";

  const BASE = "https://career.snu.ac.kr";

  const ROW_RE = /<tr>(.*?)<\/tr>/gs;
  const VIEW_RE = /href="([^"]*internship\/view\?[^"]*?id=(\d+))"/;
  const TITLE_RE = /class="tit">\s*<p>(.*?)<\/p>/s;
  const CELL_RE = /<td data-th="([^"]+)"[^>]*>(.*?)<\/td>/gs;
  const PAIR_RE = /<th>(.*?)<\/th>\s*<td[^>]*>(.*?)<\/td>/gs;
  const TAG_RE = /<[^>]+>/g;
  const SKIP_FIELDS = new Set(["기업명", "마감일", "등록일", "제목", "사업자번호"]);

  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·",
    hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
    times: "×", rarr: "→", larr: "←", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™" };

  function unescape(s) {
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(n);
      }
      return ENTITIES[e] ?? m;
    });
  }

  function clean(s) {
    return unescape(s.replace(TAG_RE, " ")).replace(/\s+/g, " ").trim();
  }

  // Python str.splitlines()와 같은 줄 경계
  const LINE_BREAK = new RegExp("\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]");

  function htmlToText(s) {
    s = s.replace(/<(br|\/p|\/li|\/h\d|\/tr|\/div)[^>]*>/gi, "\n");
    s = s.replace(/<li[^>]*>/gi, "- ");
    s = unescape(s.replace(TAG_RE, ""));
    return s.split(LINE_BREAK).map((ln) => ln.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  }

  function absolute(u) {
    return u.startsWith("http") ? u : BASE + u;
  }

  function parseList(pageHtml) {
    const start = pageHtml.indexOf('class="t_list"');
    if (start < 0) throw new Error("목록 표(table.t_list)를 찾지 못함 — 페이지 구조가 바뀌었을 수 있음");
    const tbody = pageHtml.slice(start, pageHtml.indexOf("</tbody>", start));
    const out = [];
    for (const [, row] of tbody.matchAll(ROW_RE)) {
      const m = row.match(VIEW_RE);
      const t = row.match(TITLE_RE);
      if (!(m && t)) continue;
      const cells = {};
      for (const [, k, v] of row.matchAll(CELL_RE)) cells[k] = clean(v);
      const title = clean(t[1]);
      const company = title.match(/^\[([^\]]+)\]/);
      out.push({
        id: m[2], title, url: absolute(unescape(m[1])),
        company: company ? company[1] : "",
        category: cells["기업분류"] ?? "", posted: cells["작성일"] ?? "", deadline: cells["마감일"] ?? "",
      });
    }
    return out;
  }

  // 상세 페이지 → 목록에 없는 정보. 회사·마감은 상세 표에 있을 때만 돌려준다(목록 값을 덮어쓴다)
  function parseDetail(s) {
    const pairs = {};
    for (const [, k, v] of s.matchAll(PAIR_RE)) pairs[clean(k)] = v;
    const d = {};
    if ("기업명" in pairs) d.company = clean(pairs["기업명"]);
    if ("마감일" in pairs) d.deadline = clean(pairs["마감일"]);
    d.fields = {};
    for (const [k, v] of Object.entries(pairs)) {
      if (SKIP_FIELDS.has(k)) continue;
      const link = v.match(/href="(http[^"]+)"/);
      d.fields[k] = link ? unescape(link[1]) : clean(v);
    }
    d.body = "";
    d.images = 0;
    d.image_urls = [];
    d.attachments = 0;
    const b0 = s.indexOf('class="con_box');
    const b1 = b0 >= 0 ? s.indexOf('class="td_file"', b0) : -1;
    if (b0 >= 0) {
      // 첨부 칸 태그(<td ... class="td_file">)의 여는 '<' 앞에서 자른다 — Python판은 태그 조각을 남겼다
      const raw = s.slice(s.indexOf(">", b0) + 1, b1 > 0 ? s.lastIndexOf("<", b1) : undefined);
      d.body = htmlToText(raw);
      // 사이트에 <img src="alt=''/"> 같은 깨진 태그가 있어서 주소 꼴(http·/·data:)인 것만 센다
      const srcs = [...raw.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)].map((m) => unescape(m[1]))
        .filter((u) => /^(https?:|\/|data:)/.test(u));
      d.image_urls = srcs.filter((u) => !u.startsWith("data:")).map(absolute);
      d.images = srcs.length;
    }
    if (b1 > 0) {
      const files = s.slice(b1, s.indexOf("</td>", b1));
      d.attachments = (files.match(/<a\b/gi) || []).length;
    }
    return d;
  }

  const LIST_URL = BASE + "/student/employment/internship?page=";
  const LOGIN_MARK = "/student/login/login";

  function expired(deadline, today) {
    return /^\d{4}-\d{2}-\d{2}$/.test(deadline.trim()) && deadline.trim() < today;
  }

  // 새 공고를 모아 상세까지 채운다. fetchText(url) → HTML, sleep(ms)은 바깥에서 넣는다(브라우저·테스트 공용).
  // seen: 예전에 받은 공고 id. today: "YYYY-MM-DD". 돌려주는 skipped(마감 지남)도 seen에 넣으면 된다.
  async function collect({ fetchText, sleep, seen, today, maxPages = 10, interval = 1500, onProgress = () => {} }) {
    async function get(url) {
      const s = await fetchText(url);
      if (s.slice(0, 1000).includes(LOGIN_MARK)) throw new Error("로그인이 풀렸습니다. 경력개발센터에 다시 로그인한 뒤 실행해 주세요.");
      await sleep(interval);
      return s;
    }
    const taken = new Set(seen);
    const fresh = [];
    const skipped = [];
    for (let page = 1; page <= maxPages; page++) {
      onProgress(`목록 ${page}쪽 확인 중`);
      const rows = parseList(await get(LIST_URL + page)).filter((p) => !taken.has(p.id));
      if (!rows.length) break; // 한 쪽이 전부 본 공고면 그 뒤도 본 것
      for (const p of rows) {
        taken.add(p.id);
        if (expired(p.deadline, today)) skipped.push({ ...p, reason: `마감 지남(${p.deadline})` });
        else fresh.push(p);
      }
    }
    for (const [i, p] of fresh.entries()) {
      onProgress(`상세 ${i + 1}/${fresh.length} 받는 중`);
      Object.assign(p, parseDetail(await get(p.url)));
    }
    return { postings: fresh, skipped };
  }

  const SHOW_FIELDS = ["업종", "직종", "채용형태", "근무지역", "채용URL"];
  const POSTER_MAX_BODY = 300; // 본문 텍스트가 이보다 짧고 이미지가 있으면 내용이 포스터에 있다고 본다(실측 81건 중 21건)
  const POSTER_PER_POSTING = 3;

  function posterNames(p) {
    if ((p.body || "").length >= POSTER_MAX_BODY) return [];
    return (p.image_urls || []).slice(0, POSTER_PER_POSTING).map((url, i) => ({ id: p.id, url, name: `포스터_${p.id}_${i + 1}` }));
  }

  // 파일 첫 바이트로 이미지인지(와 형식) 확인한다. 사이트가 PNG를 "image/jpg"로 보내는 등 Content-Type을 믿을 수 없고,
  // 로그인이 풀리면 이미지 대신 HTML이 온다
  function imageExt(b) {
    const at = (i, ...xs) => xs.every((x, j) => b[i + j] === x);
    if (at(0, 0x89, 0x50, 0x4e, 0x47)) return ".png";
    if (at(0, 0xff, 0xd8, 0xff)) return ".jpg";
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return ".gif";
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return ".webp";
    return null;
  }

  // 포스터 PDF에 넣을 이미지 목록
  function posterTargets(postings) {
    return postings.flatMap(posterNames);
  }

  // 긴 포스터를 자를 자리. GPT는 큰 이미지를 줄여서 보므로(2062×17620 포스터의 작은 글씨를 못 읽음)
  // 폭을 maxW 이하로 줄이고 tileH씩 자른다. 좌표는 줄인 뒤 기준
  function tileRects(w, h, maxW = 1000, tileH = 1400) {
    const s = Math.min(1, maxW / w);
    const width = Math.round(w * s);
    const height = Math.round(h * s);
    const tiles = [];
    for (let y = 0; y < height; y += tileH) tiles.push({ y, h: Math.min(tileH, height - y) });
    return { width, height, tiles };
  }

  // JPEG 조각들을 쪽 하나씩 담은 PDF로 묶는다. JPEG는 다시 인코딩하지 않고 그대로 넣는다(DCTDecode).
  // 객체 번호: 1 Catalog, 2 Pages, 쪽 k마다 3+3k Page, 4+3k 내용, 5+3k 이미지
  function jpegsToPdf(tiles) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let size = 0;
    const put = (x) => {
      const b = typeof x === "string" ? enc.encode(x) : x;
      chunks.push(b);
      size += b.length;
    };
    const obj = (n, body) => {
      offsets[n - 1] = size;
      put(`${n} 0 obj\n`);
      for (const part of body) put(part);
      put("\nendobj\n");
    };
    put("%PDF-1.4\n");
    const kids = tiles.map((_, k) => `${3 + 3 * k} 0 R`).join(" ");
    obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    obj(2, [`<< /Type /Pages /Kids [${kids}] /Count ${tiles.length} >>`]);
    tiles.forEach((t, k) => {
      const [page, content, image] = [3 + 3 * k, 4 + 3 * k, 5 + 3 * k];
      const draw = `q ${t.width} 0 0 ${t.height} 0 0 cm /Im0 Do Q`;
      obj(page, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${t.width} ${t.height}] ` +
        `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`]);
      obj(content, [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`]);
      obj(image, [`<< /Type /XObject /Subtype /Image /Width ${t.width} /Height ${t.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${t.bytes.length} >>\nstream\n`,
        t.bytes, "\nendstream"]);
    });
    const xref = size;
    put(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) put(`${String(off).padStart(10, "0")} 00000 n \n`);
    put(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  function postingMd(p, bodyChars) {
    const lines = [`## 공고 ${p.id}`, `- 제목: ${p.title}`];
    lines.push(`- 회사: ${p.company || "(제목 참고)"}${p.category ? ` (사이트 분류: ${p.category})` : ""}`);
    lines.push(`- 마감일: ${p.deadline || "불명"}${p.posted ? ` · 작성일: ${p.posted}` : ""}`);
    for (const k of SHOW_FIELDS) if (p.fields?.[k] && p.fields[k] !== "-") lines.push(`- ${k}: ${p.fields[k]}`);
    lines.push(`- 링크: ${p.url}`);
    const extra = [p.images && `본문 이미지 ${p.images}개`, p.attachments && `첨부 ${p.attachments}개`].filter(Boolean);
    if (extra.length) lines.push(`- ${extra.join(", ")} (내용은 이 파일에 없음 — 링크에서 확인)`);
    const posters = posterNames(p);
    if (posters.length) lines.push(`- 포스터 파일: ${posters.map((t) => t.name).join(", ")} (포스터 PDF에서 이 이름이 적힌 쪽 — 함께 올렸으면 본문으로 본다)`);
    const body = p.body || "";
    lines.push("", "### 본문", body ? body.slice(0, bodyChars) : "(본문 텍스트 없음)");
    if (body.length > bodyChars) lines.push(`(본문 ${body.length}자 중 앞 ${bodyChars}자)`);
    return lines.join("\n");
  }

  // GPT에 올릴 마크다운 파일들. 큰 파일은 GPT가 일부만 읽을 수 있어서 size건씩 나누고,
  // 머리에 id 목록을 적어 "받은 공고 수 = 판정한 공고 수"를 GPT가 스스로 맞춰 보게 한다.
  function toFiles(postings, { date, size = 20, bodyChars = 5000 }) {
    // 상한 size를 넘지 않는 최소 개수의 파일에 고르게 나눈다(20·20·1 대신 14·14·13)
    const n = Math.ceil(postings.length / size);
    const chunks = [];
    for (let i = 0, start = 0; i < n; i++) {
      const len = Math.floor(postings.length / n) + (i < postings.length % n ? 1 : 0);
      chunks.push(postings.slice(start, (start += len)));
    }
    return chunks.map((chunk, i) => ({
      name: `인턴공고_${date}_${i + 1}of${chunks.length}.md`,
      text: [
        `# 서울대 경력개발센터 인턴 공고 — ${date} 수집, 파일 ${i + 1}/${chunks.length}`,
        "",
        `공고 ${chunk.length}건 — id: ${chunk.map((p) => p.id).join(", ")}`,
        "",
        ...chunk.map((p) => postingMd(p, bodyChars) + "\n"),
      ].join("\n"),
    }));
  }

  // ── 브라우저: 북마크로 실행 ──────────────────────────────────────────────
  const SEEN_KEY = "snu-internwatch:seen";
  const LAST_KEY = "snu-internwatch:last"; // 마지막으로 만든 파일 — 받기 전에 패널을 닫아도 다시 받을 수 있게

  function loadSeen() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function saveSeen(seen) {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  }

  function panel() {
    document.getElementById("snu-iw")?.remove();
    const box = document.createElement("div");
    box.id = "snu-iw";
    box.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;" +
      "background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);" +
      "font:14px/1.5 sans-serif;padding:12px 14px";
    box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b>InternWatch 수집</b><button data-x style="border:0;background:none;font-size:18px;cursor:pointer">×</button></div>' +
      '<div data-msg></div><div data-files style="margin-top:8px"></div><div data-foot style="margin-top:10px;font-size:12px;color:#666"></div>';
    box.querySelector("[data-x]").onclick = () => box.remove();
    document.body.appendChild(box);
    return {
      msg: (t) => (box.querySelector("[data-msg]").textContent = t),
      box,
    };
  }

  function button(label, onclick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "margin:2px 4px 2px 0;padding:3px 8px;cursor:pointer";
    b.onclick = onclick;
    return b;
  }

  function download(file) {
    saveBlob(new Blob([file.text], { type: "text/markdown;charset=utf-8" }), file.name);
  }

  function saveBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  }

  function showFiles(ui, files) {
    const list = ui.box.querySelector("[data-files]");
    for (const f of files) {
      const row = document.createElement("div");
      row.style.cssText = "padding:4px 0;border-top:1px solid #eee";
      row.append(f.name + " ", button("받기", () => download(f)),
        button("복사", async (e) => {
          await navigator.clipboard.writeText(f.text);
          e.target.textContent = "복사됨";
        }));
      list.appendChild(row);
    }
  }

  const LABEL_BAR = 50; // PDF 쪽마다 위에 붙이는 이름표 높이 — GPT가 쪽을 공고 id에 짝짓는 근거

  // 포스터 하나를 받아 조각낸 JPEG들로 만든다. 다른 사이트 이미지는 CORS로 막힐 수 있다 — 예외를 그대로 올린다
  async function posterTiles(t) {
    const r = await fetch(t.url, { credentials: t.url.startsWith(BASE) ? "same-origin" : "omit" });
    const blob = await r.blob();
    if (!r.ok || !imageExt(new Uint8Array(await blob.slice(0, 12).arrayBuffer()))) throw new Error(String(r.status));
    const img = await createImageBitmap(blob);
    const g = tileRects(img.width, img.height);
    const s = g.width / img.width;
    const out = [];
    for (const [k, tile] of g.tiles.entries()) {
      const c = document.createElement("canvas");
      c.width = g.width;
      c.height = tile.h + LABEL_BAR;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#000";
      ctx.font = "bold 26px sans-serif";
      ctx.fillText(`${t.name}  (${k + 1}/${g.tiles.length})`, 12, 34);
      ctx.drawImage(img, 0, tile.y / s, img.width, tile.h / s, 0, LABEL_BAR, g.width, tile.h);
      const jpg = await new Promise((done) => c.toBlob(done, "image/jpeg", 0.85));
      out.push({ bytes: new Uint8Array(await jpg.arrayBuffer()), width: c.width, height: c.height });
    }
    img.close();
    return out;
  }

  // 포스터를 모두 조각내 PDF 하나로 받는다. 여러 파일을 따로 받으면 Chrome이 "여러 파일 다운로드"를 막을 수 있고,
  // 긴 포스터 원본은 GPT가 줄여 보느라 작은 글씨를 못 읽는다(10-26 시험: 원본 6장 vs 조각 PDF — PDF만 졸업 조건까지 읽음)
  function showPosters(ui, targets, date) {
    if (!targets.length) return;
    const row = document.createElement("div");
    row.style.cssText = "padding:6px 0;border-top:1px solid #eee";
    const note = document.createElement("div");
    note.style.cssText = "font-size:12px;color:#666";
    note.textContent = `본문이 이미지뿐인 공고의 포스터 ${targets.length}장. 공고 파일과 함께 GPT에 올리면 포스터도 읽고 판정합니다.`;
    const name = `포스터_${date}.pdf`;
    const b = button(`포스터 PDF 받기 (${targets.length}장)`, async () => {
      b.disabled = true;
      const pages = [];
      const failed = [];
      for (const [i, t] of targets.entries()) {
        b.textContent = `포스터 ${i + 1}/${targets.length} 처리 중`;
        try {
          pages.push(...(await posterTiles(t)));
        } catch {
          failed.push(t.name);
        }
        await new Promise((done) => setTimeout(done, 500));
      }
      if (pages.length) saveBlob(new Blob([jpegsToPdf(pages)], { type: "application/pdf" }), name);
      b.textContent = pages.length ? `${name} 받음 (${pages.length}쪽)` : "포스터를 하나도 받지 못했습니다";
      b.disabled = pages.length > 0;
      if (failed.length) note.textContent = `못 받은 포스터(다른 사이트 이미지): ${failed.join(", ")} — GPT가 '직접 확인'으로 남깁니다.`;
    });
    row.append(b, note);
    ui.box.querySelector("[data-files]").appendChild(row);
  }

  function showReset(ui) {
    const foot = ui.box.querySelector("[data-foot]");
    const b = button("본 공고 기록 지우기", () => {
      if (b.dataset.armed) {
        localStorage.removeItem(SEEN_KEY);
        localStorage.removeItem(LAST_KEY);
        b.textContent = "지웠습니다 — 다음 실행은 처음부터";
        b.disabled = true;
      } else {
        b.dataset.armed = "1";
        b.textContent = "한 번 더 누르면 지웁니다";
      }
    });
    foot.append("다음 실행부터는 이번에 받은 공고를 건너뜁니다. ", b);
  }

  async function run() {
    if (window.__snuInternWatch) return;
    window.__snuInternWatch = true;
    const ui = panel();
    try {
      if (!location.hostname.endsWith("career.snu.ac.kr")) {
        ui.msg("서울대 경력개발센터(career.snu.ac.kr)에 로그인한 탭에서 실행해 주세요.");
        return;
      }
      const seen = loadSeen();
      const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
      const r = await collect({
        fetchText: async (url) => (await fetch(url, { credentials: "same-origin" })).text(),
        sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
        seen, today, onProgress: ui.msg,
      });
      for (const p of [...r.postings, ...r.skipped]) seen.add(p.id);
      saveSeen(seen);
      if (!r.postings.length) {
        ui.msg(`새 공고가 없습니다${r.skipped.length ? ` (마감 지난 ${r.skipped.length}건은 건너뜀)` : ""}.`);
        const last = JSON.parse(localStorage.getItem(LAST_KEY) || "[]");
        if (last.length) {
          ui.box.querySelector("[data-files]").append("지난번 파일:");
          showFiles(ui, last);
        }
      } else {
        const files = toFiles(r.postings, { date: today });
        try {
          localStorage.setItem(LAST_KEY, JSON.stringify(files));
        } catch {} // 용량 초과면 보관만 건너뛴다
        ui.msg(`새 공고 ${r.postings.length}건${r.skipped.length ? `, 마감 지난 ${r.skipped.length}건 건너뜀` : ""}. ` +
          "파일을 받아 InternWatch GPT에 올리고 \"판정해줘\"라고 보내세요.");
        showFiles(ui, files);
        showPosters(ui, posterTargets(r.postings), today);
      }
      showReset(ui);
    } catch (e) {
      ui.msg("오류: " + e.message);
    } finally {
      window.__snuInternWatch = false;
    }
  }

  const api = { parseList, parseDetail, collect, toFiles, posterTargets, imageExt, jpegsToPdf, tileRects };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else run();
})();
