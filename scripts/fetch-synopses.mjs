/**
 * 日本語版Wikipedia のあらすじ冒頭を事前に解決して data/synopses.json を作る。
 *
 * これまでは閲覧者のブラウザが詳細を開くたびに Wikipedia を叩いていた。その方式には
 * 2つの問題がある。照合の失敗が利用者ごとに毎回起きること、そして表示のたびに外部への
 * リクエストが出ること。配信情報と同じくビルド時に解決して静的ファイルにすれば両方消える。
 *
 * 照合順序は index.html の実行時実装をそのまま踏襲する（完全一致 → 季数表記を落とした題名
 * → 検索）。ここを変えると、静的ファイルに載る作品と実行時フォールバックで拾える作品が
 * 食い違うので、片方だけ直さないこと。
 *
 * **Wikipedia の本文は CC BY-SA 4.0。** 生成物は MIT ではない。記事名と記事URLを必ず一緒に
 * 保存し、帰属表示が成立する形にする。冒頭部分だけを取り、記事全文は保存しない。
 *
 *   node scripts/fetch-synopses.mjs           # 既存にマージ
 *   node scripts/fetch-synopses.mjs --force   # 既存の結果も引き直す
 */
import fs from "node:fs";
import path from "node:path";
import { seasonTargets, anilist, sleep } from "./season-targets.mjs";

const FORCE = process.argv.includes("--force");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "synopses.json");
const OVERRIDES = path.join(ROOT, "data", "synopses-overrides.json");

const WIKI = "https://ja.wikipedia.org/w/api.php";
/* Wikipedia は素性の分かる User-Agent を求めている */
const UA = "Courdeck/1.0 (https://github.com/Naatlant/courdeck; non-commercial anime info tool)";
const MAX_CHARS = 600;      /* 冒頭だけを載せる。全文は保存しない */
const GAP_MS = 120;         /* 連続アクセスの間隔 */

/* ---------- 照合用の正規化（index.html と同じ規則） ---------- */
function baseTitle(s) {
  return String(s || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/第[0-9０-９]+期|シーズン\s*[0-9０-９]+|season\s*[0-9]+|[0-9]+(st|nd|rd|th)\s*season/gi, "")
    .replace(/[ⅠⅡⅢⅣⅤⅥ]/g, "")
    .trim();
}
function normTitle(s) {
  return baseTitle(s).replace(/[^0-9A-Za-zぁ-ゖァ-ヺー一-鿿]/g, "").toLowerCase();
}

function wikiUrl(params) {
  const q = "action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1";
  return WIKI + "?" + q + "&" + params;
}
async function wikiGet(params) {
  const r = await fetch(wikiUrl(params), { headers: { "User-Agent": UA } });
  await sleep(GAP_MS);
  if (!r.ok) throw new Error("Wikipedia HTTP " + r.status);
  return r.json();
}

/* index.html の pickPage と同じ判定。別作品の記事を拾わないための包含チェックを含む */
function pickPage(json, want) {
  const pages = json?.query?.pages;
  if (!pages) return null;
  const list = Object.values(pages).sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const p of list) {
    if (!p || p.missing !== undefined || !p.extract) continue;
    const text = p.extract.trim();
    if (text.length < 30 || text.includes("曖昧さ回避")) continue;
    if (want) {
      const a = normTitle(p.title), b = normTitle(want);
      if (!a.includes(b) && !b.includes(a)) continue;
    }
    return { text, title: p.title };
  }
  return null;
}

/* 文の切れ目で切る。途中でぶつ切りにすると読みづらいため */
function trim(text) {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return (stop > MAX_CHARS * 0.5 ? cut.slice(0, stop + 1) : cut.trim() + "…");
}

async function resolve(native) {
  const base = baseTitle(native);
  let hit = pickPage(await wikiGet("titles=" + encodeURIComponent(native)), native);
  if (!hit && base && base !== native) {
    hit = pickPage(await wikiGet("titles=" + encodeURIComponent(base)), native);
  }
  if (!hit && base) {
    hit = pickPage(await wikiGet(
      "generator=search&gsrnamespace=0&gsrlimit=3&gsrsearch=" + encodeURIComponent(base)), base);
  }
  return hit;
}

/* ---------- 対象を決める ---------- */
console.log("対象を集めています…");
const ids = await seasonTargets();
console.log(`対象: ${ids.length}件\n`);

const META = `query($ids:[Int]){ Page(page:1,perPage:50){
  media(id_in:$ids,type:ANIME,isAdult:false){ id title{ native } } } }`;
const titles = new Map();
for (let i = 0; i < ids.length; i += 50) {
  const d = await anilist(META, { ids: ids.slice(i, i + 50) });
  for (const m of d.Page.media) if (m.title?.native) titles.set(m.id, m.title.native);
  if (i + 50 < ids.length) await sleep(700);
}
console.log(`原題が取れた作品: ${titles.size}件\n`);

/* ---------- 手動の上書き ---------- */
/* 誤った記事に紐付いたときに人が直せる逃げ道。生成時はこちらを優先する */
let overrides = {};
try {
  const j = JSON.parse(fs.readFileSync(OVERRIDES, "utf8"));
  if (j && typeof j.items === "object" && j.items) overrides = j.items;
} catch { /* 無ければ上書きなし */ }
console.log(`上書き指定: ${Object.keys(overrides).length}件`);

/* ---------- 既存の結果 ---------- */
let prev = {};
if (!FORCE) {
  try {
    const j = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (j && typeof j.items === "object" && j.items) prev = j.items;
  } catch { /* 無ければ最初から */ }
}

const items = {};
let kept = 0, added = 0, missed = 0, overridden = 0, failed = 0;

for (const id of ids) {
  const native = titles.get(id);

  /* 上書きが最優先。記事名だけ指定してもらい、本文はその記事から取る */
  const ov = overrides[id];
  if (ov && ov.wikiTitle) {
    try {
      const hit = pickPage(await wikiGet("titles=" + encodeURIComponent(ov.wikiTitle)), null);
      if (hit) {
        items[id] = entry(hit);
        overridden++;
        continue;
      }
      console.log(`  上書き先が見つかりません: ${id} → ${ov.wikiTitle}`);
    } catch { failed++; }
  }
  if (ov && ov.skip) continue;          /* 「どの記事にも当てない」という指定 */

  if (!FORCE && prev[id]) { items[id] = prev[id]; kept++; continue; }
  if (!native) continue;

  try {
    const hit = await resolve(native);
    if (hit) { items[id] = entry(hit); added++; }
    else missed++;
  } catch (e) {
    failed++;
    console.log(`  取得失敗: ${native} (${e.message})`);
  }
  if ((added + missed) % 50 === 0 && added + missed) console.log(`  ${added + missed}件 …`);
}

function entry(hit) {
  return {
    t: trim(hit.text),
    w: hit.title,
    u: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(hit.title),
  };
}

/* ---------- 出力 ---------- */
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  source: "ja.wikipedia.org",
  license: "CC BY-SA 4.0",
  note: "Wikipedia日本語版の冒頭抜粋。記事名(w)と記事URL(u)を帰属表示として必ず一緒に表示すること。",
  items,
}) + "\n");

console.log(`\n上書きで解決: ${overridden}件`);
console.log(`新規に解決  : ${added}件`);
console.log(`既存を再利用: ${kept}件`);
console.log(`見つからず  : ${missed}件`);
if (failed) console.log(`取得失敗    : ${failed}件`);
console.log(`収録        : ${Object.keys(items).length}件`);
console.log(`出力        : ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
