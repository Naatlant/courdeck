/**
 * index.html の日付ロジック区間だけを切り出して読み込む。依存パッケージなし。
 *
 * アプリ本体は単一HTMLのままにしたいので、日付関数を別モジュールへ移すことはしない。
 * 代わりに index.html 内の目印コメントで囲まれた範囲をここで読み出し、関数として
 * 評価する。テストはこのモジュール経由で対象関数を受け取る。
 *
 * 区間は DOM もグローバル状態も参照しない前提で書かれている。前提が崩れていないかは
 * test/date-logic.test.mjs が区間のソースそのものを検査して確かめる。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = path.join(ROOT, "index.html");

const START = "date-logic:start";
const END = "date-logic:end";

/** 区間内で定義され、テスト対象として取り出す関数 */
export const NAMES = [
  "seasonOf", "shiftSeason", "currentSeason", "broadcastToday",
  "calWeekStart", "dayKey", "broadcastDate", "airTime",
];

/** index.html から日付ロジック区間のソースを取り出す */
export function readSource(){
  const html = fs.readFileSync(HTML, "utf8");
  const i = html.indexOf(START);
  const j = html.indexOf(END);
  if (i < 0 || j < 0 || j < i){
    throw new Error(
      "index.html に " + START + " / " + END + " の目印が見つかりません。" +
      "区間を囲むコメントを消していないか確認してください（CLAUDE.md 参照）");
  }
  const from = html.indexOf("*/", i) + 2;   /* 開始コメントの直後から */
  const to = html.lastIndexOf("/*", j);     /* 終了コメントの直前まで */
  return html.slice(from, to);
}

/**
 * 区間を評価して関数を取り出す。
 * 呼び出し側が process.env.TZ を設定してから呼べるよう、読み込み時ではなく
 * 明示的に呼んだときに評価する。
 */
export function loadDateLogic(){
  const src = readSource();
  const factory = new Function(src + "\nreturn { " + NAMES.join(", ") + " };");
  const api = factory();
  for (const n of NAMES){
    if (typeof api[n] !== "function"){
      throw new Error("関数 " + n + " が日付ロジック区間の中に見つかりません");
    }
  }
  return api;
}
