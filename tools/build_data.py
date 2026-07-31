# -*- coding: utf-8 -*-
"""
EIASS(환경영향평가정보지원시스템)에서 "평가서 초안 공람" 목록을 가져와
data/projects.json 을 만드는 스크립트.

수집 대상은 전략환경영향평가 / 환경영향평가 두 유형이고,
오늘 날짜가 공람기간 안에 들어있는 사업만 골라 담는다.

사업마다 다음을 순서대로 한다.
  1. 목록에서 사업명·협의기관·공람기간을 얻는다.
  2. 상세 페이지에서 사업위치(주소)·협의기관 담당자·첨부파일 목록을 얻는다.
  3. 첨부파일 중 "요약문"이 들어간 파일을 찾아 내려받고 PDF에서 글자만 뽑는다.
  4. VWorld 지오코딩으로 주소를 위경도로 바꾼다. (VWORLD_KEY 필요)
  5. 뽑은 글자를 Anthropic API로 보내, 정해진 항목 틀(EIA_FIELDS)에 맞춘
     "환경영향분석"을 받는다. 요약문에 없는 항목은 비워 둔다. (ANTHROPIC_API_KEY 필요)

첫 화면의 동네 드롭다운에 쓰는 전국 행정구역 목록은 tools/build_regions.py 가 따로 만든다.

키가 없으면 해당 단계만 건너뛰고 나머지는 정상적으로 만든다.
API 키는 코드에 직접 적지 말고, 이 파일과 같은 폴더가 아니라
저장소 맨 위(EIASS 폴더)에 ".env" 파일을 만들어서 아래처럼 적어둔다.
(.env는 .gitignore에 있어서 GitHub에는 올라가지 않는다.)

    VWORLD_KEY=발급받은 vworld 키
    ANTHROPIC_API_KEY=발급받은 anthropic 키

그 다음부턴 그냥 이렇게 실행하면 된다. (매번 $env: 안 쳐도 됨 — 자동으로 .env를 읽는다)
    python tools/build_data.py

테스트로 몇 건만 빠르게 돌려보고 싶으면:
    python tools/build_data.py --limit 3 --skip-summary --skip-geocode

윈도우 작업 스케줄러로 매일 아침 9시에 자동 실행하게 등록하는 방법은
README나 대화에서 안내한 절차를 따른다 (이 스크립트 자체는 그대로 두면 됨).
"""

import argparse
import datetime
import io
import json
import os
import re
import sys
import time

import requests
from dotenv import load_dotenv
from lxml import html as lhtml

# EIASS 폴더 맨 위에 있는 .env 파일을 읽어서 환경변수로 등록한다.
# (이미 $env: 로 직접 넣어둔 값이 있으면 그 값이 우선한다.)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

BASE = "https://www.eiass.go.kr"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}

VWORLD_DATA_URL = "https://api.vworld.kr/req/data"
RIVER_LAYER = "LT_C_WKMSTRM"      # 하천망도 (하천 구역)
ROUTE_SIMPLIFY_TOL = 0.0004        # 약 40m — 도형을 이 정도까지 단순화한다
ROUTE_MAX_KM = 60                  # 사업 위치에서 이만큼 떨어진 동명이천은 버린다

# 이 저장소를 만든 개발 환경(샌드박스)에서만 인증서 검증이 막혀 있었다.
# 실제 사용자 PC에서는 기본값(검증함)을 그대로 쓰면 된다.
# 검증 오류가 나서 도저히 안 될 때만 EIASS_INSECURE_SSL=1 로 잠깐 꺼서 확인해본다.
VERIFY_SSL = os.environ.get("EIASS_INSECURE_SSL") != "1"
if not VERIFY_SSL:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 전략환경영향평가 / 환경영향평가 — 목록·상세 URL과 검색엔진 파라미터가 유형별로 다르다.
CATEGORIES = {
    "strat": {
        "alias": 1,
        "label": "전략환경영향평가",
        "view_path": "/partcptn/choan/choanSperssView.do",
        "view_name_suffix": "Sperss",
        "needs_step_cd": True,
    },
    "main": {
        "alias": 2,
        "label": "환경영향평가",
        "view_path": "/partcptn/choan/choanEiassView.do",
        "view_name_suffix": "Eiass",
        "needs_step_cd": False,
    },
}

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "projects.json")


def log(msg):
    """윈도우 명령창은 한글 코드페이지(cp949)를 쓰는 경우가 있어서,
    표시할 수 없는 문자가 섞이면 프로그램이 죽는다. 그런 문자는 물음표로 바꿔서라도 계속 진행한다."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


# ============================================================
# 1) 목록 수집 — 검색엔진 API(searchApi/search.do)를 그대로 흉내낸다.
# ============================================================
def fetch_list_page(category_key, page):
    cat = CATEGORIES[category_key]
    url_string = f"&alias={cat['alias']}&orgnCd=&sido="
    params = {
        "query": "",
        "collection": "draft",
        "urlString": url_string,
        "viewName": f"eiass/user/partcptn/choan/choan{cat['view_name_suffix']}List_searchApi",
        "currentPage": page,
        "sort": "DRFOP_TMDT_START_DT/DESC,BIZ_SEQ/DESC",
    }
    r = requests.post(f"{BASE}/searchApi/search.do", data=params,
                       headers=HEADERS, verify=VERIFY_SSL, timeout=20)
    r.raise_for_status()
    return r.text


def parse_period(text):
    """'2026.07.30 ~ 2026.09.14' 같은 문자열을 (시작일, 종료일)로 나눈다. 실패하면 (None, None)."""
    m = re.search(r"(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})", text)
    if not m:
        return None, None
    start = datetime.datetime.strptime(m.group(1), "%Y.%m.%d").date()
    end = datetime.datetime.strptime(m.group(2), "%Y.%m.%d").date()
    return start.isoformat(), end.isoformat()


def parse_list_html(html_text, category_key):
    tree = lhtml.fromstring(html_text)
    rows = tree.xpath("//table[contains(@class,'tbl01')]//tbody/tr")
    items = []
    for row in rows:
        links = row.xpath(".//a[contains(@href,\"view('\")]")
        if not links:
            continue
        href = links[0].get("href", "")
        args = re.findall(r"'([^']*)'", href)
        if len(args) < 2:
            continue
        tds = row.xpath("./td")
        items.append({
            "category": category_key,
            "biz_cd": args[0],
            "biz_seq": args[1],
            "step_cd": args[2] if len(args) > 2 else None,
            "name": links[0].text_content().strip(),
            # 전략환경영향평가는 이 칸이 "협의기관", 환경영향평가는 "사업구분".
            # 최종 협의기관 값은 어차피 상세 페이지에서 다시 확실하게 가져온다.
            "list_meta": tds[1].text_content().strip() if len(tds) > 1 else "",
            "period_start": None,
            "period_end": None,
        })
        if tds:
            s, e = parse_period(tds[-1].text_content())
            items[-1]["period_start"] = s
            items[-1]["period_end"] = e
    return items


def fetch_open_items(category_key, today, max_pages, delay):
    """공람기간에 오늘이 포함된 사업만 모은다.

    목록은 공람 시작일이 최신 순으로 정렬돼 있다. 그래서 뒤로 갈수록 오래전에
    시작한 사업만 나오는데, 시작일이 오늘로부터 이미 90일 넘게 지난 사업은
    공람기간(보통 14~30일)이 진작 끝났을 게 뻔하므로 그쯤에서 그만 뒤진다.
    """
    open_items = []
    label = CATEGORIES[category_key]["label"]
    for page in range(1, max_pages + 1):
        html_text = fetch_list_page(category_key, page)
        items = parse_list_html(html_text, category_key)
        if not items:
            break

        oldest_start = None
        for it in items:
            if not it["period_start"]:
                continue
            start = datetime.date.fromisoformat(it["period_start"])
            end = datetime.date.fromisoformat(it["period_end"])
            if oldest_start is None or start < oldest_start:
                oldest_start = start
            if start <= today <= end:
                open_items.append(it)

        log(f"  [{label}] {page}페이지 확인 ({len(items)}건, 누적 공람중 {len(open_items)}건)")

        if oldest_start is not None and (today - oldest_start).days > 90:
            break
        time.sleep(delay)
    return open_items


# ============================================================
# 2) 상세 페이지 — 주소·협의기관·첨부파일 목록
# ============================================================
def fetch_detail_html(category_key, biz_cd, biz_seq, step_cd):
    cat = CATEGORIES[category_key]
    data = {"BIZ_CD": biz_cd, "BIZ_SEQ": biz_seq}
    if cat["needs_step_cd"] and step_cd:
        data["CCIL_STEP1_CD_CK"] = step_cd
    r = requests.post(f"{BASE}{cat['view_path']}", data=data,
                       headers=HEADERS, verify=VERIFY_SSL, timeout=20)
    r.raise_for_status()
    return r.text


def _row_first_td_text(tree, th_keyword):
    rows = tree.xpath(f"//tr[th[contains(normalize-space(text()),'{th_keyword}')]]")
    if not rows:
        return None
    tds = rows[0].xpath("./td")
    if not tds:
        return None
    return re.sub(r"\s+", " ", tds[0].text_content()).strip()


def empty_detail():
    """상세 페이지에서 뽑아내는 항목의 빈 틀.

    상세 조회가 실패했을 때도 이 틀을 그대로 쓴다. 실패한 건만 값이 비어 있을 뿐
    키는 모두 있어야, 뒤에서 detail["briefWhen"] 처럼 꺼내 쓸 때 죽지 않는다.
    """
    return {
        "address": None, "org": None, "tel": None, "files": [],
        # 사업위치 유형. 전략환경영향평가는 면형/선형/점형이 표시되지만
        # 환경영향평가 쪽은 표시가 없어서 None 으로 둔다(추측하지 않는다).
        "locationTypes": [],
        "segments": [],   # 선형 사업의 구간 목록 (시점/종점/연장)
        "bizType": None,  # 사업구분 (예: "하천이용 / 하천기본계획")
        "lawBasis": None, # 협의대상 근거 법령
        # 아래는 주민이 실제로 참여할 때 필요한 정보 (유형별로 항목 이름이 조금씩 다르다)
        "viewPlace": None,     # 공람 장소
        "briefPlace": None,    # 설명회 장소
        "briefWhen": None,     # 설명회 일시
        "opinionPeriod": None, # 의견제출 기간(공람기간과 다를 수 있다)
        "deptName": None,      # 의견을 받는 부서
        "deptTel": None,       # 그 부서 전화번호
    }


def parse_detail_html(html_text):
    tree = lhtml.fromstring(html_text)
    result = empty_detail()

    # 사업위치 항목 이름이 유형별로 다르다 ("사업위치" 또는 "사업지위치").
    # 면형(소재지+면적 표) / 점형·선형(그냥 주소 텍스트) 둘 다 있을 수 있다.
    loc_rows = tree.xpath("//tr[th[contains(normalize-space(text()),'위치')]]")
    if loc_rows:
        addr_cells = loc_rows[0].xpath(".//table[contains(@class,'detail_tbl')]//td[1]")
        if addr_cells:
            addr = addr_cells[0].text_content()
        else:
            tds = loc_rows[0].xpath("./td")
            addr = tds[0].text_content() if tds else ""
        addr = re.sub(r"\s+", " ", addr).strip()
        # 주소가 여러 필지를 나열해 길 때는 지오코딩용으로 첫 구간만 쓴다.
        addr = addr.split(")")[0].strip() + ")" if ")" in addr else addr
        # "시점 : ", "종점 : " 같은 도로·하천 사업의 구간 표시 라벨은 지오코딩에 방해만 되니 뗀다.
        addr = re.sub(r"^\S*\s*:\s*", "", addr).strip()
        result["address"] = addr

        # 위치 유형(면형/선형/점형) — EIASS가 표시해 주는 경우에만 담는다.
        for s in loc_rows[0].xpath(".//p[contains(@class,'txt_bul1')]/strong"):
            t = re.sub(r"\s+", "", s.text_content())
            if t in ("면형", "선형", "점형") and t not in result["locationTypes"]:
                result["locationTypes"].append(t)

        # 선형이면 구간 표에서 시점·종점·연장을 뽑아 둔다.
        if "선형" in result["locationTypes"]:
            for tr in loc_rows[0].xpath(".//table[contains(@class,'detail_tbl')]//tbody/tr"):
                tds = [re.sub(r"\s+", " ", td.text_content()).strip() for td in tr.xpath("./td")]
                if not tds:
                    continue
                m = re.search(r"시\s*점\s*:\s*(.+?)\s*종\s*점\s*:\s*(.+)$", tds[0])
                if not m:
                    continue
                result["segments"].append({
                    "from": m.group(1).strip(),
                    "to": m.group(2).strip(),
                    "length": tds[-1] if len(tds) >= 4 else None,
                })

    # "협의기관" 표기가 없는 유형(환경영향평가)은 "승인기관"으로 대신한다.
    result["org"] = _row_first_td_text(tree, "협의기관") or _row_first_td_text(tree, "승인기관")
    result["tel"] = _row_first_td_text(tree, "전화번호")
    result["bizType"] = _row_first_td_text(tree, "사업구분")
    result["lawBasis"] = _row_first_td_text(tree, "협의대상")

    # 공람·설명회·의견제출 정보. 라벨이 유형에 따라
    # "의견제출 기간" / "의견 제출 기한" 처럼 다르므로 넉넉하게 찾는다.
    result["viewPlace"] = _row_first_td_text(tree, "공람 장소")
    result["briefPlace"] = _row_first_td_text(tree, "설명회 장소")
    result["briefWhen"] = _row_first_td_text(tree, "설명회 일시")
    result["opinionPeriod"] = (_row_first_td_text(tree, "의견제출")
                               or _row_first_td_text(tree, "의견 제출"))
    result["deptName"] = _row_first_td_text(tree, "부서명")

    # 부서명 바로 뒤에 오는 전화번호가 의견 접수처 번호다.
    dept_rows = tree.xpath("//tr[th[contains(normalize-space(text()),'부서명')]]")
    if dept_rows:
        later = dept_rows[0].xpath("./following-sibling::tr[th[contains(.,'전화번호')]][1]/td[1]")
        if later:
            result["deptTel"] = re.sub(r"\s+", " ", later[0].text_content()).strip() or None

    for a in tree.xpath("//a[contains(@href,'generalView(')]"):
        args = re.findall(r"'([^']*)'", a.get("href", ""))
        if len(args) >= 2:
            result["files"].append({"file_seq": args[0], "file_name": args[1]})

    return result


def find_summary_file(files):
    for f in files:
        if "요약문" in f["file_name"]:
            return f
    return None


def download_file(file_seq, system_name="PERSS"):
    url = f"{BASE}/common/file/downloadFileByFileSeq.do"
    r = requests.get(url, params={"FILE_SEQ": file_seq, "SYSTEM_NAME": system_name},
                      headers=HEADERS, verify=VERIFY_SSL, timeout=60)
    r.raise_for_status()
    return r.content


# ============================================================
# 3-1) 하천 사업의 노선 도형 가져오기
#
#  평가서 도면에는 노선이 그림으로만 있고 좌표가 없어서, 도면을 읽어내는 것은
#  기준점이 없어 정확도를 보장할 수 없다. 그래서 대신
#    요약문 글자에서 하천 이름을 찾고 → VWorld 하천망도에서 그 하천의 실제 도형을 받는다.
#  받은 도형은 점이 수만 개라 브라우저에서 무거우므로 40m 정도까지 단순화한다.
# ============================================================

# "계획하천"처럼 이름이 아닌 일반 표현은 걸러낸다.
RIVER_NAME_BLOCKLIST = {
    "하천", "계획하천", "지방하천", "국가하천", "소하천", "대상하천", "해당하천",
    "주요하천", "인근하천", "주변하천", "기존하천", "상류하천", "하류하천",
}


def extract_river_names(text):
    names = set(re.findall(r"([가-힣]{2,6}천)\b", text or ""))
    return sorted(n for n in names if n not in RIVER_NAME_BLOCKLIST)


# 하천을 따라가는 사업인지 판단한다.
# 도로·철도 사업 요약문에도 '지나가는 하천' 이름이 나오므로, 사업 자체가
# 하천 사업일 때만 하천 도형을 노선으로 쓴다.
RIVER_BIZ_HINTS = ("하천", "河川", "수계", "河")


def is_river_project(name, biz_type, law_basis):
    haystack = " ".join(filter(None, [biz_type, law_basis, name]))
    # 사업구분·근거법령에 '하천'이 있으면 확실하다. (예: "하천이용 / 하천기본계획", "「하천법」")
    if biz_type and "하천" in biz_type:
        return True
    if law_basis and "하천" in law_basis:
        return True
    # 사업구분 정보가 없을 때만 사업명으로 판단한다.
    if not biz_type and not law_basis:
        return any(h in (name or "") for h in RIVER_BIZ_HINTS)
    return False


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
    """GeoJSON 좌표 묶음(중첩 리스트)을 재귀로 훑어 단순화한다."""
    if not coords:
        return coords
    if isinstance(coords[0][0], (int, float)):
        thinned = _douglas_peucker([tuple(c[:2]) for c in coords], tol)
        return [[round(x, 5), round(y, 5)] for x, y in thinned]
    return [_simplify_coords(c, tol) for c in coords]


def _first_point(coords):
    c = coords
    while c and isinstance(c[0], list):
        c = c[0]
    return c if c and isinstance(c[0], (int, float)) else None


def _rough_km(lat1, lon1, lat2, lon2):
    return (((lat1 - lat2) * 111) ** 2 + ((lon1 - lon2) * 88) ** 2) ** 0.5


def fetch_river_routes(names, lat, lon, key, domain, max_names=8):
    """하천 이름들로 실제 도형을 받아 [{name, type, coordinates}] 로 돌려준다."""
    if not key or not names:
        return []
    routes = []
    for name in names[:max_names]:
        try:
            r = requests.get(VWORLD_DATA_URL, params={
                "service": "data", "request": "GetFeature", "data": RIVER_LAYER,
                "key": key, "domain": domain, "format": "json",
                "size": 20, "geometry": "true", "attrFilter": f"riv_nm:like:{name}",
            }, verify=VERIFY_SSL, timeout=60)
            res = r.json().get("response", {})
            if res.get("status") != "OK":
                continue
            for f in res.get("result", {}).get("featureCollection", {}).get("features", []):
                geom = f.get("geometry") or {}
                coords = geom.get("coordinates")
                if not coords:
                    continue
                # 같은 이름의 다른 지역 하천은 버린다.
                if lat is not None and lon is not None:
                    p = _first_point(coords)
                    if p and _rough_km(lat, lon, p[1], p[0]) > ROUTE_MAX_KM:
                        continue
                routes.append({
                    "name": f.get("properties", {}).get("riv_nm") or name,
                    "type": geom.get("type"),
                    "coordinates": _simplify_coords(coords, ROUTE_SIMPLIFY_TOL),
                })
        except Exception as e:
            log(f"    [하천 도형 조회 오류] {name}: {e}")
        time.sleep(0.15)
    return routes


# ============================================================
# 3) PDF에서 글자만 뽑기
# ============================================================
def extract_pdf_text(pdf_bytes, max_pages=25):
    import pdfplumber
    parts = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for i, page in enumerate(pdf.pages):
            if i >= max_pages:
                break
            parts.append(page.extract_text() or "")
    return "\n".join(parts).strip()


# ============================================================
# 4) VWorld 지오코딩 — 주소 → 위경도
# ============================================================
def build_address_candidates(address):
    """"경기도 포천시 일동면 기산리 (운악청계로1480번길 8-1)" 같은 주소는
    동/리 이름과 도로명이 괄호로 겹쳐 있어 지오코더가 못 찾는 경우가 있다.
    그래서 원래 문자열 외에, 도로명 부분만 따로 뽑은 후보도 함께 시도한다."""
    candidates = [address]

    m = re.match(r"^(\S+[시도])\s+(\S+[시군구])\s+.*\(([^)]+)\)\s*$", address)
    if m:
        sido, sigungu, road_part = m.groups()
        candidates.append(f"{sido} {sigungu} {road_part}")  # 시/도 시군구 + 도로명주소만
        candidates.append(road_part)  # 도로명주소만

    # 순서를 지키면서 중복은 제거한다.
    seen = set()
    unique = []
    for c in candidates:
        c = c.strip()
        if c and c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def geocode_address(address, vworld_key):
    if not vworld_key or not address:
        return None, None
    url = "https://api.vworld.kr/req/address"
    for candidate in build_address_candidates(address):
        for addr_type in ("road", "parcel"):
            try:
                r = requests.get(url, params={
                    "service": "address",
                    "request": "getcoord",
                    "version": "2.0",
                    "crs": "epsg:4326",
                    "address": candidate,
                    "type": addr_type,
                    "key": vworld_key,
                }, verify=VERIFY_SSL, timeout=10)
                point = r.json().get("response", {}).get("result", {}).get("point")
                if point:
                    return float(point["y"]), float(point["x"])
            except Exception as e:
                log(f"    [지오코딩 오류:{addr_type}:{candidate}] {e}")
    return None, None


# ============================================================
# 5) 환경영향분석 — 평가서 요약문을 정해진 항목 틀에 맞춰 쉬운 말로 옮긴다.
#    항목을 고정해 두면 "원문에 없는 얘기"가 슬쩍 들어가는 것을 막을 수 있고,
#    사업마다 같은 형식으로 비교해 볼 수 있다.
#    (화면의 assets/app.js 의 EIA_FIELDS 와 키가 같아야 한다)
# ============================================================
EIA_FIELDS = [
    ("overview", "어떤 사업인가 — 무엇을 어디에 얼마나 만드는지"),
    ("air", "공기·먼지·냄새에 대한 영향"),
    ("noise", "소음·진동에 대한 영향"),
    ("water", "물(수질·지하수·하천)에 대한 영향"),
    ("nature", "동식물·생태(숲, 서식지, 보호종 등)에 대한 영향"),
    ("land", "토양·경관(토양 오염, 지형 변경, 산림 훼손, 경관 변화)에 대한 영향"),
    ("waste", "폐기물에 대한 영향"),
    ("etc", "위 항목에 안 들어가지만 주민 생활에 영향을 주는 내용"),
]


def analyze_environment(name, address, raw_text, anthropic_key):
    """요약문 원문에서 항목별로 뽑아 쉬운 말로 옮긴 dict 를 돌려준다.
    원문에 해당 내용이 없으면 그 항목은 None 으로 남긴다."""
    if not anthropic_key or not raw_text:
        return None
    import anthropic

    field_lines = "\n".join(f'  "{k}": {desc}' for k, desc in EIA_FIELDS)
    client = anthropic.Anthropic(api_key=anthropic_key)
    prompt = (
        "너는 환경영향평가서 요약문을 주민이 읽을 수 있는 말로 '옮기는' 사람이야.\n"
        "요약문에 적힌 내용을 쉬운 말로 바꾸는 것만 하고, 없는 내용을 만들거나\n"
        "좋다/나쁘다 판단을 더하면 절대 안 된다.\n\n"
        "== 반드시 지킬 것 ==\n"
        "1. 아래 요약문 원문에 실제로 적힌 내용만 쓴다. 원문에 없는 숫자·영향·결론을\n"
        "   지어내지 마라. 네가 아는 일반 지식으로 채우지 마라.\n"
        "2. 어떤 항목에 대한 내용이 원문에 없으면 그 항목 값은 반드시 null 로 둬라.\n"
        "   '언급 없음' 같은 문장을 쓰지 말고 null 을 넣어라. 억지로 채우지 마라.\n"
        "3. 사업을 홍보하거나, 걱정할 필요 없다는 식의 의견을 넣지 마라.\n"
        "   원문에 저감 대책이 적혀 있으면 '~하기로 되어 있다'처럼 사실로만 전달해라.\n"
        "4. 전문용어는 풀어 쓴다. 한 항목은 1~3문장, 짧게.\n"
        "5. 마크다운 기호(#, *, - 등)를 쓰지 말고 평범한 문장으로만 써라.\n\n"
        "== 출력 형식 ==\n"
        "설명이나 인사말 없이, 아래 키를 가진 JSON 객체 하나만 출력해라.\n"
        "각 값은 쉬운 말 문장(문자열) 또는 null 이다.\n"
        "{\n" + field_lines + "\n}\n\n"
        f"사업명: {name}\n"
        f"위치: {address or '정보 없음'}\n\n"
        "요약문 원문(이 안에 있는 내용만 사용할 것):\n"
        f"{raw_text[:12000]}\n"
    )
    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text").strip()
        # 혹시 ```json 같은 감싸는 표시가 붙어 오면 떼어낸다.
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1:
            log(f"    [환경영향분석 형식 오류] {name}")
            return None
        parsed = json.loads(text[start:end + 1])

        result = {}
        for key, _ in EIA_FIELDS:
            v = parsed.get(key)
            result[key] = v.strip() if isinstance(v, str) and v.strip() else None
        return result
    except Exception as e:
        log(f"    [환경영향분석 오류] {name}: {e}")
        return None


# ============================================================
# 전체 흐름
# ============================================================
def build(args):
    today = datetime.date.today()
    vworld_key = os.environ.get("VWORLD_KEY", "")
    vworld_domain = os.environ.get("VWORLD_DOMAIN", "http://localhost:8000")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    if not args.skip_geocode and not vworld_key:
        log("[안내] VWORLD_KEY 환경변수가 없어서 위치 좌표(위경도)는 비워둡니다.")
    if not args.skip_summary and not anthropic_key:
        log("[안내] ANTHROPIC_API_KEY 환경변수가 없어서 쉬운말 요약은 비워둡니다.")

    all_projects = []

    for category_key, cat in CATEGORIES.items():
        label = cat["label"]
        log(f"[{label}] 공람 중인 사업 목록 수집 시작")
        open_items = fetch_open_items(category_key, today, args.max_pages, args.delay)
        if args.limit:
            open_items = open_items[: args.limit]
        log(f"[{label}] 공람 중 {len(open_items)}건 상세 조회 시작")

        for it in open_items:
            log(f"  - {it['name']}")
            try:
                detail_html = fetch_detail_html(category_key, it["biz_cd"], it["biz_seq"], it["step_cd"])
                detail = parse_detail_html(detail_html)
            except Exception as e:
                # 한 건이 실패해도 나머지 수집은 계속한다.
                log(f"    [상세 조회 실패] {e}")
                detail = empty_detail()
            time.sleep(args.delay)

            summary_file = find_summary_file(detail["files"])
            raw_text = None
            if summary_file and not args.skip_summary:
                try:
                    pdf_bytes = download_file(summary_file["file_seq"])
                    raw_text = extract_pdf_text(pdf_bytes)
                except Exception as e:
                    log(f"    [요약문 PDF 처리 실패] {e}")

            lat = lon = None
            if not args.skip_geocode:
                lat, lon = geocode_address(detail["address"], vworld_key)

            analysis = None
            if raw_text:
                analysis = analyze_environment(it["name"], detail["address"], raw_text, anthropic_key)
                if analysis:
                    filled = sum(1 for v in analysis.values() if v)
                    log(f"    환경영향분석 {filled}/{len(EIA_FIELDS)}개 항목 채움")

            # 노선 도형은 '선형 + 하천 사업'에만 자동으로 찾는다.
            #  · 면형: 주소 한 점으로 충분하다.
            #  · 선형이지만 도로·철도 사업: 요약문에 나오는 하천 이름은 그냥 '지나가는 하천'이라
            #    그것을 노선으로 그리면 틀린 그림이 된다. 관리자가 직접 그리도록 남겨둔다.
            #  · 환경영향평가: EIASS에 유형 표시가 없어 함부로 선형으로 보지 않는다.
            location_types = detail.get("locationTypes") or []
            is_linear = "선형" in location_types
            is_river = is_river_project(it["name"], detail.get("bizType"), detail.get("lawBasis"))
            river_names, routes = [], []
            if is_linear and is_river and raw_text and not args.skip_route:
                river_names = extract_river_names(raw_text)
                if river_names:
                    routes = fetch_river_routes(river_names, lat, lon, vworld_key, vworld_domain)
                log(f"    선형/하천 사업: 하천 이름 {len(river_names)}개, 노선 도형 {len(routes)}개")
            elif is_linear:
                log("    선형이지만 하천 사업이 아니어서 자동 노선을 찾지 않음 (관리자가 직접 그리기)")
            elif location_types:
                log(f"    위치 유형 {'/'.join(location_types)} (노선 조회 안 함)")

            all_projects.append({
                "id": f"{it['biz_cd']}-{it['biz_seq']}",
                "category": category_key,
                "categoryLabel": label,
                "name": it["name"],
                "org": detail["org"] or it["list_meta"],
                "tel": detail["tel"],
                "address": detail["address"],
                "locationTypes": location_types,
                "segments": detail.get("segments") or [],
                "bizType": detail.get("bizType"),
                "isRiver": bool(is_linear and is_river),
                "lat": lat,
                "lon": lon,
                "periodStart": it["period_start"],
                "periodEnd": it["period_end"],
                "viewPlace": detail["viewPlace"],
                "briefPlace": detail["briefPlace"],
                "briefWhen": detail["briefWhen"],
                "opinionPeriod": detail["opinionPeriod"],
                "deptName": detail["deptName"],
                "deptTel": detail["deptTel"],
                "summaryFileSeq": summary_file["file_seq"] if summary_file else None,
                "analysis": analysis,
                # 노선 도형. 자동으로 못 찾은 사업은 관리자 화면에서 직접 그려 넣을 수 있다.
                "riverNames": river_names,
                "routeGeom": routes or None,
                "routeSource": "vworld-river" if routes else None,
                # 화면에서 "EIASS 원문 보기" 링크를 만들 때 그대로 쓴다.
                # (EIASS 상세페이지는 GET 링크가 아니라 이 값들을 넣어 POST로 열어야 한다.)
                "sourceBizCd": it["biz_cd"],
                "sourceBizSeq": it["biz_seq"],
                "sourceStepCd": it["step_cd"],
                "sourceViewPath": cat["view_path"],
            })

    # 마지막으로 한 번 더 걸러낸다. 수집이 자정을 넘겨 오래 돌면
    # 시작할 때는 공람 중이었지만 저장 시점엔 끝난 사업이 섞일 수 있다.
    end_day = datetime.date.today()
    kept = [p for p in all_projects
            if p["periodStart"] and p["periodEnd"]
            and datetime.date.fromisoformat(p["periodStart"]) <= end_day
            <= datetime.date.fromisoformat(p["periodEnd"])]
    dropped = len(all_projects) - len(kept)
    if dropped:
        log(f"[안내] 공람 기간이 끝난 {dropped}건은 저장하지 않았습니다.")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": end_day.isoformat(),
            "note": ("이 파일은 tools/build_data.py가 EIASS 공개 자료를 바탕으로 자동 생성합니다. "
                     "생성 시점에 초안 공람 기간 안에 있던 사업만 담겨 있습니다."),
            "projects": kept,
        }, f, ensure_ascii=False, indent=2)

    log(f"완료: {OUT_PATH} 에 {len(kept)}건 저장 (모두 공람 기간 중)")


def main():
    parser = argparse.ArgumentParser(description="EIASS 초안 공람 데이터 수집")
    parser.add_argument("--limit", type=int, default=None, help="유형별 최대 수집 건수 (테스트용)")
    parser.add_argument("--max-pages", type=int, default=60, help="목록 페이지 최대 조회 수")
    parser.add_argument("--delay", type=float, default=0.4, help="요청 사이 대기 시간(초)")
    parser.add_argument("--skip-geocode", action="store_true", help="vworld 지오코딩 건너뛰기")
    parser.add_argument("--skip-summary", action="store_true", help="요약문 PDF 다운로드/LLM 요약 건너뛰기")
    parser.add_argument("--skip-route", action="store_true", help="하천 노선 도형 조회 건너뛰기")
    args = parser.parse_args()
    build(args)


if __name__ == "__main__":
    sys.exit(main())
