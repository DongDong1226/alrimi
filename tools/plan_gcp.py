# 도면에서 기준점 후보를 뽑는다 (노선 그리기 도구 보조)
#
# ■ 이 도구가 하는 일과 하지 않는 일
#   하는 일   : 도면에 적힌 **지명을 읽고, 그 글자가 도면의 어디에 있는지** AI 가 짚는다.
#               그 지명의 **실제 좌표는 VWorld** 가 준다.
#   안 하는 일: **AI 에게 위경도를 묻지 않는다.**
#
#   2026-08-17 실측 — 같은 도면, 같은 모델:
#     · 위경도를 직접 내게 하면      위치 오차 **중앙값 925m** (노선이 통째로 900m 밀렸다)
#     · 이미지 안 위치만 짚게 하면   **중앙값 3px** (그 도면에서 약 24m)
#   그래서 '보는 일'만 맡기고 '지구 어디인지'는 VWorld 에 맡긴다.
#   자세한 것은 docs/HISTORY.md 2026-08-17 항목.
#
# ■ 왜 브라우저(관리자 화면)에서 바로 못 하나
#   Anthropic 키가 브라우저로 가야 하는데, **도메인 제한이 없어 유출되면 곧바로 요금**이 나간다.
#   (VWorld 키는 도메인 제한이 걸려 있어 예외였다. CLAUDE.md 규칙 4 참고)
#   그래서 AI 호출은 여기 파이썬에서 하고, 결과 JSON 만 도구에 붙여넣는다.
#
# ■ 쓰는 법
#   python tools/plan_gcp.py 도면.png --id YS2026C001-45777
#   python tools/plan_gcp.py 도면.png --id ... --out gcp.json
#
#   나온 JSON 을 route_editor.html 의 '기준점 후보 붙여넣기' 칸에 넣는다.
import argparse, base64, io, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as bd          # .env 읽기 · SESSION · geocode_address 를 그대로 쓴다

MODEL = "claude-sonnet-5"        # 시각 인식이라 해석용(haiku)보다 한 급 위를 쓴다
MAX_TOKENS = 8000

# 지명 종류별로 좌표가 얼마나 믿을 만한가 (작을수록 믿을 만하다).
#   ★ '동' 이름은 VWorld 가 **동의 대표 지번**을 주는데 동 중심에서 0.7~2.5km 어긋난다
#     (2026-08-08 실측). 기준점으로는 마지막에 쓴다.
KIND_RANK = {"station": 0, "intersection": 1, "building": 2, "bridge": 2, "other": 3, "dong": 4}
KIND_KO = {"station": "역", "intersection": "교차로", "building": "건물·시설",
           "bridge": "다리", "dong": "동 이름", "other": "그 밖"}

PROMPT = """이것은 한국의 개발사업 환경영향평가 **도면**입니다. 크기는 {w}x{h} 픽셀입니다.

도면에 글자로 적힌 **지명**을 모두 찾아 주세요. 예: 역 이름, 교차로, 다리, 건물·시설 이름, 동네 이름.

각각에 대해:
- name : 적혀 있는 글자 그대로 (고치거나 보충하지 마세요)
- x, y : 그 **글자의 중심** 픽셀 좌표 (왼쪽 위가 0,0 / 오른쪽으로 x / 아래로 y)
- kind : station(역) | intersection(교차로) | bridge(다리) | building(건물·시설) | dong(동·리 이름) | other

**중요**
- 위도·경도는 **절대 추측하지 마세요.** 좌표는 다른 자료에서 가져옵니다.
- 범례·방위표·축척·제목은 지명이 아닙니다. 넣지 마세요.
- 글자가 흐려 확실하지 않으면 넣지 마세요.

**이 JSON 만** 출력하세요:
{{"labels":[{{"name":"...","x":0,"y":0,"kind":"station"}}]}}"""


def ask_ai(img_bytes, media, w, h, key):
    import anthropic
    cl = anthropic.Anthropic(api_key=key)
    msg = cl.messages.create(
        model=MODEL, max_tokens=MAX_TOKENS,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media,
                                         "data": base64.b64encode(img_bytes).decode()}},
            {"type": "text", "text": PROMPT.format(w=w, h=h)}]}])
    # 소넷은 '생각' 덩어리가 섞여 오므로 text 만 고른다 (CLAUDE.md 참고)
    txt = "".join(b.text for b in msg.content if b.type == "text")
    s, e = txt.find("{"), txt.rfind("}")
    if s < 0:
        raise ValueError("AI 가 JSON 을 내지 않았습니다: " + txt[:160])
    return json.loads(txt[s:e + 1]).get("labels") or []


def haversine(a, b):
    """(lat,lon) 두 점 사이 거리 m"""
    R = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def locate(label, project, key):
    """지명 -> 좌표. 사업 주소를 앞에 붙여 같은 이름의 다른 동네를 피한다."""
    nm = (label.get("name") or "").strip()
    if not nm:
        return None, "이름 없음"
    addr = (project or {}).get("address") or ""
    head = " ".join(addr.split()[:2])          # 예: "전남광주통합특별시 강진군"
    tries = [f"{head} {nm}", nm] if head else [nm]
    for t in tries:
        lat, lon = bd.geocode_address(t, key)
        if lat is not None:
            return (lat, lon), t
    return None, "VWorld 에서 못 찾음"


def fit_and_rms(gcps):
    """기준점끼리 아귀가 맞는지 본다 (어파인, 최소제곱). 남는 오차를 m 로 돌려준다.

    ★ 이 숫자가 크면 AI 가 짚은 것들이 **서로 모순**이라는 뜻이다 — 그대로 쓰면 안 된다.
      B안(AI 가 좌표를 직접 냄)이 실패한 이유가 이런 검산이 없어서였다.
    """
    if len(gcps) < 3:
        return None
    lat0 = sum(g["lat"] for g in gcps) / len(gcps)
    mx, my = 111320 * math.cos(math.radians(lat0)), 110540
    P = [(g["x"], g["y"]) for g in gcps]
    Q = [(g["lon"] * mx, g["lat"] * my) for g in gcps]

    def solve(col):
        A = [[0.0] * 3 for _ in range(3)]
        b = [0.0] * 3
        for (x, y), q in zip(P, Q):
            v = [x, y, 1.0]
            for i in range(3):
                for j in range(3):
                    A[i][j] += v[i] * v[j]
                b[i] += v[i] * q[col]
        M = [row[:] + [b[i]] for i, row in enumerate(A)]
        for i in range(3):
            p = max(range(i, 3), key=lambda r: abs(M[r][i]))
            if abs(M[p][i]) < 1e-12:
                return None
            M[i], M[p] = M[p], M[i]
            for r in range(3):
                if r == i:
                    continue
                f = M[r][i] / M[i][i]
                for c in range(i, 4):
                    M[r][c] -= f * M[i][c]
        return [M[i][3] / M[i][i] for i in range(3)]

    a, c = solve(0), solve(1)
    if not a or not c:
        return None
    errs = []
    for (x, y), q in zip(P, Q):
        ex = a[0] * x + a[1] * y + a[2] - q[0]
        ey = c[0] * x + c[1] * y + c[2] - q[1]
        errs.append(math.hypot(ex, ey))
    return math.sqrt(sum(e * e for e in errs) / len(errs))


def main():
    ap = argparse.ArgumentParser(description="도면에서 기준점 후보를 뽑는다")
    ap.add_argument("image", help="도면 그림 파일 (png/jpg)")
    ap.add_argument("--id", dest="pid", default=None,
                    help="사업번호 — 사업 위치에서 먼 후보를 걸러내는 데 쓴다 (권장)")
    ap.add_argument("--max-km", type=float, default=60.0,
                    help="사업 위치에서 이보다 먼 후보는 버린다 (기본 60km)")
    ap.add_argument("--out", default=None, help="JSON 을 파일로도 저장")
    args = ap.parse_args()

    key_ai = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
    key_vw = (os.getenv("VWORLD_KEY") or "").strip()
    if not key_ai:
        bd.log("[중단] .env 에 ANTHROPIC_API_KEY 가 없습니다.")
        sys.exit(1)
    if not key_vw:
        bd.log("[중단] .env 에 VWORLD_KEY 가 없습니다. 좌표를 채울 수 없습니다.")
        sys.exit(1)

    try:
        from PIL import Image
    except ImportError:
        bd.log("[중단] Pillow 가 필요합니다: pip install pillow")
        sys.exit(1)

    raw = open(args.image, "rb").read()
    w, h = Image.open(io.BytesIO(raw)).size
    media = "image/png" if args.image.lower().endswith(".png") else "image/jpeg"
    bd.log(f"[도면] {os.path.basename(args.image)} {w}x{h}")

    project = None
    if args.pid:
        try:
            rows = json.load(open(bd.OUT_PATH, encoding="utf-8"))["projects"]
            project = next((p for p in rows if str(p["id"]) == str(args.pid)), None)
        except Exception as e:
            bd.log(f"  [안내] projects.json 을 못 읽었습니다: {e}")
        if project:
            bd.log(f"[사업] {project['name'][:36]} — {project.get('address') or '(주소 없음)'}")
        else:
            bd.log(f"  [안내] 사업번호 {args.pid} 를 찾지 못했습니다. 거리 검사를 건너뜁니다.")

    bd.log(f"[AI] 도면에서 지명을 읽는 중… ({MODEL})")
    labels = ask_ai(raw, media, w, h, key_ai)
    bd.log(f"  지명 {len(labels)}개를 찾았습니다.")

    base = None
    if project and project.get("lat") is not None:
        base = (project["lat"], project["lon"])

    out, dropped = [], []
    for L in labels:
        nm = (L.get("name") or "").strip()
        kind = (L.get("kind") or "other").strip()
        x, y = L.get("x"), L.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            dropped.append((nm, "픽셀 좌표 없음"))
            continue
        if not (0 <= x <= w and 0 <= y <= h):
            dropped.append((nm, "도면 밖 좌표"))
            continue
        pos, how = locate(L, project, key_vw)
        if not pos:
            dropped.append((nm, how))
            continue
        if base:
            km = haversine(base, pos) / 1000
            if km > args.max_km:
                dropped.append((nm, f"사업 위치에서 {km:.0f}km — 같은 이름의 다른 곳으로 보임"))
                continue
        out.append({"name": nm, "kind": kind, "x": round(float(x), 1), "y": round(float(y), 1),
                    "lat": round(pos[0], 7), "lon": round(pos[1], 7), "via": how,
                    "trust": KIND_RANK.get(kind, 3)})

    out.sort(key=lambda g: g["trust"])

    bd.log("")
    bd.log("=== 기준점 후보 ===")
    if not out:
        bd.log("  쓸 만한 후보가 없습니다. 도면에 지명이 없거나 VWorld 가 못 찾았습니다.")
    for g in out:
        mark = "  " if g["trust"] <= 2 else "! "
        bd.log(f" {mark}{g['name']:<14} {KIND_KO.get(g['kind'], g['kind']):<7} "
               f"픽셀({g['x']:.0f},{g['y']:.0f})  ->  {g['lat']:.5f},{g['lon']:.5f}")
    if any(g["trust"] >= 4 for g in out):
        bd.log("  ! 표시는 **동·리 이름**입니다 — VWorld 가 '동 대표 지번'을 주므로")
        bd.log("    동 중심에서 0.7~2.5km 어긋날 수 있습니다. 지도에서 반드시 옮겨 주세요.")
    for nm, why in dropped:
        bd.log(f"  [버림] {nm or '(이름없음)'} — {why}")

    rms = fit_and_rms([g for g in out if g["trust"] <= 3]) or fit_and_rms(out)
    if rms is not None:
        judge = "좋습니다" if rms < 300 else "큽니다 — 서로 안 맞는 후보가 섞여 있습니다"
        bd.log(f"\n[아귀 검사] 후보끼리 맞춰 본 남는 오차 약 {rms:.0f}m — {judge}")
    else:
        bd.log("\n[아귀 검사] 후보가 3개 미만이라 건너뜁니다.")

    payload = {"image": {"w": w, "h": h}, "projectId": args.pid,
               "gcps": out, "rms": None if rms is None else round(rms),
               "note": "AI 는 도면에서 지명과 그 픽셀 위치만 읽었고, 좌표는 VWorld 가 준 것입니다. "
                       "반드시 사람이 확인하세요."}
    js = json.dumps(payload, ensure_ascii=False)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(js)
        bd.log(f"\n저장: {args.out}")
    bd.log("\n=== 아래를 복사해 노선 그리기 도구의 '기준점 후보 붙여넣기' 에 넣으세요 ===")
    print(js)


if __name__ == "__main__":
    main()
