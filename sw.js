/**
 * Courdeck の Service Worker。ホーム画面から起動できるようにし、機内モードでも
 * 直前に見た内容を出せるようにするためのもの。
 *
 * 扱うのは同一オリジンの静的ファイルだけ。AniList・Wikipedia・画像CDNへの通信には
 * 一切触れない（勝手に握ると、アプリ側の6時間キャッシュや取得失敗時の表示と食い違う）。
 *
 * 更新の届け方に注意すること。新しい版を勝手に有効化すると、閲覧中の画面が
 * 差し替わったり、逆に古い版を掴んだまま更新が永久に届かなくなったりする。
 * ここでは待機させておき、利用者が「再読み込み」を押したときだけ交代する。
 * 交代の合図は index.html 側の controllerchange で受ける。
 *
 * 単一ファイル配布の利点は壊さない。index.html だけをダウンロードしても
 * 従来どおり動き、このファイルはあくまで任意の拡張という位置づけ。
 */

/* キャッシュしている中身を変えたら必ず上げること。古いキャッシュは activate で消す */
const VERSION = "v2";
const SHELL = "courdeck-shell-" + VERSION;
const DATA = "courdeck-data-" + VERSION;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/apple-touch-icon.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  /* ここで skipWaiting() はしない。交代は利用者が選ぶ */
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("courdeck-") && k !== SHELL && k !== DATA) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;   /* 外部への通信には触らない */

  /* アプリ本体は更新確認を優先する。オフラインのときだけキャッシュに落とす。
     クエリで画面状態を持つ設計なので、どのURLで来ても実体は index.html 1つに寄せる */
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, "./index.html"));
    return;
  }

  /* 配信情報も更新確認を優先。オンラインなら常に最新を返すので、
     アプリ側の6時間キャッシュ（localStorage、AniList用）と食い違わない */
  if (url.pathname.endsWith("/data/streaming.json")) {
    e.respondWith(networkFirst(req, DATA));
    return;
  }

  /* アイコンとマニフェストは変わらないのでキャッシュ優先。
     それ以外の同一オリジンのリクエストには手を出さない */
  if (url.pathname.includes("/assets/") || url.pathname.endsWith("/manifest.webmanifest")) {
    e.respondWith(cacheFirst(req, SHELL));
  }
});

async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(key || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key || req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}
