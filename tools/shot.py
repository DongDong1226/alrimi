# 화면을 그림으로 찍어 두는 도구 (개발 보조)
#
# ■ 왜 필요한가
#   치수를 재는 것만으로는 "답답한지 넉넉한지"를 알 수 없다. 눈으로 봐야 한다.
#   그런데 브라우저 창을 안 띄우면 화면 캡처가 막히므로, 창 없이 찍는 길을 둔다.
#
# ■ 쓰는 법
#   1) 저장소 폴더에서  python -m http.server 8000
#   2) python tools/shot.py                      → 휴대폰 첫 화면
#      python tools/shot.py --page m.html --full → 휴대폰 전체(스크롤 포함)
#      python tools/shot.py --pc                 → 넓은 화면
#      python tools/shot.py --page m.html --click "#setForm button[type=submit]"
#
#   결과는 tools/_shots/ 에 저장된다 (.gitignore 의 `_*` 규칙과 무관하므로 커밋하지 말 것).
#
# ■ 두 가지 방법을 다 쓴다
#   · playwright 가 있으면 그것을 쓴다 — **진짜 휴대폰 흉내**가 된다
#     (viewport meta 를 따르고, 화면 배율 3배, 손가락 기기로 인식 → m.html 판정이 맞게 돈다)
#   · 없으면 크롬/엣지를 headless 로 부른다. 설치가 필요 없지만 데스크톱 취급이라
#     `pointer:coarse` 가 아니어서 index.html 이 m.html 로 넘어가지 않는다
import argparse, os, subprocess, sys

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_shots")
CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def log(msg):
    # 윈도우 콘솔(cp949)에서 죽지 않게 (build_data.py 와 같은 이유)
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("cp949", "replace").decode("cp949"))


def shoot_playwright(url, out, w, h, mobile, full, click, wait, scroll):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": w, "height": h},
            device_scale_factor=3 if mobile else 1,
            is_mobile=mobile, has_touch=mobile,   # 이게 있어야 pointer:coarse 로 잡힌다
        )
        page = ctx.new_page()
        page.goto(url, wait_until="networkidle")
        page.wait_for_timeout(wait)
        if click:
            try:
                page.click(click, timeout=4000)
                page.wait_for_timeout(1200)
            except Exception as e:
                log(f"  [누르기 실패] {click}: {type(e).__name__}")
        if scroll:
            page.evaluate("y => scrollTo(0, y === 'bottom' ? document.body.scrollHeight : +y)",
                          scroll)
            page.wait_for_timeout(600)
        # 가로로 삐져나간 것이 있으면 알려 준다 — 캡처만 보면 잘린 줄 모른다
        over = page.evaluate(
            "()=>({doc:document.documentElement.scrollWidth,"
            "view:document.documentElement.clientWidth})")
        page.screenshot(path=out, full_page=full)
        ctx.close()
        browser.close()
        return over


def shoot_chrome(url, out, w, h, full):
    exe = next((c for c in CHROMES if os.path.exists(c)), None)
    if not exe:
        log("크롬도 엣지도 못 찾았습니다."); return None
    cmd = [exe, "--headless=new", "--disable-gpu", "--hide-scrollbars",
           f"--window-size={w},{h}", f"--screenshot={out}", url]
    subprocess.run(cmd, capture_output=True)
    return None


def main():
    ap = argparse.ArgumentParser(description="화면을 그림으로 찍는다")
    ap.add_argument("--page", default="m.html")
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--out", default=None)
    ap.add_argument("--pc", action="store_true", help="넓은 화면(1280x900)으로")
    ap.add_argument("--size", default=None, help="예: 375x812")
    ap.add_argument("--full", action="store_true", help="스크롤까지 전부")
    ap.add_argument("--click", default=None, help="찍기 전에 누를 것 (CSS 선택자)")
    ap.add_argument("--wait", type=int, default=1500, help="기다릴 시간(ms)")
    ap.add_argument("--scroll", default=None, help="찍기 전에 내릴 위치: 숫자(px) 또는 bottom")
    args = ap.parse_args()

    w, h = (1280, 900) if args.pc else (375, 812)
    if args.size:
        w, h = (int(x) for x in args.size.lower().split("x"))
    mobile = not args.pc and min(w, h) <= 600

    os.makedirs(OUT_DIR, exist_ok=True)
    name = args.out or (args.page.replace(".html", "") +
                        ("-pc" if args.pc else "") + ("-full" if args.full else "") + ".png")
    out = os.path.join(OUT_DIR, name)
    url = f"{args.base}/{args.page}"

    try:
        over = shoot_playwright(url, out, w, h, mobile, args.full, args.click, args.wait, args.scroll)
    except Exception as e:
        log(f"playwright 를 못 써서 크롬으로 찍습니다 ({type(e).__name__})")
        over = shoot_chrome(url, out, w, h, args.full)

    if not os.path.exists(out):
        log("찍지 못했습니다. 서버(python -m http.server 8000)가 켜져 있는지 보세요.")
        sys.exit(1)
    log(f"저장: {out}  ({os.path.getsize(out)//1024}KB, {w}x{h}{' 전체' if args.full else ''})")
    if over and over["doc"] > over["view"]:
        log(f"  ⚠ 가로로 삐져나갔습니다 — 내용 {over['doc']}px > 화면 {over['view']}px")


if __name__ == "__main__":
    main()
