/**
 * 日付ロジックのテスト。外部テストフレームワークは使わない（node:test / node:assert のみ）。
 *
 *   node --test
 *
 * 対象の関数は Date のローカル時刻（getHours など）で日付を切るので、結果は実行環境の
 * タイムゾーンに従う。ここでは日本の視聴者を想定して Asia/Tokyo に固定する。日本には
 * サマータイムが無いため、固定すれば結果は一意に決まる。
 *
 * 入力も期待値もローカル時刻で書いてあるので、多くのテストは固定が無くても通ってしまう。
 * 固定の目的は、5時始まりという仕様が JST を指していることを明示すること、そして
 * サマータイムのある地域で存在しない時刻（春の繰り上げ時など）を組み立てて
 * 結果がずれる事故を防ぐことにある。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadDateLogic, readSource } from "../scripts/date-logic.mjs";

/* 対象を評価する前にタイムゾーンを決めておく。loadDateLogic() は関数を定義するだけで
   Date を作らないので、この順序で問題ない（ずれた場合は先頭のテストが落ちる）。 */
process.env.TZ = "Asia/Tokyo";

const {
  seasonOf, shiftSeason, currentSeason, broadcastToday,
  calWeekStart, dayKey, broadcastDate, airTime,
} = loadDateLogic();

/* 月を1始まりで書けるようにする小道具 */
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
const epoch = (y, m, d, h = 0, mi = 0) => Math.floor(at(y, m, d, h, mi).getTime() / 1000);
const ymd = (dt) => [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
const ymdhm = (dt) => [dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes()];

describe("実行環境", () => {
  it("タイムゾーンが Asia/Tokyo に固定されている", () => {
    assert.equal(at(2026, 1, 15).getTimezoneOffset(), -540,
      "TZ=Asia/Tokyo で実行すること。ずれていると5時境界のテストが意味を失う");
    assert.equal(at(2026, 8, 15).getTimezoneOffset(), -540,
      "日本にサマータイムは無いので、夏でも offset は変わらないはず");
  });
});

describe("seasonOf / currentSeason（放送シーズンの判定）", () => {
  it("各シーズンの初日と最終日", () => {
    assert.equal(seasonOf(at(2026, 1, 1)), "WINTER");
    assert.equal(seasonOf(at(2026, 3, 31)), "WINTER");
    assert.equal(seasonOf(at(2026, 4, 1)), "SPRING");
    assert.equal(seasonOf(at(2026, 6, 30)), "SPRING");
    assert.equal(seasonOf(at(2026, 7, 1)), "SUMMER");
    assert.equal(seasonOf(at(2026, 9, 30)), "SUMMER");
    assert.equal(seasonOf(at(2026, 10, 1)), "FALL");
    assert.equal(seasonOf(at(2026, 12, 31)), "FALL");
  });

  it("12月31日から1月1日をまたぐと FALL から WINTER へ、年も繰り上がる", () => {
    assert.deepEqual(currentSeason(at(2026, 12, 31, 23, 59)), { year: 2026, season: "FALL" });
    assert.deepEqual(currentSeason(at(2027, 1, 1, 0, 0)), { year: 2027, season: "WINTER" });
  });

  it("うるう日でも判定が変わらない", () => {
    assert.equal(seasonOf(at(2028, 2, 29)), "WINTER");
    assert.deepEqual(currentSeason(at(2028, 2, 29, 12, 0)), { year: 2028, season: "WINTER" });
  });

  it("元日の深夜は放送日ではなく暦の日付で判定する（現在の仕様）", () => {
    /* 1/1 0:30 の放送日は 12/31（FALL）だが、シーズン選択は暦に従って WINTER になる。
       「今季」の選択肢が暦年基準であるための挙動。変更する場合はここも直すこと。 */
    assert.deepEqual(currentSeason(at(2027, 1, 1, 0, 30)), { year: 2027, season: "WINTER" });
    assert.deepEqual(ymd(broadcastToday(at(2027, 1, 1, 0, 30))), [2026, 12, 31]);
  });
});

describe("shiftSeason（シーズンの前後移動）", () => {
  it("冬から戻ると前年の秋、秋から進むと翌年の冬", () => {
    assert.deepEqual(shiftSeason(2026, "WINTER", -1), { year: 2025, season: "FALL" });
    assert.deepEqual(shiftSeason(2026, "FALL", 1), { year: 2027, season: "WINTER" });
  });

  it("年をまたがない移動では年が変わらない", () => {
    assert.deepEqual(shiftSeason(2026, "SPRING", -1), { year: 2026, season: "WINTER" });
    assert.deepEqual(shiftSeason(2026, "SUMMER", 1), { year: 2026, season: "FALL" });
  });

  it("進めて戻すと元に戻る", () => {
    const a = shiftSeason(2026, "WINTER", -1);
    assert.deepEqual(shiftSeason(a.year, a.season, 1), { year: 2026, season: "WINTER" });
  });
});

describe("broadcastToday（放送日は朝5時始まり）", () => {
  it("深夜0:00ちょうどは前日の放送日", () => {
    assert.deepEqual(ymdhm(broadcastToday(at(2026, 9, 5, 0, 0))), [2026, 9, 4, 5, 0]);
  });

  it("4:59は前日、5:00ちょうどは当日", () => {
    assert.deepEqual(ymdhm(broadcastToday(at(2026, 9, 5, 4, 59))), [2026, 9, 4, 5, 0]);
    assert.deepEqual(ymdhm(broadcastToday(at(2026, 9, 5, 5, 0))), [2026, 9, 5, 5, 0]);
  });

  it("日中も深夜直前も、その日の5:00に丸められる", () => {
    assert.deepEqual(ymdhm(broadcastToday(at(2026, 9, 5, 12, 34))), [2026, 9, 5, 5, 0]);
    assert.deepEqual(ymdhm(broadcastToday(at(2026, 9, 5, 23, 59))), [2026, 9, 5, 5, 0]);
  });

  it("月初の深夜は前月末に戻る", () => {
    assert.deepEqual(ymd(broadcastToday(at(2026, 10, 1, 3, 0))), [2026, 9, 30]);
  });

  it("元日の深夜は前年の大晦日に戻る", () => {
    assert.deepEqual(ymd(broadcastToday(at(2027, 1, 1, 2, 0))), [2026, 12, 31]);
  });

  it("うるう年の3月1日深夜は2月29日に戻る", () => {
    assert.deepEqual(ymd(broadcastToday(at(2028, 3, 1, 3, 0))), [2028, 2, 29]);
    assert.deepEqual(ymd(broadcastToday(at(2028, 2, 29, 4, 0))), [2028, 2, 28]);
  });

  it("平年の3月1日深夜は2月28日に戻る", () => {
    assert.deepEqual(ymd(broadcastToday(at(2027, 3, 1, 3, 0))), [2027, 2, 28]);
  });

  it("引数の Date を書き換えない", () => {
    const now = at(2026, 9, 5, 1, 0);
    const before = now.getTime();
    broadcastToday(now);
    assert.equal(now.getTime(), before, "呼び出し側の Date が壊れると再計算のたびに日付がずれる");
  });
});

describe("broadcastDate（放送時刻から放送日へ）", () => {
  it("深夜1:30の放送は前日扱い", () => {
    assert.deepEqual(ymd(broadcastDate(epoch(2026, 9, 5, 1, 30))), [2026, 9, 4]);
  });

  it("4:59は前日、5:00ちょうどは当日", () => {
    assert.deepEqual(ymd(broadcastDate(epoch(2026, 9, 5, 4, 59))), [2026, 9, 4]);
    assert.deepEqual(ymd(broadcastDate(epoch(2026, 9, 5, 5, 0))), [2026, 9, 5]);
  });

  it("年をまたぐ深夜放送は前年の日付になる", () => {
    assert.deepEqual(ymd(broadcastDate(epoch(2027, 1, 1, 0, 30))), [2026, 12, 31]);
  });

  it("うるう年をまたぐ深夜放送", () => {
    assert.deepEqual(ymd(broadcastDate(epoch(2028, 3, 1, 1, 0))), [2028, 2, 29]);
  });
});

describe("airTime（24時間超えの表記）", () => {
  /* airTime と broadcastDate は閲覧者のローカル時刻で時を読む。日本国外から見ると
     放送時刻がその地域の時刻に読み替えられ、25:30 という表記の前提が崩れる。
     現在の仕様なのでここでは JST を前提に検証する。 */
  it("夕方から深夜前まではそのまま", () => {
    assert.equal(airTime(epoch(2026, 9, 5, 16, 30)), "16:30");
    assert.equal(airTime(epoch(2026, 9, 5, 21, 0)), "21:00");
    assert.equal(airTime(epoch(2026, 9, 5, 23, 59)), "23:59");
  });

  it("深夜0:00ちょうどは24:00", () => {
    assert.equal(airTime(epoch(2026, 9, 5, 0, 0)), "24:00");
  });

  it("1:30は25:30", () => {
    assert.equal(airTime(epoch(2026, 9, 5, 1, 30)), "25:30");
  });

  it("26:00以降も繰り上げて表記する", () => {
    assert.equal(airTime(epoch(2026, 9, 5, 2, 0)), "26:00");
    assert.equal(airTime(epoch(2026, 9, 5, 2, 38)), "26:38");
    assert.equal(airTime(epoch(2026, 9, 5, 4, 59)), "28:59");
  });

  it("5:00ちょうどからは繰り上げない", () => {
    /* 時は0詰めしない仕様なので "05:00" ではなく "5:00" になる */
    assert.equal(airTime(epoch(2026, 9, 5, 5, 0)), "5:00");
  });

  it("分は必ず2桁", () => {
    assert.equal(airTime(epoch(2026, 9, 5, 21, 5)), "21:05");
    assert.equal(airTime(epoch(2026, 9, 5, 1, 5)), "25:05");
  });
});

describe("calWeekStart（曜日表の週送り・週戻し）", () => {
  it("offset 0 はその放送日の5:00", () => {
    assert.deepEqual(ymdhm(calWeekStart(at(2026, 9, 4, 12, 0), 0)), [2026, 9, 4, 5, 0]);
  });

  it("翌週は7日後、前週は7日前", () => {
    assert.deepEqual(ymd(calWeekStart(at(2026, 9, 4, 12, 0), 1)), [2026, 9, 11]);
    assert.deepEqual(ymd(calWeekStart(at(2026, 9, 4, 12, 0), -1)), [2026, 8, 28]);
  });

  it("何週送っても時刻は5:00のまま", () => {
    for (const n of [-3, -1, 0, 1, 5]) {
      assert.deepEqual(ymdhm(calWeekStart(at(2026, 9, 4, 23, 0), n)).slice(3), [5, 0]);
    }
  });

  it("日曜深夜（月曜1:00）は日曜の週として扱う", () => {
    const start = calWeekStart(at(2026, 9, 7, 1, 0), 0);
    assert.deepEqual(ymd(start), [2026, 9, 6]);
    assert.equal(start.getDay(), 0, "9/6 は日曜");
    assert.deepEqual(ymd(calWeekStart(at(2026, 9, 7, 1, 0), 1)), [2026, 9, 13]);
  });

  it("月曜5:00からは月曜の週になる", () => {
    assert.deepEqual(ymd(calWeekStart(at(2026, 9, 7, 5, 0), 0)), [2026, 9, 7]);
  });

  it("月をまたぐ週送り", () => {
    assert.deepEqual(ymd(calWeekStart(at(2026, 9, 28, 12, 0), 1)), [2026, 10, 5]);
  });

  it("年をまたぐ週送り", () => {
    assert.deepEqual(ymd(calWeekStart(at(2026, 12, 30, 12, 0), 1)), [2027, 1, 6]);
    assert.deepEqual(ymd(calWeekStart(at(2027, 1, 2, 12, 0), -1)), [2026, 12, 26]);
  });

  it("うるう年の2月をまたぐ週送り", () => {
    assert.deepEqual(ymd(calWeekStart(at(2028, 2, 22, 12, 0), 1)), [2028, 2, 29]);
    assert.deepEqual(ymd(calWeekStart(at(2028, 2, 26, 12, 0), 1)), [2028, 3, 4]);
  });

  it("平年の2月をまたぐ週送りは1日早く3月に入る", () => {
    assert.deepEqual(ymd(calWeekStart(at(2027, 2, 22, 12, 0), 1)), [2027, 3, 1]);
  });

  it("送って戻すと元の週に戻る", () => {
    const now = at(2026, 12, 30, 12, 0);
    assert.deepEqual(ymd(calWeekStart(now, 3)), [2027, 1, 20]);
    assert.deepEqual(ymd(calWeekStart(now, 0)), [2026, 12, 30]);
  });
});

describe("dayKey（日付の突き合わせキー）", () => {
  it("月は0始まりで並べる（現在の仕様）", () => {
    assert.equal(dayKey(at(2026, 9, 4)), "2026-8-4");
    assert.equal(dayKey(at(2027, 1, 1)), "2027-0-1");
  });

  it("同じ日なら時刻が違っても同じキー", () => {
    assert.equal(dayKey(at(2026, 9, 4, 5, 0)), dayKey(at(2026, 9, 4, 23, 30)));
  });

  it("隣り合う日は別のキー", () => {
    assert.notEqual(dayKey(at(2026, 9, 4)), dayKey(at(2026, 9, 5)));
    assert.notEqual(dayKey(at(2026, 12, 31)), dayKey(at(2027, 1, 1)));
  });

  it("深夜放送は前日のキーに寄せられる", () => {
    assert.equal(dayKey(broadcastDate(epoch(2026, 9, 5, 1, 30))), dayKey(at(2026, 9, 4)));
  });
});

describe("日付ロジック区間そのものの検査", () => {
  const src = readSource();

  it("DOMやブラウザ固有のものを参照していない", () => {
    for (const bad of ["document.", "window.", "localStorage", "el(", "fetch("]) {
      assert.ok(!src.includes(bad), "区間に " + bad + " が入っている。テストできなくなる");
    }
  });

  it("引数なしの new Date() を呼んでいない", () => {
    assert.ok(!/new Date\(\s*\)/.test(src),
      "区間内で現在時刻を直接読むと、テストが時刻を固定できなくなる。呼び出し側に出すこと");
  });

  it("cal や state などのグローバル状態を参照していない", () => {
    assert.ok(!/\bcal\./.test(src), "区間から cal を参照している。offset は引数で受け取ること");
    assert.ok(!/\bstate\./.test(src), "区間から state を参照している");
  });
});
