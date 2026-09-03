/**
 * 日本国内の配信情報を取得して data/streaming.json を生成する。
 *
 *   Fribb/anime-lists（AniList ID → TMDB ID）
 *   → TMDB /watch/providers?region=JP（配信情報の提供元は JustWatch）
 *
 * 既定は「前季・今季・来季＋歴代トップ」だけを取得し、既存データにマージする（毎日実行用）。
 * --all を付けると対応表にある全作品を取得して全置換する（週1回想定）。
 *
 * APIキーは環境変数 TMDB_API_KEY から読む（GitHub Actions では Secrets 経由）。
 * ローカル実行時に限り .tmdb_key ファイルへフォールバックする。
 */
import fs from "node:fs";
import path from "node:path";

const ALL = process.argv.includes("--all");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "streaming.json");
const MAP_URL = "https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-full.json";

const KEY = (process.env.TMDB_API_KEY || readLocalKey() || "").trim();
if (!KEY) {
  console.error("TMDB_API_KEY が設定されていません。");
  process.exit(1);
}
function readLocalKey() {
  try { return fs.readFileSync(path.join(ROOT, ".tmdb_key"), "utf8"); } catch { return ""; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`モード: ${ALL ? "全作品（全置換）" : "前季〜来季＋歴代トップ（マージ）"}\n`);

/* ---------- 表示名の正規化 ---------- */
/* 広告付きプランは本体に統合し、Amazonチャンネル系は区別が分かる名前にする */
const RENAME = {
  "Netflix Standard with Ads": "Netflix",
  "Amazon Prime Video": "Prime Video",
  "Amazon Prime Video with Ads": "Prime Video",
  "Disney Plus": "Disney+",
  "dAnime Amazon Channel": "dアニメ(Amazon)",
  "Anime Times Amazon Channel": "アニメタイムズ(Amazon)",
  "FOD Channel Amazon Channel": "FOD(Amazon)",
  "Toei Animation Channel  Amazon Channel": "東映アニメ(Amazon)",
  "Toei Animation Channel Amazon Channel": "東映アニメ(Amazon)",
  "TELESA Amazon Channel": "TELASA(Amazon)",
  "Crunchyroll Amazon Channel": "Crunchyroll(Amazon)",
  "NHK On Demand Amazon Channel": "NHKオンデマンド(Amazon)",
};
/* 国内での使われ方が近い順に並べる */
const ORDER = ["dアニメ(Amazon)", "Prime Video", "U-NEXT", "Netflix", "Hulu", "FOD",
               "Disney+", "アニメタイムズ(Amazon)", "ABEMA", "Lemino", "DMM TV"];
/* 一覧に無い Amazon チャンネルも「◯◯(Amazon)」に揃える */
const rename = (n) => RENAME[n] || String(n).trim().replace(/\s*Amazon Channel$/, "(Amazon)");
const rank = (n) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };

/* ---------- ID 対応表 ---------- */
console.log("対応表を取得中…");
const mapRes = await fetch(MAP_URL);
if (!mapRes.ok) throw new Error("対応表 HTTP " + mapRes.status);
const byAni = new Map();
for (const e of await mapRes.json()) {
  if (e.anilist_id != null) byAni.set(e.anilist_id, e);
}
console.log(`対応表: ${byAni.size}件\n`);

function tmdbRef(entry) {
  const t = entry?.themoviedb_id;
  if (t == null) return null;
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  if (typeof t === "number") return `tv/${t}`;
  if (typeof t === "object") {
    if (t.tv != null) return `tv/${pick(t.tv)}`;
    if (t.movie != null) return `movie/${pick(t.movie)}`;
  }
  return null;
}

/* ---------- 対象の AniList ID を決める ---------- */
let ids;
if (ALL) {
  ids = [...byAni.keys()];
} else {
  ids = await seasonTargets();
}
console.log(`対象: ${ids.length}件`);

async function seasonTargets() {
  const AQ = `query($p:Int,$s:MediaSeason,$y:Int,$sort:[MediaSort],$score:Int){
    Page(page:$p,perPage:50){ pageInfo{ hasNextPage }
      media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:$sort,averageScore_greater:$score){ id } } }`;
  const call = async (vars) => {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: AQ, variables: vars }),
    });
    if (!r.ok) throw new Error("AniList HTTP " + r.status);
    const j = await r.json();
    if (j.errors) throw new Error(j.errors.map((e) => e.message).join(" / "));
    return j.data.Page;
  };
  const collect = async (vars, maxPages) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = await call({ ...vars, p });
      page.media.forEach((m) => out.push(m.id));
      if (!page.pageInfo.hasNextPage) break;
      await sleep(700);                        /* AniList は 30 リクエスト/分 */
    }
    return out;
  };
  const seasonOf = (d) => ["WINTER","WINTER","WINTER","SPRING","SPRING","SPRING",
                           "SUMMER","SUMMER","SUMMER","FALL","FALL","FALL"][d.getMonth()];
  const shift = (year, season, dir) => {
    const o = ["WINTER", "SPRING", "SUMMER", "FALL"];
    let i = o.indexOf(season) + dir;
    if (i < 0) { i = 3; year--; }
    if (i > 3) { i = 0; year++; }
    return { year, season: o[i] };
  };
  const now = new Date();
  const cur = { year: now.getFullYear(), season: seasonOf(now) };
  const set = new Set();
  for (const t of [shift(cur.year, cur.season, -1), cur, shift(cur.year, cur.season, 1)]) {
    const got = await collect({ s: t.season, y: t.year, sort: ["POPULARITY_DESC"] }, 4);
    got.forEach((id) => set.add(id));
    console.log(`${t.year} ${t.season}: ${got.length}件`);
    await sleep(700);
  }
  const top = await collect({ sort: ["SCORE_DESC"], score: 74 }, 2);
  top.forEach((id) => set.add(id));
  console.log(`歴代トップ: ${top.length}件`);
  return [...set];
}

/* ---------- TMDB ---------- */
/* 分割クールは同じシリーズを指すため、TMDB ID 単位で重複排除してから叩く */
const refByAni = new Map();
const needed = new Set();
for (const id of ids) {
  const ref = tmdbRef(byAni.get(id));
  if (!ref) continue;
  refByAni.set(id, ref);
  needed.add(ref);
}
console.log(`TMDB IDあり: ${refByAni.size}件 → 重複排除後 ${needed.size}件のリクエスト\n`);

const result = new Map();                      /* ref -> サービス名の配列 */
let done = 0, failed = 0;
for (const ref of needed) {
  let jp = null;
  try {
    const r = await fetch(`https://api.themoviedb.org/3/${ref}/watch/providers?api_key=${KEY}`);
    if (r.status === 429) { await sleep(3000); failed++; continue; }
    if (r.ok) jp = (await r.json())?.results?.JP;
  } catch {
    failed++;
  }
  await sleep(60);                             /* TMDB は毎秒40程度が上限 */
  done++;
  if (done % 500 === 0) console.log(`  ${done}/${needed.size} …`);
  if (!jp) continue;

  /* flatrate=見放題 / free=無料 / ads=広告付き無料 のみ対象（レンタル・購入は除く） */
  const set = new Set();
  for (const k of ["flatrate", "free", "ads"]) {
    (jp[k] || []).forEach((p) => set.add(rename(p.provider_name)));
  }
  if (set.size) result.set(ref, [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)));
}

/* ---------- 出力 ---------- */
/* 既存データを土台にする（マージ実行で全件データが失われないように） */
let base = { names: [], titles: {} };
if (!ALL && fs.existsSync(OUT)) {
  try { base = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { /* 壊れていれば作り直す */ }
}
const names = [...(base.names || [])];
const nameIdx = new Map(names.map((n, i) => [n, i]));
const titles = ALL ? {} : { ...(base.titles || {}) };

for (const [aniId, ref] of refByAni) {
  const list = result.get(ref);
  if (!list) { if (!ALL) delete titles[aniId]; continue; }
  titles[aniId] = {
    p: list.map((n) => {
      if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
      return nameIdx.get(n);
    }),
    t: ref,
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  source: "TMDB / JustWatch",
  region: "JP",
  names,
  titles,
}) + "\n");

console.log(`\n配信情報あり: ${result.size}件（作品数 ${Object.keys(titles).length}）`);
if (failed) console.log(`取得失敗    : ${failed}`);
console.log(`出力        : ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
