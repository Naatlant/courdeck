/**
 * 手元で確認するための静的サーバー。依存パッケージなし。
 *
 *   node scripts/serve.mjs        → http://localhost:8765
 *   node scripts/serve.mjs 3000   → ポートを指定する場合
 *
 * file:// で開くと配信情報（data/streaming.json）だけ読み込めないため、
 * 公開時と同じ状態を確認したいときはこちらを使う。
 *
 * A tiny dependency-free static server for local checks. Streaming badges do not
 * load over file://, so use this when you want the same result as the published site.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.argv[2]) || 8765;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".md": "text/plain; charset=utf-8",
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.resolve(path.join(ROOT, url === "/" ? "/index.html" : url));
  if (!file.startsWith(ROOT)) {           /* ディレクトリ外への参照を拒否 */
    res.writeHead(403);
    res.end("403");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 " + url);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",        /* 編集がすぐ反映されるように */
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log("http://localhost:" + PORT + "/  (Ctrl+C で終了)");
});
