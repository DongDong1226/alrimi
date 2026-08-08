# -*- coding: utf-8 -*-
"""
전국 시·도 경계 도형을 미리 단순화해서 data/sido.json 으로 저장한다.

    python tools/build_boundaries.py

왜 미리 만들어 두는가:
    읍·면·동과 시·군·구 경계는 화면에서 VWorld 를 그때그때 불러 쓴다 (작다 — 9KB, 84KB).
    그런데 **시·도는 원본이 너무 크다.** 실측 경기도 3,189KB / 좌표 79,576점.
    휴대폰에서 그걸 매번 받아 그리면 통신량도 크고 그리는 것도 느리다.

    다행히 시·도 경계는 **거의 바뀌지 않는다.** 그래서 여기서 한 번 받아
    Douglas-Peucker 로 단순화해 저장해 두고, 화면은 그 파일만 읽는다.
    실측: 경기도 79,576점 → 200m 단순화 시 2,528점(3.2%), 103KB.

    화면에서 시·도 경계는 나라 전체가 보이는 정도로만 확대되므로
    200m 오차는 눈에 보이지 않는다. (읍면동처럼 가까이 볼 일이 없다)

자료는 VWorld 2D데이터 API 의 시도 경계 레이어(LT_C_ADSIDO_INFO)에서 가져온다.
VWORLD_KEY 는 .env 에서 읽는다. (build_data.py 와 같은 키)

인증키를 발급받을 때 등록한 서비스 URL이 http://localhost:8000 이 아니라면
.env 에 VWORLD_DOMAIN=등록한주소 를 추가한다.

행정구역이 개편되었을 때만 다시 돌리면 된다.
"""

import json
import os
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

VWORLD_DATA_URL = "https://api.vworld.kr/req/data"
SIDO_LAYER = "LT_C_ADSIDO_INFO"     # 시도 경계
KOREA_BOX = "BOX(124,33,132,39)"     # 우리나라 전체를 덮는 사각형

# 약 200m. 시·도는 나라 전체가 보이는 축척에서만 쓰므로 이 정도면 눈에 안 보인다.
# (build_data.py 의 하천 노선은 40m 를 쓴다 — 그건 가까이서 보기 때문)
SIMPLIFY_TOL = 0.0018

# 이보다 작은 섬(가로·세로 최대변, 도 단위 ≈ 2.2km)은 통째로 버린다.
#
# 왜 필요한가: 단순화는 조각(ring)마다 따로 도는데, 다각형은 최소 4점이라 더 줄지 않는다.
# 전남광주통합특별시는 작은 섬이 수천 개라 그것만으로 47,169점 · 1MB 가 됐다.
# 전국이 한눈에 들어오는 축척에서 2km 짜리 섬은 **한 픽셀도 안 된다.**
#
# ★ 판정에는 영향이 없다. `inHood()` 는 "주소 글자 일치 **또는** 경계 안"이라
#   섬에 있는 사업도 주소("전남광주통합특별시 신안군 …")로 이미 걸린다.
#   경계는 노선이 구역을 지나는 경우를 더 잡아 주는 보조 수단일 뿐이다.
MIN_ISLAND_DEG = 0.02

VERIFY_SSL = os.environ.get("EIASS_INSECURE_SSL") != "1"
if not VERIFY_SSL:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "sido.json")


def log(msg):
    """윈도우 명령창은 한글 코드페이지(cp949)를 쓰는 경우가 있어서,
    표시할 수 없는 문자가 섞이면 프로그램이 죽는다. 그런 문자는 물음표로 바꿔서라도 계속 진행한다."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


# ------------------------------------------------------------
# 도형 단순화 — build_data.py 의 것과 같은 방식이다.
# (파일을 나눠 두는 편이 서로 영향을 안 줘서 안전하다)
# ------------------------------------------------------------
def _douglas_peucker(points, tol):
    """선을 이루는 점을 tol(도 단위) 안에서 줄인다."""
    if len(points) < 3:
        return points

    def dist(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
        t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        px, py = x1 + t * dx, y1 + t * dy
        return ((x - px) ** 2 + (y - py) ** 2) ** 0.5

    i_max, d_max = 0, 0.0
    for i in range(1, len(points) - 1):
        d = dist(points[i], points[0], points[-1])
        if d > d_max:
            i_max, d_max = i, d
    if d_max <= tol:
        return [points[0], points[-1]]
    return _douglas_peucker(points[:i_max + 1], tol)[:-1] + _douglas_peucker(points[i_max:], tol)


def _simplify_coords(coords, tol):
    """GeoJSON 좌표 묶음(중첩 리스트)을 재귀로 훑어 단순화한다.

    ★ 다각형은 선과 달리 **닫혀 있어야 한다**(첫 점 = 끝 점).
      단순화해도 그 성질이 깨지지 않게 확인한다. 깨지면 지도에 구멍이 뚫린 것처럼 그려진다."""
    if not coords:
        return coords
    if isinstance(coords[0][0], (int, float)):
        closed = len(coords) > 2 and coords[0][:2] == coords[-1][:2]
        thinned = _douglas_peucker([tuple(c[:2]) for c in coords], tol)
        out = [[round(x, 5), round(y, 5)] for x, y in thinned]
        # 점이 너무 줄어 다각형이 안 되면(3점 미만) 원본을 그대로 둔다
        if closed:
            if len(out) < 4:
                out = [[round(c[0], 5), round(c[1], 5)] for c in coords]
            elif out[0] != out[-1]:
                out.append(out[0])
        return out
    return [_simplify_coords(c, tol) for c in coords]


def _ring_span(ring):
    """조각(ring)의 가로·세로 중 큰 쪽 (도 단위)."""
    xs = [c[0] for c in ring]
    ys = [c[1] for c in ring]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def drop_small_islands(geom):
    """작은 섬을 버린다. 본토(가장 큰 조각)는 무슨 일이 있어도 남긴다.

    MultiPolygon 은 [다각형, 다각형, ...] 이고 각 다각형은 [바깥선, 구멍, 구멍...] 이다.
    바깥선 크기만 보고 판단한다 (구멍은 바깥선과 함께 남거나 함께 사라진다)."""
    if geom["type"] != "MultiPolygon":
        return geom, 0

    polys = geom["coordinates"]
    spans = [_ring_span(p[0]) for p in polys]
    biggest = max(range(len(polys)), key=lambda i: spans[i])
    kept = [p for i, p in enumerate(polys) if i == biggest or spans[i] >= MIN_ISLAND_DEG]
    return {"type": "MultiPolygon", "coordinates": kept}, len(polys) - len(kept)


def count_points(coords):
    if not coords:
        return 0
    if isinstance(coords[0][0], (int, float)):
        return len(coords)
    return sum(count_points(c) for c in coords)


def fetch_sido(key, domain):
    """시·도 경계를 모두 받아 [(이름, geometry)] 로 돌려준다."""
    params = {
        "service": "data", "request": "GetFeature", "data": SIDO_LAYER,
        "key": key, "domain": domain, "format": "json",
        "size": 100, "geometry": "true", "crs": "EPSG:4326",
        "geomFilter": KOREA_BOX,
    }
    r = requests.get(VWORLD_DATA_URL, params=params, verify=VERIFY_SSL, timeout=300)
    r.raise_for_status()
    res = r.json().get("response", {})
    if res.get("status") != "OK":
        err = res.get("error", {})
        raise SystemExit(
            f"[VWorld 오류] {err.get('code')} {err.get('text')}\n"
            "  · 인증키에 '2D데이터 API'가 포함돼 있는지\n"
            "  · .env 의 VWORLD_DOMAIN 이 발급 때 등록한 서비스 URL과 같은지 확인하세요."
        )
    feats = res.get("result", {}).get("featureCollection", {}).get("features", [])
    out = []
    for f in feats:
        name = (f.get("properties") or {}).get("ctp_kor_nm")
        geom = f.get("geometry")
        if name and geom and geom.get("coordinates"):
            out.append((name, geom))
    return out


def build():
    key = os.environ.get("VWORLD_KEY", "").strip()
    if not key:
        raise SystemExit("VWORLD_KEY 가 없습니다. .env 파일에 넣어 주세요.")
    domain = os.environ.get("VWORLD_DOMAIN", "http://localhost:8000").strip()

    log("VWorld에서 시·도 경계를 받아옵니다 (용량이 커서 1~2분 걸립니다)")
    t0 = time.time()
    items = fetch_sido(key, domain)
    log(f"시·도 {len(items)}개, {time.time() - t0:.0f}초")
    if not items:
        raise SystemExit("시·도를 하나도 받지 못했습니다. 저장하지 않고 멈춥니다.")

    sido = {}
    total_before = total_after = 0
    for name, geom in sorted(items):
        before = count_points(geom["coordinates"])
        trimmed, dropped = drop_small_islands(geom)
        simple = _simplify_coords(trimmed["coordinates"], SIMPLIFY_TOL)
        after = count_points(simple)
        total_before += before
        total_after += after
        sido[name] = {"type": trimmed["type"], "coordinates": simple}
        kb = len(json.dumps(sido[name], ensure_ascii=False)) / 1024
        note = f", 작은 섬 {dropped:,}개 뺌" if dropped else ""
        log(f"  {name}: {before:,}점 → {after:,}점 ({after / before * 100:.1f}%), {kb:.0f} KB{note}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"sido": sido}, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(OUT_PATH) / 1024
    log("")
    log(f"완료: {OUT_PATH}")
    log(f"  좌표 {total_before:,}점 → {total_after:,}점 ({total_after / total_before * 100:.1f}%)")
    log(f"  파일 크기 {size_kb:.0f} KB")
    if size_kb > 1200:
        log("  [주의] 1.2MB 가 넘습니다. SIMPLIFY_TOL 을 키워 더 줄이는 편이 좋습니다.")


if __name__ == "__main__":
    sys.exit(build())
