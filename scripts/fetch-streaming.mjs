/**
 * 日本国内の配信情報を取得して data/streaming.json を生成する。
 *
 *   AniList（作品一覧）→ Fribb/anime-lists（AniList ID → TMDB ID）
 *   → TMDB /watch/providers?region=JP（配信情報の提供元は JustWatch）
 *
 * APIキーは環境変数 TMDB_API_KEY から読む（GitHub Actions では Secrets 経由）。
 * ローカル実行時に限り .tmdb_key ファイルへフォールバックする。
 */
import fs from "node:fs";
import path from "node:path";

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
};
/* 国内での使われ方が近い順に並べる */
const ORDER = ["dアニメ(Amazon)", "Prime Video", "U-NEXT", "Netflix", "Hulu", "FOD",
               "Disney+", "アニメタイムズ(Amazon)", "ABEMA", "Lemino", "DMM TV"];
const rename = (n) => RENAME[n] || n;
const rank = (n) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };

/* ---------- AniList ---------- */
const AQ = `query($p:Int,$s:MediaSeason,$y:Int,$sort:[MediaSort],$score:Int){
  Page(page:$p,perPage:50){ pageInfo{ hasNextPage }
    media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:$sort,averageScore_greater:$score){ id } } }`;

async function anilist(vars) {
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: AQ, variables: vars }),
  });
  if (!r.ok) throw new Error("AniList HTTP " + r.status);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join(" / "));
  return j.data.Page;
}
async function collect(vars, maxPages) {
  const ids = [];
  for (let p = 1; p <= maxPages; p++) {
    const page = await anilist({ ...vars, p });
    page.media.forEach((m) => ids.push(m.id));
    if (!page.pageInfo.hasNextPage) break;
    await sleep(700);                      /* AniList は 30 リクエスト/分 */
  }
  return ids;
}

function seasonOf(d) {
  return ["WINTER","WINTER","WINTER","SPRING","SPRING","SPRING",
          "SUMMER","SUMMER","SUMMER","FALL","FALL","FALL"][d.getMonth()];
}
function shift(year, season, dir) {
  const o = ["WINTER", "SPRING", "SUMMER", "FALL"];
  let i = o.indexOf(season) + dir;
  if (i < 0) { i = 3; year--; }
  if (i > 3) { i = 0; year++; }
  return { year, season: o[i] };
}

const now = new Date();
const cur = { year: now.getFullYear(), season: seasonOf(now) };
const targets = [shift(cur.year, cur.season, -1), cur, shift(cur.year, cur.season, 1)];

const idSet = new Set();
for (const t of targets) {
  const ids = await collect({ s: t.season, y: t.year, sort: ["POPULARITY_DESC"] }, 4);
  ids.forEach((id) => idSet.add(id));
  console.log(`${t.year} ${t.season}: ${ids.length}件`);
  await sleep(700);
}
/* 歴代の高評価作品も対象にする（「歴代トップ」表示用） */
const top = await collect({ sort: ["SCORE_DESC"], score: 74 }, 2);
top.forEach((id) => idSet.add(id));
console.log(`歴代トップ: ${top.length}件`);
const ids = [...idSet];
console.log(`対象: ${ids.length}件\n`);

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
  if (typeof t === "number") return { kind: "tv", id: t };
  if (typeof t === "object") {
    if (t.tv != null) return { kind: "tv", id: pick(t.tv) };
    if (t.movie != null) return { kind: "movie", id: pick(t.movie) };
  }
  return null;
}

/* ---------- TMDB ---------- */
const names = [];
const nameIdx = new Map();
const titles = {};
let mapped = 0, hit = 0, failed = 0;

for (const id of ids) {
  const ref = tmdbRef(byAni.get(id));
  if (!ref) continue;
  mapped++;
  let jp = null;
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/${ref.kind}/${ref.id}/watch/providers?api_key=${KEY}`);
    if (r.status === 429) { await sleep(2000); continue; }
    if (r.ok) jp = (await r.json())?.results?.JP;
  } catch (e) {
    failed++;
  }
  await sleep(60);                          /* TMDB は毎秒40程度が上限 */
  if (!jp) continue;

  /* flatrate=見放題 / free=無料 / ads=広告付き無料 のみを対象にする（レンタル・購入は除く） */
  const set = new Set();
  for (const k of ["flatrate", "free", "ads"]) {
    (jp[k] || []).forEach((p) => set.add(rename(p.provider_name)));
  }
  if (!set.size) continue;
  hit++;
  const list = [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  titles[id] = {
    p: list.map((n) => {
      if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
      return nameIdx.get(n);
    }),
    t: `${ref.kind}/${ref.id}`,
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

console.log(`TMDB IDあり : ${mapped}`);
console.log(`配信情報あり: ${hit}`);
if (failed) console.log(`取得失敗    : ${failed}`);
console.log(`出力        : ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
