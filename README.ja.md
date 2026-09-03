# アニメまとめ

*English version: [README.md](README.md)*

外部APIから今季・過去のアニメ情報を自動取得し、一覧・集計・週間放送スケジュール・国内の配信状況として表示するWebアプリです。

- **紹介ページ**: https://naatlant.github.io/anime-matome/
- **アプリ本体**: https://naatlant.github.io/anime-matome/anime.html

アプリ本体は依存ライブラリもビルドも不要な単一HTMLファイルです。閲覧者側にAPIキーは要りません。

## 機能

| 機能 | 内容 |
| --- | --- |
| 今季アニメの自動取得 | アクセス日から放送シーズンを判定して表示。前季 / 来季 / 放送中の話題作 / 歴代トップ / 年別ベストをプリセットで切り替え |
| 絞り込み | 年（1960年〜）× 季節 × 並び順6種 × 放送形式 × ジャンル × 最低スコア × キーワード検索 |
| 自動集計 | 件数・平均スコア・放送中本数、ジャンル / 制作会社 / 原作媒体の分布 |
| 週間放送スケジュール | 今週7日分を曜日別・時刻順に表示。放送日は朝5時始まりで区切り、深夜帯は24時制表記（25:30 = 翌1:30） |
| **国内の配信サービス** | dアニメ / Prime Video / U-NEXT / Netflix / Hulu など、日本で視聴できるサービスを表示（6,152作品） |
| **日本語のあらすじ** | 日本語版Wikipediaの導入部を取得して表示。記事が無い作品はAniListの英語説明にフォールバック |
| **ホバープレビュー** | カードにカーソルを合わせると、バナー画像・スコア・次回放送を含む拡大パネルを表示 |
| 詳細表示 | 放送期間、次回放送日時、制作会社、原作媒体、PV、公式・配信リンク |
| お気に入り | localStorage に保存。曜日表を「お気に入りのみ」に絞り込める |
| **条件のURL保存** | 絞り込み条件と表示タブがURLに入り、共有・ブックマーク・ブラウザの戻る操作に対応 |
| 自動読み込み | スクロールに応じて次のページを自動取得（連続10ページで一旦停止） |
| オフライン対応 | 通信失敗時は直近のキャッシュへ自動フォールバックし、いつ時点のデータかを表示 |

レスポンシブ対応（PC / タブレット / スマートフォン）、OSのダークモード設定に自動追従します。

## 技術構成

| 区分 | 内容 |
| --- | --- |
| フロントエンド | 単一HTMLファイル（`anime.html`、約1,200行）。HTML + CSS + JavaScript のみ、依存パッケージなし |
| 作品情報 | AniList GraphQL API（`media` / `airingSchedules` の2クエリ、フィールド定義は共有） |
| あらすじ | 日本語版Wikipedia API（完全一致 → 季数を除いた題名 → 検索の3段階で照合） |
| 配信情報 | TMDB API（データ提供元は JustWatch）。GitHub Actions で取得し JSON として配信 |
| キャッシュ | localStorage に6時間保持（AniList のレート制限 30req/分 対策） |
| 表示 | CSS Grid によるレスポンシブ、`prefers-color-scheme` によるダークモード |

## 配信情報の仕組み

配信情報だけは実行時にAPIを叩きません。GitHub Actions が事前に取得したJSONをアプリが読み込みます。**APIキーはGitHub Secretsに置くため、公開ページには一切出ません。**

```mermaid
flowchart LR
    A[GitHub Actions<br/>日次 / 週次] --> B[Fribb/anime-lists<br/>AniList ID → TMDB ID]
    B --> C[TMDB API<br/>watch/providers region=JP]
    C --> D[data/streaming.json<br/>6,152作品 / 106KB]
    D --> E[anime.html<br/>閲覧者のブラウザ]
```

分割クールや第N期は同じTMDBシリーズを指すため、TMDB ID単位で重複排除しています（8,123件 → 5,452リクエスト）。

| 実行 | スケジュール | 内容 |
| --- | --- | --- |
| 日次 | 毎日 03:00 JST | 前季〜来季＋歴代トップのみ取得し、既存データにマージ（約250リクエスト） |
| 週次 | 日曜 03:30 JST | 全作品を再取得して置き換え（約5,450リクエスト・6分） |

手動実行時に `mode` へ `all` を指定すると、任意のタイミングで全件更新できます。

### カバー率

対応表にTMDB IDが存在する作品のみが対象です。古い作品ほど下がります。

| 対象 | 配信情報を表示できた割合 |
| --- | --- |
| 歴代トップ50 | 88% |
| 2006年春 | 82% |
| 2020年春 | 76% |
| 1998年春 | 42% |

## ファイル構成

```
anime.html                        アプリ本体（単一ファイル）
index.html                        紹介ページ
data/streaming.json               国内の配信情報（Actions が生成）
scripts/fetch-streaming.mjs       配信情報の取得スクリプト
.github/workflows/streaming.yml   日次 / 週次の更新ワークフロー
```

## ローカルでの実行

```
git clone https://github.com/Naatlant/anime-matome.git
```

`anime.html` をブラウザで開けば動作します。ただし **`file://` で開いた場合は配信情報だけ表示されません**。ブラウザがローカルファイルへの `fetch` を禁止しているためで、他の機能はすべて動作します。配信情報も含めて確認したい場合は、任意の静的サーバー経由で開いてください。

## フォークして使う場合

配信情報の更新を動かすには、以下の設定が必要です。表示するだけなら不要です。

1. [TMDB](https://www.themoviedb.org/settings/api) で無料のAPIキーを取得する（Developer を選択）
2. リポジトリの Settings → Secrets and variables → Actions で `TMDB_API_KEY` を登録する
3. Settings → Actions → General → Workflow permissions を **Read and write permissions** にする

ローカルで手動実行する場合は、リポジトリ直下に `.tmdb_key` というファイルを作ってキーだけを書いてください（`.gitignore` 済み）。

```
node scripts/fetch-streaming.mjs        # 前季〜来季＋歴代トップ（マージ）
node scripts/fetch-streaming.mjs --all  # 全作品（全置換）
```

## ライセンス

ソースコードは [MIT License](LICENSE) です。ただし**適用範囲はこのリポジトリで書かれたコードに限られます**。

| 対象 | ライセンス |
| --- | --- |
| `anime.html` / `index.html` / `scripts/` / `.github/` | MIT |
| `data/streaming.json` | **MIT対象外**。TMDB / JustWatch に帰属 |
| `assets/tmdb.svg` | **MIT対象外**。TMDBの商標（帰属表示のために同梱） |

配信データは [TMDB API Terms of Use](https://www.themoviedb.org/api-terms-of-use) に従います。同規約はTMDBコンテンツの再許諾（sublicense）を認めていないため、このJSONを再利用する場合は、**ご自身でTMDBのAPIキーを取得し、同規約を遵守してください**。商用利用はできません（広告収入や集客目的の利用も商用と見なされます）。

## プライバシー

利用者の情報は一切収集しません。アクセス解析も広告も、独自のサーバーもありません。お気に入りや表示設定はブラウザの localStorage にのみ保存され、端末外へ送信されることはありません。

## 各データ源の規約について

- **非公式**。本プロジェクトは AniList・TMDB と提携関係になく、これらの承認を受けたものでもありません。
- **AniList** はAPIの非営利利用を認めており、競合するリスト／トラッカーサービスとしての利用を制限しています。本アプリは各作品からAniListのページへリンクを張り、AniListが持たない日本国内の情報（配信状況、放送日の扱い）を加える位置づけです。
- **ID対応表とODbL**。[Fribb/anime-lists](https://github.com/Fribb/anime-lists) 自体はライセンス未設定ですが、派生元の [anime-offline-database](https://github.com/manami-project/anime-offline-database) は **ODbL 1.0 / DbCL 1.0** で公開されています。ODbLは派生データベースの同一ライセンス公開を求めており、これはTMDBの再許諾禁止と衝突します。そのため**対応表はビルド中の照合にのみ使い、`data/streaming.json` にTMDBのIDを一切書き出していません**。公開しているのはAniList IDとサービス名だけです。
- **上流の維持状況**。anime-offline-database はアーカイブ済みで、Fribb/anime-lists は[引き継ぎ手を募集中](https://github.com/Fribb/anime-lists/issues/30)です。新規作品のカバー率は今後伸びなくなる可能性があります。
- 表紙画像は AniList のCDNから配信されており、権利は各権利者に帰属します。

## クレジット

- 作品情報・画像: [AniList](https://anilist.co)
- あらすじ: [ウィキペディア日本語版](https://ja.wikipedia.org/)（CC BY-SA）
- 配信情報: [![TMDB](assets/tmdb.svg)](https://www.themoviedb.org/) / JustWatch
- ID対応表: [Fribb/anime-lists](https://github.com/Fribb/anime-lists) ← [anime-offline-database](https://github.com/manami-project/anime-offline-database)（[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) / DbCL 1.0）

> This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.

各作品の権利は権利者に帰属します。本リポジトリは非営利の公開ツールであり、表示内容の正確性を保証するものではありません。配信状況は変動するため、実際の視聴可否は各サービスでご確認ください。
