"""Local dev server for the static site.

Mirrors Vercel's production behaviour:
  - "cleanUrls": true — /admin/team resolves to admin/team.html, .html URLs keep working
  - "headers" — every entry in vercel.json whose `source` matches the request path is
    sent (security headers, Content-Security-Policy), so a page that breaks under the
    production policy breaks here first. See docs/security-headers.md. Three things are
    deliberately not replayed on plain http (see local_header): HSTS, the CSP's
    upgrade-insecure-requests directive, and production Cache-Control.

Also sends Cache-Control: no-cache on every response so the browser always
revalidates — no more stale admin pages during development.

Run via `npm start` (python3 tools/serve.py [port]).
"""
import http.server
import json
import os
import re
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def local_header(key, value):
    """Production headers that must not be replayed over plain http://localhost.

    - Strict-Transport-Security is meaningless on http and a browser that ever
      honoured it would refuse http://localhost for two years.
    - `upgrade-insecure-requests` in the CSP makes the browser fetch every
      stylesheet, script and image over https://localhost, which this plain
      server receives as TLS handshakes: a page with no styles and a log full
      of garbled 400s.
    - Cache-Control belongs to production; here everything is no-cache.
    Returns (key, value) or None to drop the header."""
    k = key.lower()
    if k in ("strict-transport-security", "cache-control"):
        return None
    if k == "content-security-policy":
        value = "; ".join(d for d in (d.strip() for d in value.split(";")) if d and d != "upgrade-insecure-requests")
    return (key, value)


def load_header_rules(root):
    """[(compiled source regex, [(key, value), ...]), ...] from vercel.json.

    The `source` patterns in this repo are plain regular expressions (Vercel's
    path-to-regexp syntax is a superset); anything that does not compile is
    skipped with a warning rather than taking the dev server down."""
    try:
        with open(os.path.join(root, "vercel.json"), encoding="utf8") as fh:
            entries = json.load(fh).get("headers", [])
    except (OSError, ValueError) as err:
        print(f"warning: could not read vercel.json headers ({err}); serving without them")
        return []
    rules = []
    for entry in entries:
        try:
            pattern = re.compile("^" + entry["source"] + "$")
        except (re.error, KeyError, TypeError) as err:
            print(f"warning: skipping vercel.json header source {entry.get('source')!r}: {err}")
            continue
        rules.append((pattern, [hv for hv in (local_header(h["key"], h["value"]) for h in entry.get("headers", [])) if hv]))
    return rules


HEADER_RULES = load_header_rules(ROOT)


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
        # A malformed request never reaches parse_request's end, so there is no path
        # to match against; still answer it cleanly instead of crashing the handler.
        request_path = getattr(self, "path", "").split("?")[0].split("#")[0]
        for pattern, headers in HEADER_RULES:
            if pattern.match(request_path):
                for key, value in headers:
                    self.send_header(key, value)
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), CleanUrlHandler) as srv:
        print(f"Serving {ROOT} at http://localhost:{PORT} (clean URLs, no-cache, {len(HEADER_RULES)} vercel.json header rule(s))")
        srv.serve_forever()
