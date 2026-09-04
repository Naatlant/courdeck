/**
 * 「前季・今季・来季＋歴代トップ」の AniList ID を集める。依存パッケージなし。
 *
 * 配信情報とあらすじの両方が同じ対象範囲を使うので、片方だけ直して食い違うことがないよう
 * ここにまとめてある。範囲を変えるときはこのファイルだけを直せばよい。
 */

const API = "https://graphql.anilist.co";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `query($p:Int,$s:MediaSeason,$y:Int,$sort:[MediaSort],$score:Int){
  Page(page:$p,perPage:50){ pageInfo{ hasNextPage }
    media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:$sort,averageScore_greater:$score){ id } } }`;

export async function anilist(query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error("AniList HTTP " + r.status);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join(" / "));
  return j.data;
}

export const seasonOf = (d) => ["WINTER","WINTER","WINTER","SPRING","SPRING","SPRING",
                                "SUMMER","SUMMER","SUMMER","FALL","FALL","FALL"][d.getMonth()];

export function shiftSeason(year, season, dir) {
  const o = ["WINTER", "SPRING", "SUMMER", "FALL"];
  let i = o.indexOf(season) + dir;
  if (i < 0) { i = 3; year--; }
  if (i > 3) { i = 0; year++; }
  return { year, season: o[i] };
}

export async function seasonTargets(log = console.log) {
  const collect = async (vars, maxPages) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = (await anilist(QUERY, { ...vars, p })).Page;
      page.media.forEach((m) => out.push(m.id));
      if (!page.pageInfo.hasNextPage) break;
      await sleep(700);                        /* AniList は 30 リクエスト/分 */
    }
    return out;
  };
  const now = new Date();
  const cur = { year: now.getFullYear(), season: seasonOf(now) };
  const set = new Set();
  for (const t of [shiftSeason(cur.year, cur.season, -1), cur, shiftSeason(cur.year, cur.season, 1)]) {
    const got = await collect({ s: t.season, y: t.year, sort: ["POPULARITY_DESC"] }, 4);
    got.forEach((id) => set.add(id));
    log(`${t.year} ${t.season}: ${got.length}件`);
    await sleep(700);
  }
  const top = await collect({ sort: ["SCORE_DESC"], score: 74 }, 2);
  top.forEach((id) => set.add(id));
  log(`歴代トップ: ${top.length}件`);
  return [...set];
}
