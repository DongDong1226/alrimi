# -*- coding: utf-8 -*-
"""
평가서 PDF 에서 **하천별 도면 그림**과 **소하천 이름표**를 꺼낸다.

왜 필요한가
-----------
옹진군 소하천정비종합계획처럼 구간이 46개인 사업은 노선을 손으로 그리는 것이 사실상 불가능하다.
그런데 평가서에는 하천마다 **위성사진 위에 노선을 그린 도면**이 한 장씩 들어 있다.
그 그림을 꺼내 두면 `route_editor.html` 이 반자동으로 노선을 따올 수 있다.

★ 사람이 PDF 를 열어 스크린샷을 찍는 것보다 훨씬 낫다 —
  **원본 해상도 그대로** 나오고, 화면 배율 때문에 흐려지거나 잘리지 않는다.

무엇을 만드나
-------------
  tools/_plans/<사업번호>/
      01_고남천.png  02_구봉천.png  …        ← 도면 그림 (원본 해상도)
      manifest.json                          ← 그림 ↔ 소하천 이름 ↔ EIASS 구간 짝

manifest.json 이 핵심이다. 그림만 있으면 "이게 몇 번 구간인지"를 사람이 매번 찾아야 하는데,
평가서 표의 **시점·종점 지번**과 EIASS 구간표의 지번을 맞추면 그 짝을 기계가 지을 수 있다.

쓰는 법
-------
  python tools/plan_extract.py --pdf "(본안) 0200 계획의 개요.pdf" --id HG20260499-105294
  python tools/plan_extract.py --pdf 파일.pdf            (사업번호 없이 그림만 꺼내기)

만들어진 폴더는 git 에 올라가지 않는다 (.gitignore 의 tools/_plans/).
"""
import argparse
import io
import json
import os
import re
import sys

OUT_ROOT = os.path.join("tools", "_plans")

# 그림으로 볼 최소 크기. 로고·축척막대(176x43)처럼 작은 것은 건너뛴다.
MIN_IMG_W = 300
MIN_IMG_H = 200


def log(msg):
    """윈도우 명령창은 한글 코드페이지(cp949)를 쓰는 경우가 있어서,
    표시할 수 없는 문자가 섞이면 프로그램이 죽는다. 그런 문자는 물음표로 바꿔서라도 계속 진행한다."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


# ============================================================
# 1) 도면 그림 꺼내기
# ============================================================
def figure_pages(pdf):
    """하천별 도면이 있는 쪽을 찾는다.

    ★ 쪽 번호를 박아 두지 않는다 — 사업마다 다르기 때문이다.
      '번호. ○○천' 꼴 이름표가 2개 이상 있고 큰 그림도 2장 이상인 쪽으로 찾는다."""
    out = []
    for i, pg in enumerate(pdf.pages):
        caps = find_captions(pg)
        bigs = [im for im in pg.images if big_enough(im)]
        if len(caps) >= 2 and len(bigs) >= 2:
            out.append((i + 1, pg, caps, bigs))
    return out


def big_enough(im):
    w, h = im.get("srcsize", (0, 0))
    return (w or 0) >= MIN_IMG_W and (h or 0) >= MIN_IMG_H


CAP_RE = re.compile(r"^(\d{1,3})\.$")


def find_captions(pg):
    """'12.' 과 '이개천' 처럼 **떨어져 있는 두 낱말**을 한 이름표로 묶는다.

    ★ extract_text() 한 줄을 쪼개면 안 된다 — 한 줄에 이름표가 둘씩 있고
      (예: "9. 회룡천 10. 진말천") 각각 좌우 칸에 속하므로 **좌표가 있어야** 짝을 지을 수 있다."""
    words = pg.extract_words()
    caps = []
    for k, w in enumerate(words):
        m = CAP_RE.match(w["text"].strip())
        if not m:
            continue
        # 바로 오른쪽에 있는, 같은 줄의 '○○천'을 찾는다
        for nxt in words[k + 1:k + 4]:
            if abs(nxt["top"] - w["top"]) > 6:
                continue
            name = re.sub(r"\(.*?\)", "", nxt["text"]).strip()   # '고남천(폐지)' -> '고남천'
            if re.match(r"^[가-힣][가-힣0-9]{1,7}천$", name):
                caps.append({
                    "no": int(m.group(1)),
                    "name": name,
                    "raw": nxt["text"],
                    "x": w["x0"], "y": w["top"],
                })
                break
    return caps


def pair_figures(caps, bigs):
    """이름표는 그림 **바로 아래**에 있다. 그 규칙으로 짝을 짓는다.

    ★ 순서(위→아래, 왼→오른)로만 맞추면 안 된다 — 쪽마다 그림 수가 다르고
      로고가 중간에 끼어 있어서 한 칸만 밀려도 **전부 엉뚱한 하천이 붙는다.**
      거리로 맞추고, 너무 멀면 짝을 짓지 않는다."""
    pairs = []
    used = set()
    for c in caps:
        best, bestd = None, 1e9
        for k, im in enumerate(bigs):
            if k in used:
                continue
            # 이름표가 그림 아래쪽 40pt 안, 가로로 겹치는가
            dy = c["y"] - im["bottom"]
            overlap = min(c["x"] + 40, im["x1"]) - max(c["x"], im["x0"])
            if dy < -4 or dy > 40 or overlap <= 0:
                continue
            d = abs(dy) + abs(c["x"] - im["x0"]) * 0.1
            if d < bestd:
                best, bestd = k, d
        if best is None:
            pairs.append((c, None))
        else:
            used.add(best)
            pairs.append((c, bigs[best]))
    return pairs


def save_figures(pdf_path, pages_info, outdir):
    """pypdf 로 원본 이미지를 그대로 저장한다 (다시 그리지 않으므로 화질이 안 떨어진다)."""
    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    saved = []
    for pno, pg, caps, bigs in pages_info:
        pairs = pair_figures(caps, bigs)
        # ★ 두 라이브러리를 **XObject 이름**(Im18 …)으로 맞춘다.
        #   크기로 맞추면 안 된다 — 한 쪽에 945x591 그림이 여덟 장씩 있어서
        #   **전부 첫 장을 집는다.** 실제로 그렇게 만들었다가
        #   문갑천 자리에 회룡천 그림이 들어간 것을 눈으로 보고 잡았다 (2026-08-30).
        bykey = {}
        for pi in reader.pages[pno - 1].images:
            key = re.sub(r"\.\w+$", "", getattr(pi, "name", "") or "")
            if key:
                bykey[key] = pi

        for cap, im in pairs:
            if im is None:
                log("    [%d쪽] %2d. %s — 짝지을 그림을 못 찾았습니다" % (pno, cap["no"], cap["name"]))
                saved.append({"cap": cap, "page": pno, "file": None, "w": None, "h": None})
                continue
            w, h = im.get("srcsize", (0, 0))
            hit = bykey.get(im.get("name"))
            if hit is None:
                log("    [%d쪽] %2d. %s — %s(%sx%s) 그림을 꺼내지 못했습니다"
                    % (pno, cap["no"], cap["name"], im.get("name"), w, h))
                saved.append({"cap": cap, "page": pno, "file": None, "w": w, "h": h})
                continue
            fname = "%02d_%s.png" % (cap["no"], cap["name"])
            hit.image.save(os.path.join(outdir, fname))
            saved.append({"cap": cap, "page": pno, "file": fname, "w": w, "h": h})
    return saved


# ============================================================
# 2) 표에서 소하천 이름·지번·연장 읽기
# ============================================================
# "구봉천 신도리 37-67 신도리 산176-2 1.97 1.75 -0.22 시점부 산지구간 제외"
#          <-- 종점 -->  <-- 시점 -->  기수립 금회  증감
# ★ 이름에 **숫자가 들어가는 하천이 있다** — 제2간척천·북포2천·북포3천·내동2천.
#   [가-힣]만 받으면 이 넷을 통째로 놓친다 (실제로 놓쳐서 구간과 못 짝지었다, 2026-08-30).
TABLE_RE = re.compile(
    r"^([가-힣][가-힣0-9]{1,7}천)\s+(\S+리|\S+동)\s+(산?\d+(?:-\d+)?)\s+"
    r"(\S+리|\S+동)\s+(산?\d+(?:-\d+)?)\s+([\d.]+|-)\s+([\d.]+|-)")


def read_table(pdf):
    """표에서 소하천마다 종점·시점 지번과 연장을 뽑는다.

    ★ 표 머리글이 '소하천명 | 종점 | 시점' 순서다 — **시점이 먼저가 아니다.**
      뒤집어 읽으면 노선이 통째로 거꾸로 붙는다."""
    rows = {}
    for pg in pdf.pages:
        txt = pg.extract_text() or ""
        if "소하천명" not in txt:
            continue
        for line in txt.split("\n"):
            m = TABLE_RE.match(line.strip())
            if not m:
                continue
            name = m.group(1)
            km_now = m.group(7)
            rows[name] = {
                "to": "%s %s" % (m.group(2), m.group(3)),      # 종점
                "from": "%s %s" % (m.group(4), m.group(5)),    # 시점
                "kmBefore": to_f(m.group(6)),
                "km": to_f(km_now),
            }
    return rows


def to_f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


SEG_KM_RE = re.compile(r"([\d.]+)")


def seg_km(seg):
    """EIASS 구간표의 연장('1.75km')을 숫자로."""
    m = SEG_KM_RE.search(str(seg.get("length") or ""))
    return to_f(m.group(1)) if m else None


# ============================================================
# 3) EIASS 구간과 짝짓기
# ============================================================
JIBUN_RE = re.compile(r"\)\s*(\S+리|\S+동)\s+(산?\d+(?:-\d+)?)")


def jibun(addr):
    """EIASS 구간표 주소 뒤쪽의 '리 지번'만 뽑아 표와 같은 꼴로 만든다.
       예: '인천광역시 옹진군 북도면 신도리 (신도로484번길 150) 신도리 산176-2' -> '신도리 산176-2'"""
    a = " ".join(str(addr or "").split())
    m = JIBUN_RE.search(a)
    return ("%s %s" % (m.group(1), m.group(2))) if m else None


def match_segments(table, segments):
    """소하천 이름 -> EIASS 구간 번호(0부터). 못 맞추면 없음.

    양쪽 지번이 다 맞는 것을 먼저 찾고, 없으면 **한쪽만** 맞는 것을 찾는다.
    ★ 한쪽만 맞은 것은 그 사실을 밝힌다 — 평가서와 EIASS 의 지번이 다른 경우가 실제로 있다
      (기수립 지번과 금회 변경 지번이 다르게 적히는 사업이 있다)."""
    out = {}
    taken = set()
    segj = [(jibun(s.get("from")), jibun(s.get("to"))) for s in segments]

    for how, want_both in (("지번", True), ("지번(한쪽만)", False)):
        for name, t in table.items():
            if name in out:
                continue
            for i, (sf, st) in enumerate(segj):
                if i in taken:
                    continue
                fwd = (sf == t["from"], st == t["to"])
                rev = (sf == t["to"], st == t["from"])
                ok = (all(fwd) or all(rev)) if want_both else (any(fwd) or any(rev))
                if not ok:
                    continue
                out[name] = {"seg": i, "how": how, "reversed": (not all(fwd)) and (rev[0] or rev[1])}
                taken.add(i)
                break
    return out


# ============================================================
def build(args):
    import pdfplumber

    if not os.path.exists(args.pdf):
        log("[중단] PDF 를 찾지 못했습니다: %s" % args.pdf)
        return 1

    project = None
    segments = []
    if args.id:
        try:
            data = json.load(io.open(args.data, encoding="utf-8"))
            ps = data["projects"] if isinstance(data, dict) else data
            project = next((p for p in ps if str(p.get("id")) == args.id), None)
        except Exception as e:
            log("[안내] %s 를 읽지 못했습니다 (%s) — 구간 짝짓기는 건너뜁니다" % (args.data, e))
        if project is None:
            log("[안내] 사업번호 %s 를 자료에서 못 찾았습니다 — 구간 짝짓기는 건너뜁니다" % args.id)
        else:
            segments = project.get("segments") or []
            log("[사업] %s — 구간 %d개" % (project.get("name"), len(segments)))

    outdir = os.path.join(OUT_ROOT, args.id or "unknown")
    os.makedirs(outdir, exist_ok=True)

    with pdfplumber.open(args.pdf) as pdf:
        log("[PDF] %d쪽" % len(pdf.pages))
        pages_info = figure_pages(pdf)
        if not pages_info:
            log("[중단] 하천별 도면이 있는 쪽을 찾지 못했습니다.")
            log("       '1. ○○천' 꼴 이름표가 그림 아래 붙어 있는 쪽을 찾습니다.")
            return 1
        log("[도면] %s쪽에서 찾았습니다" % ", ".join(str(p[0]) for p in pages_info))
        table = read_table(pdf)
        log("[표] 소하천 %d개를 읽었습니다" % len(table))
        saved = save_figures(args.pdf, pages_info, outdir)

    pair = match_segments(table, segments) if segments else {}

    streams = []
    for s in saved:
        name = s["cap"]["name"]
        t = table.get(name)
        mt = pair.get(name)
        seg_i = (mt or {}).get("seg")
        ekm = seg_km(segments[seg_i]) if seg_i is not None else None
        tkm = (t or {}).get("km")
        streams.append({
            "no": s["cap"]["no"],
            "name": name,
            "label": s["cap"]["raw"],
            "page": s["page"],
            "image": s["file"],
            "width": s["w"], "height": s["h"],
            "table": t,
            "segment": seg_i,
            "match": (mt or {}).get("how"),
            "reversed": (mt or {}).get("reversed", False),
            # ★ 짝이 '지어졌나'가 아니라 '맞나'를 보는 **독립적인 신호**다.
            #   이름·지번과 다른 값이므로, 이것까지 같으면 짝이 맞다고 볼 수 있다.
            "segmentKm": ekm,
            "kmAgrees": (None if (tkm is None or ekm is None) else abs(tkm - ekm) < 0.02),
        })
    streams.sort(key=lambda x: x["no"])

    manifest = {
        "pdf": os.path.basename(args.pdf),
        "project": {"id": args.id, "name": (project or {}).get("name")} if args.id else None,
        "streams": streams,
    }
    mpath = os.path.join(outdir, "manifest.json")
    io.open(mpath, "w", encoding="utf-8").write(
        json.dumps(manifest, ensure_ascii=False, indent=2))

    # ---- 사람이 읽는 요약 ----
    got = [s for s in streams if s["image"]]
    matched = [s for s in streams if s["segment"] is not None]
    weak = [s for s in matched if s["match"] != "지번"]
    log("")
    log("[결과] 그림 %d/%d장 · 표와 이름 맞은 것 %d개"
        % (len(got), len(streams), sum(1 for s in streams if s["table"])))
    if segments:
        log("       EIASS 구간과 짝지은 것 %d/%d개%s"
            % (len(matched), len(segments),
               (" (그중 %d개는 한쪽 지번만 맞음)" % len(weak)) if weak else ""))

        # ★ 짝이 맞는지 **연장으로 교차 확인**한다. 이름·지번과 다른 신호라서,
        #   이것까지 같으면 짝이 맞다고 볼 수 있다.
        agree = [x for x in matched if x["kmAgrees"] is True]
        clash = [x for x in matched if x["kmAgrees"] is False]
        log("       연장 대조: 같음 %d · 다름 %d" % (len(agree), len(clash)))
        for x in clash:
            log("         ⚠ %s — 평가서 %.2fkm vs EIASS %.2fkm (%d구간)"
                % (x["name"], x["table"]["km"], x["segmentKm"], x["segment"] + 1))
        if clash:
            log("         지번이 양쪽 다 맞는데 연장만 다르면 **EIASS 자료가 틀렸을 수 있습니다** —")
            log("         평가서 표가 원본이므로 그쪽을 믿고, 길이 검산도 그 값으로 하세요.")
        miss = [s["name"] for s in streams if s["segment"] is None]
        if miss:
            log("       도면은 있는데 구간을 못 찾은 하천: %s" % ", ".join(miss))
            log("       (폐지된 하천은 EIASS 구간에 없는 것이 정상입니다)")
        # ★ 반대쪽도 반드시 알린다 — 어느 구간에 도면이 안 붙었는지 모르면
        #   담당자가 46개를 처음부터 다시 훑게 된다.
        done = {s["segment"] for s in streams if s["segment"] is not None}
        left = [i for i in range(len(segments)) if i not in done]
        if left:
            log("       도면이 안 붙은 구간 %d개:" % len(left))
            for i in left:
                log("         %2d구간  %s" % (i + 1, (segments[i].get("from") or "")[:58]))
    log("[저장] %s" % os.path.abspath(outdir))
    log("       manifest.json 에 그림 ↔ 하천 ↔ 구간 짝이 들어 있습니다.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="평가서 PDF 에서 하천별 도면과 이름표를 꺼낸다")
    ap.add_argument("--pdf", required=True, help="평가서 PDF 경로")
    ap.add_argument("--id", default=None, help="EIASS 사업번호 (구간과 짝지으려면 필요)")
    ap.add_argument("--data", default=os.path.join("data", "projects.json"))
    sys.exit(build(ap.parse_args()))


if __name__ == "__main__":
    main()
