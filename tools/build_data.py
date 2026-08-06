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
from urllib.parse import quote

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
EMPTY_PAGE_STREAK = 5              # 공람 중인 사업이 없는 페이지가 이만큼 이어지면 목록 조회를 멈춘다

# 공람이 끝난 뒤에도 의견은 더 받는다 (환경영향평가법 시행령 제38조: 공람 종료 후 7일 이내).
# 목록에는 공람 기간만 나오므로, 공람이 끝난 사업도 이 일수까지는 상세를 받아 두고
# 실제 의견제출 마감일로 마지막에 걸러 낸다. (7일 + 주말·공휴일로 밀리는 며칠을 감안해 넉넉히)
OPINION_GRACE_DAYS = 14

# 이 저장소를 만든 개발 환경(샌드박스)에서만 인증서 검증이 막혀 있었다.
# 실제 사용자 PC에서는 기본값(검증함)을 그대로 쓰면 된다.
# 검증 오류가 나서 도저히 안 될 때만 EIASS_INSECURE_SSL=1 로 잠깐 꺼서 확인해본다.
VERIFY_SSL = os.environ.get("EIASS_INSECURE_SSL") != "1"
if not VERIFY_SSL:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ── 통신 재시도 ──────────────────────────────────────────────────────
# EIASS 는 가끔 연결이 안 된다. **차단이 아니라 불안정한 것이다.**
# 2026-08-06 에 GitHub 서버(미국 Azure)에서 세 번 시험한 결과:
#     1차 52.159.244.171  DNS 조회 실패 (10초)
#     2차 9.234.149.180   DNS 는 됐는데 TCP 443 이 20초 무응답
#     3차 20.161.78.74    전부 정상 (0.23초)
# 같은 데이터센터(2·3차 모두 Boydton)인데 결과가 달랐다. 차단이라면
# 세 번 다 같은 지점에서 막혔어야 한다. 실패 지점도 DNS·TCP 로 제각각이었다.
# 참고로 한국에서는 0.08초, 미국 LA·독일·프랑스 등 해외 17곳에서도 정상이다.
#
# 그래서 한 번 실패했다고 그날 수집을 통째로 포기하지 않도록,
# 모든 요청이 이 통로를 지나가면서 스스로 몇 번 다시 시도하게 한다.
RETRY_TOTAL = int(os.environ.get("EIASS_RETRY", "4"))


def _make_session():
    """재시도가 붙은 공용 통신 통로를 만든다.

    - DNS 조회 실패·연결 실패: 최대 RETRY_TOTAL 번 다시 시도
    - 서버가 잠깐 5xx 로 답하는 경우도 다시 시도
    - 시도 사이에 4초 → 8초 → 16초 씩 쉬어 준다 (상대 서버를 몰아붙이지 않게)
    """
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    s = requests.Session()
    retry = Retry(
        total=RETRY_TOTAL,
        connect=RETRY_TOTAL,        # DNS·TCP 연결이 안 될 때
        read=2,                     # 응답을 받다가 끊겼을 때
        status=2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"]),
        backoff_factor=2,           # 쉬는 시간: 0 → 4 → 8 → 16초
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


SESSION = _make_session()

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
    r = SESSION.post(f"{BASE}/searchApi/search.do", data=params,
                       headers=HEADERS, verify=VERIFY_SSL, timeout=20)
    r.raise_for_status()
    return r.text


def parse_opinion_end(text):
    """'2026.07.30 ~ 2026.09.23' 에서 뒤쪽 날짜만 ISO 형식으로 돌려준다.
    읽지 못하면 None (그때는 화면이 공람 종료일을 대신 쓴다)."""
    m = re.search(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s*~\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})",
                  text or "")
    if not m:
        return None
    try:
        return datetime.date(int(m.group(4)), int(m.group(5)), int(m.group(6))).isoformat()
    except ValueError:
        return None


def parse_period(text):
    """'2026.07.30 ~ 2026.09.14' 같은 문자열을 (시작일, 종료일)로 나눈다. 실패하면 (None, None)."""
    m = re.search(r"(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})", text)
    if not m:
        return None, None
    start = datetime.datetime.strptime(m.group(1), "%Y.%m.%d").date()
    end = datetime.datetime.strptime(m.group(2), "%Y.%m.%d").date()
    return start.isoformat(), end.isoformat()


def parse_list_html(html_text, category_key):
    """목록 페이지 한 쪽에서 사업 목록을 뽑는다.

    주의: EIASS 목록 페이지에는 tbl01 표가 **두 개** 들어 있고 둘 다 같은 사업 10건을
    담고 있다(확인함). 그대로 두면 사업 하나가 두 번 잡혀서 상세 조회도, 요약문 PDF도,
    AI 해석 호출도 전부 두 번씩 일어난다(= 비용 2배, 결과 파일에 같은 사업이 두 번).
    그래서 여기서 사업 번호 기준으로 한 번 걸러 낸다.
    """
    tree = lhtml.fromstring(html_text)
    rows = tree.xpath("//table[contains(@class,'tbl01')]//tbody/tr")
    items = []
    seen = set()
    for row in rows:
        links = row.xpath(".//a[contains(@href,\"view('\")]")
        if not links:
            continue
        href = links[0].get("href", "")
        args = re.findall(r"'([^']*)'", href)
        if len(args) < 2:
            continue
        key = (args[0], args[1])
        if key in seen:
            continue          # 같은 페이지 안의 두 번째 표 — 건너뛴다
        seen.add(key)

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

    예전에는 "시작일이 90일보다 오래된 게 나오면 목록이 옛날 것으로 넘어간 것"이라 보고
    그쯤에서 멈췄다. 그런데 **목록이 시작일 순으로 정렬돼 있지 않다**(확인함).
    1페이지에 1년 전 사업이 섞여 있고 2페이지에 이번 달 사업이 나오는 식이라,
    그 방식으로는 공람 중인 사업을 통째로 놓쳤다(환경영향평가 24건 중 16건만 수집됐다).

    그래서 지금은 '공람 중인 사업이 한 건도 없는 페이지'가 몇 쪽 이어질 때까지 계속 넘긴다.
    목록 조회는 값이 싸므로 넉넉히 뒤지는 편이 안전하다.
    """
    open_items = []
    seen = set()
    label = CATEGORIES[category_key]["label"]
    empty_streak = 0

    for page in range(1, max_pages + 1):
        html_text = fetch_list_page(category_key, page)
        items = parse_list_html(html_text, category_key)
        if not items:
            break   # 더 볼 페이지가 없다

        found_here = 0
        for it in items:
            if not it["period_start"] or not it["period_end"]:
                continue
            start = datetime.date.fromisoformat(it["period_start"])
            end = datetime.date.fromisoformat(it["period_end"])
            # 공람이 끝났어도 의견 제출 기한이 남았을 수 있으므로 여유를 두고 담는다.
            if not (start <= today <= end + datetime.timedelta(days=OPINION_GRACE_DAYS)):
                continue
            key = (it["biz_cd"], it["biz_seq"])
            if key in seen:      # 같은 사업이 여러 페이지에 나오는 경우 대비
                continue
            seen.add(key)
            open_items.append(it)
            found_here += 1

        empty_streak = 0 if found_here else empty_streak + 1
        log(f"  [{label}] {page}페이지 ({len(items)}건 중 공람중 {found_here}건, "
            f"누적 {len(open_items)}건)")

        if empty_streak >= EMPTY_PAGE_STREAK:
            log(f"  [{label}] 공람 중인 사업이 없는 페이지가 {EMPTY_PAGE_STREAK}쪽 이어져 멈춥니다.")
            break
        time.sleep(delay)

    return open_items


# ============================================================
# 1-2) 협의 진행 중인 사업 수 — EIASS "사업조회" 화면의 검색 결과 건수
#
#  주민 공람과는 다른 목록이다. 공람은 "지금 의견을 낼 수 있는 사업"이고,
#  이쪽은 "환경청과 협의가 진행 중인 사업 전체"라 훨씬 많다.
#  사업 하나하나를 받지 않고 **건수만** 가져오므로 요청 3번, 비용 0원이다.
#
#  화면의 검색 조건을 그대로 흉내낸다.
#   · 진행현황 = 진행중            → completeFl "진행"
#   · 진행구분 = 초안·평가서·재협의·약식평가·변경협의 모두 체크
#                                   → businessExquery 아래 EXQUERY 문자열
#  (2026-08-02 실측: 전략 115 / 환경 121 / 소규모 391 — 화면 숫자와 일치)
# ============================================================
REVIEW_EXQUERY_PER = "<CHOAN:contains:Y> | (<BONAN:contains:Y> <BIZ_TYPE_CD:contains:0|A|B|C>)"
REVIEW_EXQUERY_EIA = ("<CHOAN:contains:Y> | (<BONAN:contains:Y> <BIZ_TYPE_CD:contains:A|B|C>)"
                      " | <BYUN:contains:Y>")

REVIEW_CATEGORIES = [
    # (저장할 키, 화면에 쓰는 이름, alias, perssGubn, 진행구분 조건)
    ("strat", "전략환경영향평가", 2, "S", REVIEW_EXQUERY_PER),
    ("main",  "환경영향평가",     1, "E", REVIEW_EXQUERY_EIA),
    ("small", "소규모환경영향평가", 2, "M", REVIEW_EXQUERY_PER),
]


def _url_string(params):
    """검색엔진이 받는 urlString('&키=값&키=값' 형태)을 만든다."""
    return "".join(f"&{k}={quote(str(v), safe='')}" for k, v in params.items())


def fetch_review_count(alias, perss_gubn, exquery):
    """협의 진행 중인 사업 건수 하나를 가져온다. 실패하면 None."""
    search_params = {
        "alias": alias,
        "completeFl": "진행",     # 진행현황 = 진행중
        "openFl": "",
        "businessExquery": exquery,
        "whrChFl": "", "aSYear": "", "aEYear": "", "rSYear": "", "rEYear": "",
        "orgnCd": "", "nrvFl": "", "bizGubunCd": "",
        "perssGubn": perss_gubn,
    }
    view_char = "Eia" if alias == 1 else "Per"
    r = SESSION.post(f"{BASE}/searchApi/search.do", data={
        "query": "",
        "collection": "business",
        "urlString": _url_string(search_params),
        "viewName": f"/eiass/user/biz/base/info/searchList{view_char}_searchApi",
        "currentPage": 1,
        "sort": "DATE/DESC",
        "listCount": 10,
    }, headers=HEADERS, verify=VERIFY_SSL, timeout=25)
    r.raise_for_status()
    m = re.search(r'detailPage">\s*검색결과\s*:\s*([\d,]+)\s*건', r.text)
    return int(m.group(1).replace(",", "")) if m else None


def fetch_review_counts(delay):
    """세 가지 평가의 '협의 진행 중' 건수를 모은다.
    한 종류가 실패해도 나머지는 그대로 담는다(화면에서 없는 값은 표시하지 않는다)."""
    counts = {}
    for key, label, alias, perss, exquery in REVIEW_CATEGORIES:
        try:
            n = fetch_review_count(alias, perss, exquery)
        except Exception as e:
            log(f"  [협의 진행 중 조회 실패:{label}] {e}")
            n = None
        if n is None:
            log(f"  [협의 진행 중] {label}: 건수를 읽지 못했습니다")
        else:
            counts[key] = n
            log(f"  [협의 진행 중] {label}: {n}건")
        time.sleep(delay)
    if counts:
        counts["total"] = sum(counts.values())
    return counts


# ============================================================
# 2) 상세 페이지 — 주소·협의기관·첨부파일 목록
# ============================================================
def fetch_detail_html(category_key, biz_cd, biz_seq, step_cd):
    cat = CATEGORIES[category_key]
    data = {"BIZ_CD": biz_cd, "BIZ_SEQ": biz_seq}
    if cat["needs_step_cd"] and step_cd:
        data["CCIL_STEP1_CD_CK"] = step_cd
    r = SESSION.post(f"{BASE}{cat['view_path']}", data=data,
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
    r = SESSION.get(url, params={"FILE_SEQ": file_seq, "SYSTEM_NAME": system_name},
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
            r = SESSION.get(VWORLD_DATA_URL, params={
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
                r = SESSION.get(url, params={
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
            # 항목 8개를 한글로 채우면 응답이 길다. 2000 으로 두면 긴 사업에서
            # JSON 이 중간에 잘려 통째로 버려진다(36건 중 5건이 그랬다). 넉넉히 준다.
            max_tokens=6000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text").strip()

        # 답이 길이 제한에 걸려 잘렸으면 JSON 이 깨진다. 왜 실패했는지 남긴다.
        if msg.stop_reason == "max_tokens":
            log(f"    [환경영향분석 잘림] {name} — 응답이 길이 제한에 걸렸습니다 "
                f"(출력 {msg.usage.output_tokens} 토큰). max_tokens 를 늘려야 합니다.")
            return None

        # 혹시 ```json 같은 감싸는 표시가 붙어 오면 떼어낸다.
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1:
            log(f"    [환경영향분석 형식 오류] {name} "
                f"(끝난 이유: {msg.stop_reason}, 출력 {msg.usage.output_tokens} 토큰)")
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
# 이미 받아 둔 결과 재사용 (증분 수집)
#
#  돈과 시간이 드는 것은 목록 조회가 아니라 그 다음 단계다.
#  사업 1건마다: 상세 페이지 + 요약문 PDF 내려받기 + AI 해석 1회.
#  매일 전건을 다시 돌리면 같은 사업의 AI 해석 비용을 매일 다시 낸다.
#
#  그래서 이미 있는 사업은 저장해 둔 결과를 그대로 쓰고, 새로 올라온 사업만 받는다.
#  공람이 끝난 사업은 마지막 필터에서 자동으로 빠지므로 따로 지울 필요가 없다.
# ============================================================
def load_existing(path):
    """지난번에 만든 projects.json 을 {사업id: 사업} 으로 읽어 온다.
    파일이 없거나 깨져 있으면 빈 것으로 보고 전부 새로 받는다."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return {}
    rows = data.get("projects")
    if not isinstance(rows, list):
        return {}
    return {p["id"]: p for p in rows if isinstance(p, dict) and p.get("id")}


# 재사용하는 사업에서도 매번 다시 받아 덮어쓰는 항목.
# 상세 페이지 조회 한 번(0.2초, 무료)이면 되고, 돈이 드는 PDF·AI 는 건드리지 않는다.
# 이 값들은 공람 도중에 실제로 바뀐다 — 특히 설명회 일시가 "미정"에서 날짜로 정해진다.
REFRESHABLE = ["viewPlace", "briefPlace", "briefWhen", "opinionPeriod", "deptName", "deptTel"]


def needs_detail_refresh(cached):
    """상세를 다시 받아야 하는가.

    설명회 안내가 화면의 중심이 된 뒤로, 한 번 "미정"으로 받아 둔 사업이
    영영 "미정"으로 남는 문제가 생겼다. 아직 정해지지 않은 값이 있으면 다시 받는다.
    """
    for key in REFRESHABLE:
        v = (cached.get(key) or "").strip()
        if not v or v in ("미정", "-"):
            return True
    return False


def refresh_cached(cached, item, vworld_key, skip_geocode, category_key, delay):
    """재사용하는 사업에서 '싸게 고칠 수 있는 것'만 손본다.

    · 공람 기간: 목록에 나온 최신 값으로 갱신한다 (기간이 연장되는 경우가 있다).
    · 설명회·공람 장소·의견 받는 곳: 아직 안 정해진 값이 있으면 상세를 다시 받는다.
    · 좌표: 지난번에 못 찾았으면 다시 시도한다 (지오코딩은 돈이 들지 않는다).
    · AI 해석: 다시 하지 않는다. 한 번 실패한 요약문은 내일도 실패할 가능성이 크고,
      매일 다시 부르면 그만큼 비용이 계속 나간다. 전부 다시 받으려면 --full 을 쓴다.
    """
    if item.get("period_start"):
        cached["periodStart"] = item["period_start"]
        cached["periodEnd"] = item["period_end"]

    if needs_detail_refresh(cached):
        try:
            html = fetch_detail_html(category_key, item["biz_cd"], item["biz_seq"], item["step_cd"])
            detail = parse_detail_html(html)
            changed = [k for k in REFRESHABLE if detail.get(k) and detail[k] != cached.get(k)]
            for k in REFRESHABLE:
                if detail.get(k):
                    cached[k] = detail[k]
            if changed:
                log(f"    (재사용) 새로 정해진 값을 덮어썼습니다: {', '.join(changed)}")
            time.sleep(delay)
        except Exception as e:
            log(f"    [상세 재조회 실패 — 지난 값을 그대로 씁니다] {e}")

    if cached.get("lat") is None and cached.get("address") and not skip_geocode:
        lat, lon = geocode_address(cached["address"], vworld_key)
        if lat is not None:
            cached["lat"], cached["lon"] = lat, lon
            log("    (재사용) 지난번에 못 찾은 좌표를 채웠습니다")
    return cached


# ============================================================
# 전체 흐름
# ============================================================
def build(args):
    today = datetime.date.today()
    # .env 나 Secret 에 붙여넣을 때 앞뒤 공백·줄바꿈이 섞이는 일이 흔하다.
    # 공백이 하나만 붙어도 VWorld 가 INVALID_KEY 로 거부하므로 반드시 걷어낸다.
    vworld_key = os.environ.get("VWORLD_KEY", "").strip()
    vworld_domain = os.environ.get("VWORLD_DOMAIN", "http://localhost:8000").strip()
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()

    if not args.skip_geocode and not vworld_key:
        log("[안내] VWORLD_KEY 환경변수가 없어서 위치 좌표(위경도)는 비워둡니다.")
    if not args.skip_summary and not anthropic_key:
        log("[안내] ANTHROPIC_API_KEY 환경변수가 없어서 쉬운말 요약은 비워둡니다.")

    # 이미 받아 둔 사업은 다시 받지 않는다. --full 을 주면 전부 새로 받는다.
    existing = {} if args.full else load_existing(OUT_PATH)
    if existing:
        log(f"[안내] 지난 결과 {len(existing)}건을 읽었습니다. 여기 있는 사업은 다시 받지 않습니다.")
    elif not args.full:
        log("[안내] 지난 결과가 없어 전부 새로 받습니다.")

    all_projects = []
    reused_count = 0
    new_count = 0

    for category_key, cat in CATEGORIES.items():
        label = cat["label"]
        log(f"[{label}] 공람 중인 사업 목록 수집 시작")
        open_items = fetch_open_items(category_key, today, args.max_pages, args.delay)
        if args.limit:
            open_items = open_items[: args.limit]
        log(f"[{label}] 공람 중 {len(open_items)}건 확인")

        for it in open_items:
            project_id = f"{it['biz_cd']}-{it['biz_seq']}"

            cached = existing.get(project_id)

            # --retry-analysis: AI 해석이 비어 있는 사업만 골라 다시 받는다.
            # (응답이 잘리거나 형식이 깨져 실패했던 것들. 전체를 다시 받을 필요는 없다)
            if cached and args.retry_analysis and not cached.get("analysis"):
                log(f"  ! {it['name']} (해석이 비어 있어 다시 받습니다)")
                cached = None

            if cached:
                log(f"  = {it['name']} (이미 받아 둠)")
                all_projects.append(
                    refresh_cached(cached, it, vworld_key, args.skip_geocode,
                                   category_key, args.delay))
                reused_count += 1
                continue

            log(f"  + {it['name']} (새 사업)")
            new_count += 1
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
                "id": project_id,
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

    # 의견제출 마감일을 읽어 담아 둔다("2026.07.30 ~ 2026.09.23" 형식).
    # 화면은 이 날짜를 기준으로 사업을 보여줄지 판단한다.
    for p in all_projects:
        p["opinionEnd"] = parse_opinion_end(p.get("opinionPeriod"))

    # 마지막으로 한 번 더 걸러낸다. 수집이 자정을 넘겨 오래 돌면
    # 시작할 때는 기한이 남아 있었지만 저장 시점엔 지난 사업이 섞일 수 있다.
    #
    # **기준은 공람 종료일이 아니라 의견제출 마감일이다.**
    # 환경영향평가법 시행령 제38조에 따라 공람이 끝난 뒤 7일 이내까지 의견을 낼 수 있어서,
    # 공람 종료일로 끊으면 아직 의견을 낼 수 있는 사업이 파일에서 빠져 화면에 안 뜬다.
    end_day = datetime.date.today()

    def still_open(p):
        if not p["periodStart"] or not p["periodEnd"]:
            return False
        start = datetime.date.fromisoformat(p["periodStart"])
        deadline = datetime.date.fromisoformat(p["opinionEnd"] or p["periodEnd"])
        # 의견제출 마감이 공람 종료보다 앞서 적혀 있으면 늦은 쪽을 쓴다(표기 오류 대비)
        deadline = max(deadline, datetime.date.fromisoformat(p["periodEnd"]))
        return start <= end_day <= deadline

    kept = [p for p in all_projects if still_open(p)]
    grace = sum(1 for p in kept
                if datetime.date.fromisoformat(p["periodEnd"]) < end_day)
    if grace:
        log(f"[안내] 공람은 끝났지만 의견 제출 기한이 남은 사업 {grace}건을 함께 담았습니다.")
    dropped = len(all_projects) - len(kept)
    if dropped:
        log(f"[안내] 공람 기간이 끝난 {dropped}건은 저장하지 않았습니다.")

    # 지난 결과에는 있었지만 이번 목록에 없는 사업 = 공람이 끝나 EIASS 목록에서 빠진 것.
    gone = len(existing) - reused_count
    if gone > 0:
        log(f"[안내] 지난 결과의 {gone}건은 EIASS 목록에서 사라져(공람 종료) 빼냈습니다.")

    # 협의 진행 중인 사업 수 (건수만 — 요청 3번, 비용 0원)
    stats = {}
    if not args.skip_stats:
        log("[협의 진행 중] 사업조회 건수 확인")
        stats = fetch_review_counts(args.delay)
        # 못 읽었으면 지난 파일의 값을 그대로 쓴다 (숫자가 갑자기 사라지지 않도록)
        if not stats and existing:
            try:
                with open(OUT_PATH, encoding="utf-8") as f:
                    stats = (json.load(f).get("stats") or {}).get("underReview", {})
                if stats:
                    log("  [협의 진행 중] 이번엔 못 읽어서 지난 값을 그대로 씁니다")
            except (FileNotFoundError, ValueError, OSError):
                stats = {}

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": end_day.isoformat(),
            "note": ("이 파일은 tools/build_data.py가 EIASS 공개 자료를 바탕으로 자동 생성합니다. "
                     "생성 시점에 초안 공람 기간 안에 있던 사업만 담겨 있습니다."),
            "stats": {
                # EIASS 사업조회에서 '진행현황=진행중'으로 세어 온 건수.
                # 공람 중인 사업(projects)과는 다른 모수다.
                "underReview": stats,
            },
            "projects": kept,
        }, f, ensure_ascii=False, indent=2)

    log(f"완료: {OUT_PATH} 에 {len(kept)}건 저장 (모두 공람 기간 중)")
    log(f"      새로 받은 사업 {new_count}건 · 지난 결과 재사용 {reused_count}건")


def main():
    parser = argparse.ArgumentParser(description="EIASS 초안 공람 데이터 수집")
    parser.add_argument("--limit", type=int, default=None, help="유형별 최대 수집 건수 (테스트용)")
    parser.add_argument("--max-pages", type=int, default=60, help="목록 페이지 최대 조회 수")
    parser.add_argument("--delay", type=float, default=0.4, help="요청 사이 대기 시간(초)")
    parser.add_argument("--skip-geocode", action="store_true", help="vworld 지오코딩 건너뛰기")
    parser.add_argument("--skip-summary", action="store_true", help="요약문 PDF 다운로드/LLM 요약 건너뛰기")
    parser.add_argument("--skip-route", action="store_true", help="하천 노선 도형 조회 건너뛰기")
    parser.add_argument("--skip-stats", action="store_true",
                        help="협의 진행 중 사업 건수 조회 건너뛰기")
    parser.add_argument("--full", action="store_true",
                        help="이미 받아 둔 결과를 무시하고 전부 다시 받는다 "
                             "(EIA_FIELDS 를 바꿨을 때는 반드시 이걸로 돌려야 한다)")
    parser.add_argument("--retry-analysis", action="store_true",
                        help="AI 해석이 비어 있는 사업만 골라 다시 받는다 "
                             "(전체를 다시 받지 않으므로 비용이 적다)")
    args = parser.parse_args()

    try:
        build(args)
    except requests.exceptions.RequestException as e:
        # 인터넷 문제는 파이썬 오류 메시지가 길고 알아보기 어렵다.
        # 무엇이 안 됐고 다음에 뭘 봐야 하는지 사람 말로 알려 준다.
        log("")
        log("=" * 62)
        log(f"[중단] 인터넷 연결 문제로 멈췄습니다 — {type(e).__name__}")
        log(f"       {e}")
        log("")
        log("  EIASS 또는 VWorld 에 닿지 못했습니다.")
        log("  GitHub Actions 에서 났다면 해외 IP 차단일 수 있습니다.")
        log("  docs/SETUP.md 의 '6단계 — EIASS가 막혔다면' 을 보세요.")
        log("=" * 62)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
