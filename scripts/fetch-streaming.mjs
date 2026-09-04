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
import { seasonTargets, sleep } from "./season-targets.mjs";

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
const mappedCount = refByAni.size;

/* ---------- 対応表で解決できなかった作品を自前で照合する ----------
   上流の anime-offline-database はアーカイブ済みで、Fribb/anime-lists も
   引き継ぎ手を探している状態にある。対応表だけに頼ると新作のカバー率が
   じわじわ落ちていくため、タイトルと放送年から TMDB を検索して補う。

   誤った紐付けは、紐付かないことより害が大きい。放送年が一致し、かつ記号と空白を
   落とした題名が完全一致した候補だけを採用する。曖昧なものは採らない。

   結果は TMDB ID を含むので、公開する data/ には絶対に置かない。ビルド用の
   キャッシュとして別の場所に持つ（既定は .cache/、gitignore 済み。GitHub Actions
   では actions/cache に載せてリポジトリへ入れない）。 */
const CACHE_PATH = process.env.TMDB_CACHE || path.join(ROOT, ".cache", "tmdb-ids.json");
const FALLBACK_MAX = Number(process.env.TMDB_FALLBACK_MAX || 150);
const RETRY_MISS_DAYS = 30;      /* 見つからなかった作品を再検索するまでの日数 */

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (j && typeof j.entries === "object" && j.entries) return j.entries;
  } catch { /* 無ければ空から始める */ }
  return {};
}
function saveCache(entries) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    note: "自前照合の結果。TMDB IDを含むため公開しない。data/ へは出さないこと。",
    updated: new Date().toISOString(),
    entries,
  }, null, 1) + "\n");
}

/* 記号・空白・全角半角の違いを落として比べる。Ⅲ → III、～ や空白は消える */
const normTitle = (s) => String(s || "").normalize("NFKC").toLowerCase()
  .replace(/[^\p{Letter}\p{Number}]/gu, "");

async function anilistTitles(idList) {
  const Q = `query($ids:[Int]){ Page(page:1,perPage:50){
    media(id_in:$ids,type:ANIME,isAdult:false){ id format seasonYear
      title{ romaji english native } synonyms startDate{ year } } } }`;
  const out = new Map();
  for (let i = 0; i < idList.length; i += 50) {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: Q, variables: { ids: idList.slice(i, i + 50) } }),
    });
    if (!r.ok) throw new Error("AniList HTTP " + r.status);
    const j = await r.json();
    if (j.errors) throw new Error(j.errors.map((e) => e.message).join(" / "));
    for (const m of j.data.Page.media) out.set(m.id, m);
    if (i + 50 < idList.length) await sleep(700);   /* AniList は 30 リクエスト/分 */
  }
  return out;
}

async function tmdbSearch(kind, query) {
  const u = new URL(`https://api.themoviedb.org/3/search/${kind}`);
  u.searchParams.set("api_key", KEY);
  u.searchParams.set("query", query);
  u.searchParams.set("include_adult", "false");
  const r = await fetch(u);
  await sleep(60);                                  /* TMDB は毎秒40程度が上限 */
  if (!r.ok) return [];
  return (await r.json())?.results || [];
}

/* 年が合い、題名が完全一致したものだけを通す */
function acceptable(cand, kind, wantYear, wantNorms) {
  const date = kind === "tv" ? cand.first_air_date : cand.release_date;
  const y = date ? Number(String(date).slice(0, 4)) : null;
  /* 年末開始や年跨ぎ放送があるので1年のずれまでは許す。年が不明な候補は採らない */
  if (!y || !wantYear || Math.abs(y - wantYear) > 1) return false;
  return [cand.name, cand.original_name, cand.title, cand.original_title]
    .some((n) => n && wantNorms.has(normTitle(n)));
}

const cache = loadCache();
let fromCache = 0, resolved = 0, missed = 0, searchCalls = 0;
const unknown = [];
for (const id of ids) {
  if (refByAni.has(id)) continue;
  const e = cache[id];
  /* 判明済みの結果はモードに関係なく使う。再検索はしない */
  if (e && e.ref) { refByAni.set(id, e.ref); needed.add(e.ref); fromCache++; continue; }
  /* 前回見つからなかったものをすぐ再検索しても無駄なので、しばらく置く */
  if (e && e.missAt && Date.now() - Date.parse(e.missAt) < RETRY_MISS_DAYS * 86400000) continue;
  unknown.push(id);
}

/* 検索は日次（今季周辺）のときだけ行う。全作品モードで走らせると古い作品まで
   総当たりになり、リクエストが跳ね上がるため */
if (!ALL && unknown.length) {
  const targets = unknown.slice(0, FALLBACK_MAX);
  console.log(`対応表に無い ${unknown.length}件のうち ${targets.length}件を自前で照合します…`);
  const meta = await anilistTitles(targets);
  for (const id of targets) {
    const m = meta.get(id);
    if (!m) continue;
    const year = m.seasonYear || m.startDate?.year || null;
    const kind = m.format === "MOVIE" ? "movie" : "tv";
    const queries = [m.title?.native, m.title?.romaji, m.title?.english,
                     ...(m.synonyms || []).slice(0, 2)].filter(Boolean);
    const norms = new Set(queries.map(normTitle).filter(Boolean));
    let hit = null;
    for (const q of queries) {
      searchCalls++;
      const found = (await tmdbSearch(kind, q)).find((c) => acceptable(c, kind, year, norms));
      if (found) { hit = `${kind}/${found.id}`; break; }
    }
    const now = new Date().toISOString();
    if (hit) {
      cache[id] = { ref: hit, title: queries[0], year, at: now };
      refByAni.set(id, hit);
      needed.add(hit);
      resolved++;
    } else {
      cache[id] = { missAt: now, title: queries[0] || null, year };
      missed++;
    }
  }
}
saveCache(cache);

console.log(`対応表で解決  : ${mappedCount}件`);
console.log(`自前照合で追加: ${resolved}件（キャッシュから ${fromCache}件・不一致 ${missed}件` +
            `・検索 ${searchCalls}回）`);
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

/* 出力にはTMDB IDを含めない。
   対応表（Fribb/anime-lists ← anime-offline-database, ODbL 1.0）は照合にのみ使い、
   その内容を公開物へ持ち出さないことで、ODbLの継承条項と
   TMDB規約の再許諾禁止が衝突しないようにしている。 */
for (const [aniId, ref] of refByAni) {
  const list = result.get(ref);
  if (!list) { if (!ALL) delete titles[aniId]; continue; }
  titles[aniId] = list.map((n) => {
    if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
    return nameIdx.get(n);
  });
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
