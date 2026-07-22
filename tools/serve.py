"""Local dev server for the static site.

Mirrors Vercel's production behaviour ("cleanUrls": true):
  - /admin/team resolves to admin/team.html
  - .html URLs keep working as-is

Also sends Cache-Control: no-cache on every response so the browser always
revalidates — no more stale admin pages during development.

Run via `npm start` (python3 tools/serve.py [port]).
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CleanUrlHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        resolved = super().translate_path(path)
        # Clean URL: no extension and not a real file/dir -> try <path>.html
        base = resolved.split("?")[0].split("#")[0]
        if not os.path.exists(base) and not os.path.splitext(base)[1]:
            candidate = base.rstrip("/") + ".html"
            if os.path.isfile(candidate):
                return candidate
        return resolved

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), CleanUrlHandler) as srv:
        print(f"Serving {ROOT} at http://localhost:{PORT} (clean URLs, no-cache)")
        srv.serve_forever()
