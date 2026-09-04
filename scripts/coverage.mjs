/**
 * README のカバー率の表を測り直す。依存パッケージなし。
 *
 *   node scripts/coverage.mjs
 *
 * 「配信情報を表示できた割合」の分母は、**アプリの一覧に実際に並ぶ作品**とする。
 * つまり AniList で isAdult:false の全作品で、形式（TV / 劇場版 / OVA / ONA など）は
 * 問わない。TV だけに絞ると数字は10ポイント前後上がるが、利用者が目にする画面とは
 * 対応しなくなるので採らない。
 *
 * 数字は data/streaming.json の中身に依存し、更新のたびに動く。README に書き写すときは
 * 測定日も一緒に残すこと。
 */
import fs from "node:fs";
import path from "node:path";
import { anilist, sleep } from "./season-targets.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const st = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "streaming.json"), "utf8"));
const covered = (id) => Array.isArray(st.titles[id]) && st.titles[id].length > 0;

const QUERY = `query($p:Int,$s:MediaSeason,$y:Int,$sort:[MediaSort]){
  Page(page:$p,perPage:50){ pageInfo{ hasNextPage }
    media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:$sort){ id } } }`;

async function collect(vars, maxPages) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const page = (await anilist(QUERY, { ...vars, p })).Page;
    page.media.forEach((m) => out.push(m.id));
    if (!page.pageInfo.hasNextPage) break;
    await sleep(800);                          /* AniList は 30 リクエスト/分 */
  }
  return out;
}

/* 標本: 歴代トップはスコア順の上位50件、各シーズンは人気順で最大200件 */
const SAMPLES = [
  ["歴代トップ50", { sort: ["SCORE_DESC"] }, 1, 50],
  ["2006年春", { s: "SPRING", y: 2006, sort: ["POPULARITY_DESC"] }, 4, null],
  ["2020年春", { s: "SPRING", y: 2020, sort: ["POPULARITY_DESC"] }, 4, null],
  ["1998年春", { s: "SPRING", y: 1998, sort: ["POPULARITY_DESC"] }, 4, null],
];

console.log(`data/streaming.json: ${Object.keys(st.titles).length}作品 (updated ${st.updated.slice(0, 10)})\n`);
console.log("| 対象 | 配信情報を表示できた割合 |");
console.log("| --- | --- |");
for (const [label, vars, pages, cap] of SAMPLES) {
  let ids = await collect(vars, pages);
  if (cap) ids = ids.slice(0, cap);
  const ok = ids.filter(covered).length;
  console.log(`| ${label} | ${Math.round(ok / ids.length * 100)}% (${ok}/${ids.length}) |`);
  await sleep(800);
}
console.log(`\n測定日: ${new Date().toISOString().slice(0, 10)}`);
