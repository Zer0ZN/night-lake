"""Playwright screenshot harness for the Night Lake scene.

Usage:
  python tools/shot.py --name hero
  python tools/shot.py --view living --js "window.__NL.setLamp(true)" --name lamp
  python tools/shot.py --pose "1.9,1.7,8.6,0.2,1.6,0.4,62" --name custom
"""
import argparse
import functools
import http.server
import os
import socketserver
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")
os.makedirs(SHOTS, exist_ok=True)

ARGS = [
    "--use-angle=d3d11",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
]


def serve(port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)

    class Q(http.server.ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    httpd = Q(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="shot")
    ap.add_argument("--view", default=None)
    ap.add_argument("--pose", default=None)
    ap.add_argument("--js", default=None)
    ap.add_argument("--w", type=int, default=1600)
    ap.add_argument("--h", type=int, default=1000)
    ap.add_argument("--port", type=int, default=8160)
    ap.add_argument("--quality", default="high")
    ap.add_argument("--wait", type=int, default=1400)
    ap.add_argument("--hide-ui", action="store_true")
    a = ap.parse_args()

    serve(a.port)
    url = f"http://127.0.0.1:{a.port}/index.html?q={a.quality}"
    out = os.path.join(SHOTS, f"{a.name}.png")

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True, args=ARGS)
        pg = browser.new_page(viewport={"width": a.w, "height": a.h}, device_scale_factor=1)
        logs = []
        pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        pg.goto(url, wait_until="load", timeout=90000)
        try:
            pg.wait_for_function("window.__NL_READY === true", timeout=120000)
        except Exception as e:
            print("NOT READY:", e)
            pg.screenshot(path=os.path.join(SHOTS, "FAILED.png"))
            for l in logs[-40:]:
                print(l)
            browser.close()
            raise SystemExit(1)

        time.sleep(1.2)
        if a.hide_ui:
            pg.evaluate("document.body.classList.add('hide-ui')")
        if a.view:
            ok = pg.evaluate("(v) => window.__NL.viewV(v)", a.view)
            print("view", a.view, ok)
        if a.pose:
            px, py, pz, tx, ty, tz, fov = [float(v) for v in a.pose.split(",")]
            pg.evaluate(
                """([px,py,pz,tx,ty,tz,fov]) => {
                    const N = window.__NL, T = window.__THREE;
                    N.player.enabled = false;
                    const c = N.camera;
                    c.fov = fov; c.updateProjectionMatrix();
                    c.position.set(px,py,pz);
                    c.lookAt(new T.Vector3(tx,ty,tz));
                }""",
                [px, py, pz, tx, ty, tz, fov],
            )
        if a.js:
            res = pg.evaluate(a.js)
            if res is not None:
                print("JS =>", res)

        time.sleep(a.wait / 1000.0)
        pg.screenshot(path=out)
        stats = pg.evaluate("window.__NL.stats()")
        print("stats", stats)
        errs = [l for l in logs if "pageerror" in l or l.startswith("[error]")]
        print("errors", errs[:12])
        browser.close()
    print("saved", out)


if __name__ == "__main__":
    main()
