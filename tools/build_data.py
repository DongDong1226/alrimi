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

# VWorld 는 두 가지를 쓴다 — 주소→좌표(지오코더)와 하천 도형(데이터).
# 둘 다 같은 서버라, 중계를 붙일 때는 이 주소 하나만 보면 된다.
VWORLD_HOST = "https://api.vworld.kr"
VWORLD_ADDR_URL = f"{VWORLD_HOST}/req/address"
VWORLD_DATA_URL = f"{VWORLD_HOST}/req/data"
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


# ── EIASS 중계 (선택) ────────────────────────────────────────────────
# GitHub 러너에서는 EIASS 접속이 6번 중 1번만 됐다. 서울에서는 13번 중 13번 됐다.
# 그래서 **EIASS 로 가는 요청만** 서울에 둔 중계(Supabase Edge Function)에 대신 시킨다.
# 중계 함수 원본은 tools/relay/index.ts 에 있다.
#
# ★ EIASS_RELAY_URL 이 없으면 아무 일도 일어나지 않는다 — 지금까지처럼 직접 간다.
#   한국 PC(run_daily.bat)는 직접 가는 게 빠르고 확실하므로 그대로 두면 된다.
#   VWorld·Anthropic 은 중계를 타지 않는다 (주소가 EIASS 일 때만 갈아끼우므로).
RELAY_URL = (os.environ.get("EIASS_RELAY_URL") or "").strip()
RELAY_KEY = (os.environ.get("EIASS_RELAY_KEY") or "").strip()
# 중계는 '부르는 사람과 가까운 곳'에서 도는 게 기본이라, 서울을 명시하지 않으면
# GitHub(미국)이 부를 때 미국에서 돌아 버려서 아무 의미가 없다.
RELAY_REGION = os.environ.get("EIASS_RELAY_REGION", "ap-northeast-2").strip()


class _RelayAdapter:
    """EIASS 요청을 서울 중계에 대신 시키는 통로.

    requests 는 주소 앞부분으로 통로를 나눠 쓸 수 있어서, 이것을 EIASS 주소에만
    붙이면 **부르는 코드는 한 줄도 바꾸지 않아도 된다.**
    돌려주는 것도 진짜 requests 응답 객체라 .text / .content / .raise_for_status()
    가 그대로 동작한다.
    """

    def __init__(self, relay_url, relay_key):
        self.relay_url = relay_url
        self.relay_key = relay_key
        # 중계까지 가는 길에도 재시도를 붙인다 (Supabase 가 잠깐 느릴 수 있다)
        self.session = _make_session()

    # requests 가 통로에 요구하는 것들
    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        body = request.body
        if isinstance(body, str):
            body = body.encode("utf-8")

        headers = {
            "x-relay-key": self.relay_key,
            "x-relay-url": request.url,
            "x-relay-method": request.method,
            "x-relay-ua": request.headers.get("User-Agent", ""),
            "x-region": RELAY_REGION,          # ★ 이게 없으면 미국에서 돈다
        }
        if body:
            headers["Content-Type"] = request.headers.get(
                "Content-Type", "application/x-www-form-urlencoded")
        r = self.session.post(self.relay_url, data=body, headers=headers,
                              timeout=timeout or 120)

        # 중계 자체가 거절한 경우(키·주소·EIASS 실패)는 원인을 그대로 알려 준다.
        # 헤더에는 짧은 아스키 코드만 오고 **한글 까닭은 본문에** 있다
        # (HTTP 헤더에는 한글을 넣을 수 없다 — 중계 쪽에 같은 설명이 있다).
        if "x-upstream-status" not in r.headers:
            code = r.headers.get("x-relay-error", "")
            why = (r.text or "").strip()[:300] or code or "(까닭 없음)"
            raise requests.exceptions.RequestException(
                f"[중계 실패 {r.status_code}{'/' + code if code else ''}] {why}")

        resp = requests.Response()
        try:
            resp.status_code = int(r.headers["x-upstream-status"])
        except ValueError:
            raise requests.exceptions.RequestException(
                f"[중계 응답 이상] x-upstream-status 가 숫자가 아닙니다: "
                f"{r.headers['x-upstream-status']!r}")
        resp._content = r.content
        resp.url = request.url
        resp.request = request
        resp.reason = ""
        # 글자 인코딩은 이 헤더로 정해진다. EIASS 는 charset=UTF-8 을 명시하므로
        # 그대로 넘겨주면 한글이 안 깨진다 (직접 접속했을 때와 똑같이 동작한다).
        ctype = r.headers.get("x-upstream-content-type", "")
        resp.headers = requests.structures.CaseInsensitiveDict()
        if ctype:
            resp.headers["Content-Type"] = ctype
        # 쿠키는 주고받지 않는다.
        #   EIASS 는 목록·상세·첨부 모두 로그인이나 세션 없이 그대로 응답한다(확인함).
        #   requests 의 쿠키 저장소는 응답 헤더가 아니라 raw 응답을 보기 때문에,
        #   여기서 Set-Cookie 를 넣어 봐야 **실제로는 아무 일도 일어나지 않는다.**
        #   그래서 '되는 것처럼 보이는 코드'를 두지 않고 아예 뺐다.
        #   나중에 EIASS 가 세션을 요구하게 되면 이 통로부터 손봐야 한다.
        return resp

    def close(self):
        self.session.close()



# 실제로 통로를 갈아끼우는 것은 log() 가 만들어진 뒤에 한다 (아래 setup_relay).

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


# ============================================================
# 날짜 — **반드시 한국 시간으로 판단한다** (2026-09-04)
#
# ★ 왜 이게 중요한가
#   GitHub 러너는 **UTC** 로 돈다. 그래서 date.today() 는 한국보다 하루 늦다.
#   공람이 끝난 사업의 AI 해석을 지우려고 **한국 0시 10분**(= UTC 15:10) 수집을
#   따로 걸어 두었는데, 그 시각의 UTC 날짜는 아직 **어제**라 view_closed() 가
#   False 를 내고 **해석이 안 지워졌다.**
#
#   실측(공람 종료 2026-09-01 사업):
#     한국 09-02 00:10 (UTC 09-01 15:10) → 안 지움
#     한국 09-02 07:00 (UTC 09-01 22:00) → 안 지움
#     한국 09-02 13:00 (UTC 09-02 04:00) → 비로소 지움
#   → 한국시간 **00:00~13:00 약 13시간** 동안 data/projects.json 에 해석이 남았다.
#     그 파일은 주소만 알면 누구나 내려받는다. 화면 잠금과는 다른 문제다.
#
#   ★ 새로 '오늘'을 구하는 코드를 쓸 때는 date.today() 를 쓰지 말고 반드시 이것을 쓸 것.
# ============================================================
KST = datetime.timezone(datetime.timedelta(hours=9))


def today_kst():
    """한국 날짜. 러너가 어느 시간대에 있든 같은 값을 준다."""
    return datetime.datetime.now(KST).date()


def log(msg):
    """윈도우 명령창은 한글 코드페이지(cp949)를 쓰는 경우가 있어서,
    표시할 수 없는 문자가 섞이면 프로그램이 죽는다. 그런 문자는 물음표로 바꿔서라도 계속 진행한다."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


def setup_relay():
    """한국 서버로 가는 요청을 서울 중계로 돌린다. 주소·키가 없으면 아무 일도 하지 않는다.

    중계를 태우는 곳:
      · EIASS      — 목록·상세·요약문 PDF
      · VWorld     — 주소→좌표(지오코더), 하천 도형
                     2026-08-15 추가. GitHub 러너에서 VWorld 가 **아예 답을 하지 않아서**
                     (502 / 연결 끊김. 틀린 키도 똑같이 끊겼으니 키 문제가 아니다)
                     새로 들어온 사업 9건의 좌표가 전부 비었다. EIASS 와 같은 모양이다.
    중계를 안 타는 곳:
      · Anthropic  — 미국에서 잘 붙는다. 굳이 서울을 거칠 이유가 없고,
                     **API 키가 중계를 지나가게 하지 않는 편이 낫다.**

    log() 가 만들어진 뒤에 불러야 해서 여기에 둔다.
    """
    if RELAY_URL and RELAY_KEY:
        adapter = _RelayAdapter(RELAY_URL, RELAY_KEY)
        # 주소 앞부분이 더 길게 맞는 통로가 이긴다 → 아래 두 곳만 중계, 나머지는 그대로.
        SESSION.mount(BASE + "/", adapter)
        SESSION.mount(VWORLD_HOST + "/", adapter)
        log(f"[통로] EIASS·VWorld 는 서울 중계를 거칩니다 ({RELAY_REGION})")
    elif RELAY_URL or RELAY_KEY:
        log("[통로] EIASS_RELAY_URL 과 EIASS_RELAY_KEY 는 **둘 다** 있어야 합니다 — 직접 접속으로 갑니다")
    else:
        log("[통로] EIASS·VWorld 직접 접속")


setup_relay()


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


def list_page_has_table(html_text):
    """목록 표(tbl01)가 그 페이지에 있었나.

    ★ '표는 있는데 줄이 0' 과 '표 자체가 없다' 는 전혀 다른 일이다 (2026-09-05).
      앞은 **목록 끝**이고, 뒤는 **페이지를 못 읽은 것**이다 —
      EIASS 가 오류·점검 페이지를 주었거나, 화면 구조가 바뀌었거나,
      중계가 엉뚱한 것을 돌려준 때다.
      까닭을 알려 줄 때만 쓴다. 멈출지 말지는 아래 fetch_open_items 가 정한다.
    """
    try:
        tree = lhtml.fromstring(html_text)
    except Exception:
        return False        # HTML 로 읽히지도 않는다 = 확실히 못 읽은 것
    return bool(tree.xpath("//table[contains(@class,'tbl01')]"))


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
            # ★ 1페이지가 비었다면 '목록 끝' 이 아니라 **못 읽은 것**이다 (2026-09-05).
            #   EIASS 목록에 사업이 한 건도 없는 일은 없다. 그런데 예전에는 이 둘을
            #   구분하지 않고 그냥 break 해서, **목록을 통째로 못 읽어도
            #   '공람 0건' 으로 조용히 끝났다** — 수집은 '성공' 으로 마무리된다.
            #   여기서 예외를 던지면 부르는 쪽이 **아무것도 저장하지 않고 멈춘다**
            #   (그 안전장치는 이미 있었는데 이 길로는 닿지 않았다).
            if page == 1:
                why = ("사업 표(tbl01)가 아예 없습니다 — 오류·점검 페이지이거나 "
                       "화면 구조가 바뀐 것으로 보입니다"
                       if not list_page_has_table(html_text)
                       else "표는 있는데 사업 줄이 하나도 없습니다")
                raise RuntimeError(
                    f"{label} 목록 1페이지를 읽지 못했습니다 — {why} "
                    f"(받은 글자 {len(html_text)}자)")
            log(f"  [{label}] {page}페이지에 사업이 없어 멈춥니다.")
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


# '계획대상하천'처럼 앞에 말이 붙은 것도 하천 이름이 아니다.
# **접미사로 거를 때는 아주 좁게 잡는다** — '소하천'으로 끝나는 진짜 이름이 실제로 있다
# (주평소하천·국서소하천·용소소하천·주계소하천). 넓게 거르면 멀쩡한 하천이 사라진다.
RIVER_NAME_GENERIC_SUFFIX = ("대상하천",)


def extract_river_names(text):
    names = set(re.findall(r"([가-힣]{2,6}천)\b", text or ""))
    def generic(n):
        return n in RIVER_NAME_BLOCKLIST or n.endswith(RIVER_NAME_GENERIC_SUFFIX)
    return sorted(n for n in names if not generic(n))


# 하천을 따라가는 사업인지 판단한다.
# 도로·철도 사업 요약문에도 '지나가는 하천' 이름이 나오므로, 사업 자체가
# 하천 사업일 때만 하천 도형을 노선으로 쓴다.
RIVER_BIZ_HINTS = ("하천", "河川", "수계", "河")

# ★ 사업명 자체가 '하천을 계획하는 사업'이라고 못 박은 경우 (2026-08-25 추가).
#   여기 걸리면 **사업구분이 무엇이든** 하천 사업으로 본다.
#
#   왜 필요했나 — `천미천 외 1개소 하천기본계획(변경)` 의 EIASS 사업구분이
#   `개발사업(전체) / 기반시설 (축제 및 보축 등)` 이었다. '하천'이 한 글자도 없다.
#   예전 규칙은 **사업구분과 근거법령이 둘 다 비었을 때만** 사업명을 봤으므로,
#   뭉뚱그린 사업구분이 붙어 있으면 사업명에 '하천기본계획'이 있어도 그냥 넘어갔다.
#   그래서 노선을 **아예 찾지 않았다** (VWorld 에는 천미천 도형이 사업지 2.1km 앞에 있었다).
#
#   ★ 여기 넣는 말은 **'하천 자체를 계획하는 사업'만** 가리켜야 한다.
#     `하천 횡단교량` 처럼 **지나가기만 하는** 사업이 걸리면 엉뚱한 하천을 노선으로 그리게 된다.
#     그래서 '하천'만으로는 안 되고 계획 이름까지 붙은 말만 넣는다.
#     (실측: 지금 자료 42건 중 이 규칙에 걸리는 것은 하천 사업 10건뿐이고 도로·철도는 0건)
RIVER_PLAN_HINTS = (
    "하천기본계획", "하천정비기본계획", "하천정비종합계획", "소하천정비",
    "하천정비계획", "하천환경정비", "하천재해예방",
)


def is_river_project(name, biz_type, law_basis):
    # ① 사업명이 '하천 계획'이라고 못 박았으면 사업구분을 보지 않는다.
    if any(h in (name or "") for h in RIVER_PLAN_HINTS):
        return True
    # ② 사업구분·근거법령에 '하천'이 있으면 확실하다. (예: "하천이용 / 하천기본계획", "「하천법」")
    if biz_type and "하천" in biz_type:
        return True
    if law_basis and "하천" in law_basis:
        return True
    # ③ 사업구분 정보가 없을 때만 사업명을 느슨하게 본다.
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
    """글자를 뽑아 (글자, 읽은 쪽수) 로 돌려준다.
    쪽수를 함께 주는 이유는 '스캔본이라 못 읽었다'를 가리기 위해서다 (아래 참고)."""
    import pdfplumber
    parts = []
    read = 0
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for i, page in enumerate(pdf.pages):
            if i >= max_pages:
                break
            parts.append(page.extract_text() or "")
            read += 1
    return "\n".join(parts).strip(), read


# 스캔본(글자가 아니라 사진으로 만들어진 문서)을 가려내는 기준 — **쪽당 글자 수**.
#
# ■ 왜 필요한가
#   요약문을 못 읽으면 AI 가 8개 항목을 전부 비운다. 그 자체는 규칙을 지킨 것이지만,
#   화면에 "요약문에 내용이 없습니다"로 나가면 **읽어 보고 없다고 한 것처럼** 들린다.
#   실제로는 **읽지 못한 것**이라 사실과 다르다. 그래서 둘을 갈라 둔다.
#
# ■ 기준값은 실측으로 정했다 (2026-08-16, 실제 요약문 4건)
#     현경 수양저수지(스캔본)  10쪽 1.85MB 에서  112자 → 쪽당   11자
#                              (뽑힌 것이 쪽 번호 '- 3 -' 와 글머리표 '◾' 뿐이었다)
#     정상 문서 3건                                    → 쪽당 744 · 828 · 882자
#   사이가 **70배** 벌어져 있어 기준을 어디에 두든 갈린다. 넉넉히 100자로 잡았다
#   (스캔본의 9배, 가장 적은 정상 문서의 1/7).
#
# ■ ★ 애매하면 '읽었다'로 본다.
#   멀쩡한 문서를 "못 읽었다"고 말하는 쪽이 더 나쁜 실수다. 기준을 올리지 말 것.
MIN_CHARS_PER_PAGE = 100


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
    """주소를 위경도로 바꾼다. 못 찾으면 (None, None).

    ★ 못 찾은 까닭을 반드시 남긴다.
      예전에는 VWorld 가 '주소를 못 찾았다'고 답한 것과 '키를 거부한 것'을 구분하지 않고
      똑같이 조용히 (None, None) 을 돌려줬다. 그래서 2026-08-14~15 자동 수집에서
      **새 사업 9건의 좌표가 전부 비었는데도 로그에 아무것도 안 남았다.**
      수집은 '성공'으로 끝나고 지도에서만 사업이 사라지는, 가장 알아채기 어려운 실패였다.
    """
    if not vworld_key or not address:
        return None, None
    url = VWORLD_ADDR_URL
    last_status, last_msg = None, None
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
                res = (r.json() or {}).get("response", {}) or {}
                point = (res.get("result") or {}).get("point")
                if point:
                    return float(point["y"]), float(point["x"])
                last_status = res.get("status")
                last_msg = ((res.get("error") or {}).get("text")
                            or (res.get("error") or {}).get("level"))
            except Exception as e:
                log(f"    [지오코딩 오류:{addr_type}:{candidate}] {e}")
    # NOT_FOUND 는 '그 주소가 없다'는 정상 답이지만, ERROR 는 키·권한·차단 문제다.
    if last_status and last_status != "NOT_FOUND":
        log(f"    [지오코딩 거부] status={last_status} {last_msg or ''} — 주소: {address[:40]}")
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
            # 2026-08-06: 소넷으로 바꿨다가 **비용 때문에 하이쿠로 되돌렸다.**
            # 소넷은 품질은 좋았지만(시험에서 8개 항목 중 없는 4개를 정확히 null 처리)
            # 값이 3배이고, 이날 수집이 계속 실패해 재시도가 돌면서 비용이 더 나갈 위험이 있었다.
            #
            # ★ 다시 소넷으로 바꿀 거라면 **max_tokens 를 반드시 같이 올려야 한다.**
            #   소넷은 '생각하기'가 기본으로 켜져 있고 max_tokens 가 생각한 양 + 답변을
            #   **합쳐서** 제한하기 때문에, 아래 6000 을 그대로 두면 JSON 이 중간에 잘린다.
            #   바꿀 때: model="claude-sonnet-5", max_tokens=16000
            model="claude-haiku-4-5",
            # 항목 8개를 한글로 채우면 응답이 길다. 2000 으로 두면 긴 사업에서
            # JSON 이 중간에 잘려 통째로 버려진다(36건 중 5건이 그랬다). 넉넉히 준다.
            max_tokens=6000,
            messages=[{"role": "user", "content": prompt}],
        )
        # 응답에는 '생각한 내용' 덩어리와 '답변' 덩어리가 섞여 온다.
        # 답변(text)만 골라내야 JSON 이 깨지지 않는다. (이 줄이 그 역할을 한다)
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


def stamp_first_seen(projects, day, path):
    """'우리가 그 사업을 처음 본 날'(firstSeen)을 적는다.

    ■ 왜 필요한가
      화면의 '새로 올라온 사업'은 원래 **공람 시작일**로 판정했다. 그런데 그 날짜는
      EIASS 쪽 사정이지 우리 화면에 나타난 날이 아니다. 둘이 어긋나면 알림이 통째로 샌다:
        · EIASS 가 공람 시작 뒤에 목록에 늦게 올리는 경우
          (실측: 현경 수양저수지 사업 — 공람 8/3 시작, 우리가 처음 본 날 8/14)
        · **우리 수집이 하루라도 실패한 경우** (8/7~8/14 에 7일 구멍이 있었다)
      늦게 나타난 사업일수록 남은 기간이 짧다. 지금 규칙은 **가장 급한 사업을 가장 조용히**
      들여보낸다. 그래서 우리가 처음 본 날을 따로 적어 둔다.

    ■ 규칙은 하나뿐이다 — **한 번 적힌 날짜는 절대 덮지 않는다.**
      매번 오늘로 덮으면 모든 사업이 날마다 '새것'이 되어 표시가 뜻을 잃는다.

    ■ 저장 직전 한 곳에서만 찍는 이유
      증분 수집과 --full 이 서로 다른 길을 타는데, --full 은 캐시(existing)를 비운다.
      거기에 기대면 --full 한 번에 firstSeen 이 전부 날아가 **다시 온 주민에게 전부 NEW** 로
      보인다. 그래서 existing 이 아니라 **파일을 따로 다시 읽는다.**
    """
    prev = load_existing(path)          # ★ existing 이 아니라 파일에서 직접 (--full 이어도 안전)
    today = day.isoformat()
    fresh = 0
    for p in projects:
        old = prev.get(p.get("id"))
        if old and old.get("firstSeen"):
            p["firstSeen"] = old["firstSeen"]
        elif old:
            # 지난 파일에 있던 사업인데 firstSeen 이 없다 = 이 기능을 넣기 전부터 있던 사업.
            # 오늘로 적으면 **이미 다녀간 주민에게 41건이 전부 새 사업으로 보인다.**
            # 그래서 예전 화면이 쓰던 값(공람 시작일)을 그대로 물려준다 — 동작이 안 바뀐다.
            p["firstSeen"] = p.get("periodStart") or today
        else:
            p["firstSeen"] = today      # 우리가 오늘 처음 본 사업
            fresh += 1
    return fresh


# 재사용하는 사업에서도 매번 다시 받아 덮어쓰는 항목.
# 상세 페이지 조회 한 번(0.2초, 무료)이면 되고, 돈이 드는 PDF·AI 는 건드리지 않는다.
# 이 값들은 공람 도중에 실제로 바뀐다 — 특히 설명회 일시가 "미정"에서 날짜로 정해진다.
REFRESHABLE = ["viewPlace", "briefPlace", "briefWhen", "opinionPeriod", "deptName", "deptTel"]


# ============================================================
# 지역별 캘린더 파일 (.ics) — 구독하면 새 사업이 저절로 들어온다
#
# ■ 왜 만드나
#   이 서비스는 알림을 보낼 수단이 없다. 웹 푸시는 서버가 필요하고
#   아이폰은 홈 화면 추가까지 해야 해서, 서버 0원·개인정보 0건이 깨진다.
#   대신 **지역별 캘린더 주소를 구독**하게 하면
#     · 폰 캘린더가 알아서 주기적으로 다시 받아 오고
#     · 그 지역에 새 사업이 뜨면 일정이 저절로 들어오고
#     · 알림도 폰 캘린더가 준다.
#   우리는 파일만 만들어 두면 된다. 정적 파일이라 GitHub Pages 에 그냥 올라간다.
#
# ■ 모든 지역 파일을 항상 만든다 (사업이 0건인 곳도)
#   구독해 둔 지역의 파일이 사라지면 캘린더 앱이 오류를 내거나 구독을 버린다.
#   빈 파일도 200바이트 남짓이라 부담이 없다.
#
# ■ 판정은 **주소 글자**로만 한다
#   화면(app.js)의 inHood() 는 노선이 경계를 지나는 것까지 보지만, 여기서는 그렇게 못 한다.
#   구독은 '대충 우리 동네'면 충분하고, 정확한 판정은 화면이 한다.
# ============================================================
CAL_DIR = os.path.join(os.path.dirname(OUT_PATH), "cal")


def ics_fold(line):
    """한 줄이 75바이트를 넘으면 접는다.

    한글은 한 글자가 3바이트라 사업명이 대부분 넘는데, 안 접으면
    까다로운 캘린더 앱이 **파일을 통째로 못 읽는다**.
    이어지는 줄은 맨 앞에 공백 한 칸을 넣고, 글자가 중간에 잘리지 않게 글자 단위로 센다.
    """
    if len(line.encode("utf-8")) <= 75:
        return [line]
    out, cur, size = [], "", 0
    for ch in line:
        n = len(ch.encode("utf-8"))
        if size + n > 75:
            out.append(cur)
            cur, size = " " + ch, 1 + n
        else:
            cur += ch
            size += n
    if cur:
        out.append(cur)
    return out


def ics_esc(s):
    s = "" if s is None else str(s)
    return (s.replace("\\", "\\\\").replace(";", "\\;")
             .replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n"))


def cal_deadline(p):
    """캘린더에 넣을 날짜 — 의견 제출 마감일. 없으면 공람 종료일."""
    return p.get("opinionEnd") or p.get("periodEnd")


def ics_body(p):
    parts = [
        f"사업: {p.get('name','')}",
        f"유형: {p.get('categoryLabel','')}",
        f"위치: {p.get('address','')}",
        f"기관: {p.get('org','')}",
        f"공람기간: {p.get('periodStart','')} ~ {p.get('periodEnd','')}",
    ]
    if p.get("opinionEnd"):
        parts.append(f"의견 제출 마감: {p['opinionEnd']}")
    parts += ["", "의견은 EIASS 에서 본인인증 후 제출합니다.", "https://www.eiass.go.kr/",
              "", "우리동네 개발사업 알리미"]
    return "\n".join(parts)


def build_ics(title, rows):
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "PRODID:-//우리동네 개발사업 알리미//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        f"X-WR-CALNAME:{ics_esc(title)}",
        "X-WR-CALDESC:공람 중인 개발사업의 의견 제출 마감일",
        # 캘린더 앱에 '반나절마다 다시 받아 가라'고 알려 준다 (수집이 하루 세 번이다)
        "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H",
    ]
    for p in rows:
        day = cal_deadline(p)
        if not day:
            continue
        try:
            end = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).strftime("%Y%m%d")
        except ValueError:
            continue
        # DTSTAMP 를 '오늘'로 하면 내용이 안 바뀌어도 파일이 매일 달라져
        # 272개 파일이 날마다 커밋된다. 사업의 공람 시작일로 고정한다.
        stamp = (p.get("periodStart") or day).replace("-", "")
        lines += [
            "BEGIN:VEVENT",
            f"UID:{p.get('id','')}@alrimi",
            f"DTSTAMP:{stamp}T000000Z",
            f"DTSTART;VALUE=DATE:{day.replace('-', '')}",
            f"DTEND;VALUE=DATE:{end}",          # 온종일 일정은 끝날짜가 하루 뒤다
            f"SUMMARY:[의견 마감] {ics_esc(p.get('name',''))}",
            f"DESCRIPTION:{ics_esc(ics_body(p))}",
            f"LOCATION:{ics_esc(p.get('address',''))}",
            "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P3DT15H",
            f"DESCRIPTION:{ics_esc(p.get('name',''))} 의견 제출 마감 3일 전", "END:VALARM",
            "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15H",
            f"DESCRIPTION:{ics_esc(p.get('name',''))} 의견 제출 오늘 마감", "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    folded = []
    for ln in lines:
        folded.extend(ics_fold(ln))
    return "\r\n".join(folded) + "\r\n"          # 캘린더 파일은 줄바꿈이 CRLF 여야 한다


def cal_slug(sido, sgg=None, dong=None):
    """파일 이름. 띄어쓰기는 '-' 로 바꾼다 ('청주시 청원구' 같은 이름이 있다).
    ★ 이름 규칙은 app.js 의 calFeedName() 과 반드시 같아야 한다 —
      어긋나면 화면이 없는 파일을 가리켜 구독이 조용히 실패한다."""
    name = "_".join([p for p in (sido, sgg, dong) if p])
    return name.replace(" ", "-") + ".ics"


def build_calendars(rows):
    """전국 1개 + 시·도 16개 + 시·군·구 255개 + 읍·면·동 5,034개 를 만든다 (약 5,300개).

    ★ 읍·면·동까지 만드는 이유: 화면에서 고른 단계가 곧 받는 범위이기 때문이다.
      시·군·구까지만 고르면 그 시·군·구 전체가, 읍·면·동까지 고르면 그 동네 것만 온다.
    ★ 사업이 0건인 지역도 반드시 만든다 — 구독해 둔 주소가 사라지면
      캘린더 앱이 오류를 내거나 구독을 통째로 버린다. 빈 파일은 335바이트뿐이다.
    """
    try:
        with open(os.path.join(os.path.dirname(OUT_PATH), "regions.json"), encoding="utf-8") as f:
            regions = json.load(f).get("regions") or {}
    except (OSError, ValueError) as e:
        log(f"[캘린더] regions.json 을 못 읽어 건너뜁니다: {e}")
        return

    os.makedirs(CAL_DIR, exist_ok=True)
    written = 0

    def put(fname, title, items):
        nonlocal written
        text = build_ics(title, items)
        path = os.path.join(CAL_DIR, fname)
        # 내용이 같으면 다시 쓰지 않는다 (파일 날짜만 바뀌어 커밋이 지저분해지는 것을 막는다)
        try:
            with open(path, encoding="utf-8", newline="") as f:
                if f.read() == text:
                    return
        except OSError:
            pass
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        written += 1

    put("all.ics", "전국 개발사업 의견 마감", rows)
    total = 1
    for sido, info in regions.items():
        in_sido = [p for p in rows if (p.get("address") or "").startswith(sido)]
        put(cal_slug(sido), f"{sido} 개발사업 의견 마감", in_sido)
        total += 1

        sggs = info.get("sgg") or {}
        for sgg, dongs in sggs.items():
            head = f"{sido} {sgg}"
            in_sgg = [p for p in in_sido if (p.get("address") or "").startswith(head)]
            put(cal_slug(sido, sgg), f"{head} 개발사업 의견 마감", in_sgg)
            total += 1
            # 읍·면·동까지 — 고른 만큼만 좁혀 받을 수 있게 한다.
            # 여기서는 in_sgg 안에서만 찾으므로 건수가 적어 부담이 없다.
            for dong in (dongs or []):
                sub = f"{head} {dong}"
                put(cal_slug(sido, sgg, dong), f"{sub} 개발사업 의견 마감",
                    [p for p in in_sgg if (p.get("address") or "").startswith(sub)])
                total += 1

        # 세종처럼 시·군·구 단계가 없는 곳은 시·도 바로 아래에 읍·면·동이 있다
        if not sggs:
            for dong in (info.get("dong") or []):
                sub = f"{sido} {dong}"
                put(cal_slug(sido, None, dong), f"{sub} 개발사업 의견 마감",
                    [p for p in in_sido if (p.get("address") or "").startswith(sub)])
                total += 1

    log(f"[캘린더] 지역별 .ics {total}개 준비 (이번에 바뀐 파일 {written}개) → {CAL_DIR}")


def view_closed(period_end, day):
    """공람 기간이 끝났는가.

    평가서 초안은 법적으로 **공람 기간에만** 열람할 수 있다.
    그래서 공람이 끝나면 그 내용을 옮긴 AI 해석도 함께 닫는다.
    (의견 제출 기한은 공람 종료 +7일까지라 사업 자체는 화면에 남는다 — 헷갈리지 말 것)
    """
    if not period_end:
        return False
    try:
        return datetime.date.fromisoformat(period_end) < day
    except ValueError:
        return False


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


def refresh_cached(cached, item, vworld_key, skip_geocode, category_key, delay,
                   vworld_domain=None, skip_route=False, skip_summary=False,
                   today=None):
    """재사용하는 사업에서 '싸게 고칠 수 있는 것'만 손본다.

    · 공람 기간: 목록에 나온 최신 값으로 갱신한다 (기간이 연장되는 경우가 있다).
    · 설명회·공람 장소·의견 받는 곳: 아직 안 정해진 값이 있으면 상세를 다시 받는다.
    · 좌표: 지난번에 못 찾았으면 다시 시도한다 (지오코딩은 돈이 들지 않는다).
    · **노선 도형: 하천 이름은 찾았는데 도형이 비어 있으면 다시 받는다.** 좌표와 같은 이유다.
    · AI 해석: 다시 하지 않는다. 한 번 실패한 요약문은 내일도 실패할 가능성이 크고,
      매일 다시 부르면 그만큼 비용이 계속 나간다. 전부 다시 받으려면 --full 을 쓴다.
    """
    today = today or today_kst()   # 안 넘겨주면 오늘로 (날짜 비교에서 터지지 않게)

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

    # ★ 노선 도형 되받기 — 좌표와 똑같은 문제가 노선에도 있었다.
    #
    # 하천 이름은 요약문에서 잘 뽑았는데(riverNames 는 채워져 있는데) 도형이 비어 있으면,
    # 그날 VWorld 가 응답하지 않았던 것이다. 그런데 여기에 되받는 코드가 없어서
    # **한 번 비면 영영 비어 있었다.** 증분 수집은 이미 받아 둔 사업을 통째로 건너뛰기 때문이다.
    #   실측(2026-08-16): '한강 서울권역'·'상두천' 두 건이 그 상태였다.
    #   그때 못 받았을 뿐, 지금 물어보면 7개·1개 도형이 그대로 나온다.
    #   두 건 다 VWorld 가 죽어 있던 8/13~8/15 에 처음 수집된 사업이다.
    #
    # 지오코딩과 같이 **VWorld 만 부르므로 돈이 들지 않는다** (PDF·AI 는 건드리지 않는다).
    if (not skip_route and cached.get("isRiver") and cached.get("riverNames")
            and not cached.get("routeGeom")):
        routes = fetch_river_routes(cached["riverNames"], cached.get("lat"), cached.get("lon"),
                                    vworld_key, vworld_domain)
        if routes:
            cached["routeGeom"] = routes
            cached["routeSource"] = "vworld-river"
            log(f"    (재사용) 비어 있던 노선 도형 {len(routes)}개를 채웠습니다")

    # ★ 하천 사업 판정(isRiver) 되받기 — 판정 **규칙이 바뀌면** 이미 받아 둔 사업은
    #   증분 수집이 통째로 건너뛰므로 **옛 판정이 영영 굳는다.**
    #
    #   2026-08-25 에 실제로 겪었다. `is_river_project()` 가 뭉뚱그린 사업구분
    #   (`개발사업(전체) / 기반시설`) 때문에 `천미천 … 하천기본계획(변경)` 을
    #   '하천 사업이 아님'으로 보고 있었다. 규칙만 고쳐도 그 사업은 안 고쳐진다.
    #
    #   판정은 이름·사업구분만 보는 **공짜 계산**이라 매번 다시 한다.
    #   False -> True 로 뒤집혔고 하천 이름이 비어 있으면 요약문을 다시 읽어 채운다.
    #   **돈은 들지 않는다** — 요약문 PDF 와 VWorld 만 쓰고 AI 는 부르지 않는다.
    if not skip_route and "선형" in (cached.get("locationTypes") or []):
        now_river = is_river_project(cached.get("name"), cached.get("bizType"), None)
        if now_river and not cached.get("isRiver"):
            cached["isRiver"] = True
            log("    (재사용) 하천 사업으로 다시 판정했습니다 (판정 규칙이 바뀌었습니다)")
        if cached.get("isRiver") and not cached.get("riverNames") and not cached.get("routeGeom"):
            if view_closed(cached.get("periodEnd"), today):
                # 공람이 끝나면 EIASS 가 첨부를 내려서 요약문을 받을 수 없다.
                log("    (재사용) 공람이 끝나 요약문을 받을 수 없어 하천 이름을 못 채웁니다")
            elif not cached.get("summaryFileSeq"):
                log("    (재사용) 요약문 파일이 없어 하천 이름을 못 채웁니다")
            else:
                try:
                    text, _pages = extract_pdf_text(download_file(cached["summaryFileSeq"]))
                    names = extract_river_names(text)
                    if names:
                        cached["riverNames"] = names
                        routes = fetch_river_routes(names, cached.get("lat"), cached.get("lon"),
                                                    vworld_key, vworld_domain)
                        if routes:
                            cached["routeGeom"] = routes
                            cached["routeSource"] = "vworld-river"
                        log(f"    (재사용) 하천 이름 {len(names)}개를 채웠습니다"
                            f" → 노선 도형 {len(routes)}개")
                    else:
                        log("    (재사용) 요약문에서 하천 이름을 찾지 못했습니다")
                except Exception as e:
                    log(f"    [하천 이름 되받기 실패 — 다음에 다시 해 봅니다] {e}")

    # ★ summaryState 되받기 — 노선 도형과 **똑같은 함정**이다.
    #
    # 이 값(요약문을 읽었나 / 사진이라 못 읽었나 / 아예 없나)은 2026-08-16 에 생겼다.
    # 그전에 수집된 사업은 값이 없는데, 증분 수집은 이미 받아 둔 사업을 건너뛰므로
    # **되받는 코드가 없으면 영영 비어 있고**, 화면은 계속 "요약문에 내용이 없습니다"라고
    # 잘못 말하게 된다 (실제로는 못 읽은 것이다).
    #
    # 돈은 들지 않는다 — AI 는 부르지 않고, 대부분은 내려받지도 않는다.
    if not skip_summary and cached.get("summaryState") is None:
        if cached.get("analysis"):
            # 해석이 있다는 것은 그때 요약문을 잘 읽었다는 뜻이다. 받아 볼 필요가 없다.
            cached["summaryState"] = "ok"
        elif view_closed(cached.get("periodEnd"), today):
            # 공람이 끝난 사업은 EIASS 가 첨부를 내려서 받아지지도 않고,
            # 화면도 해석 자리에 '공람 종료' 안내를 내보내므로 이 값을 쓰지 않는다.
            pass
        elif not cached.get("summaryFileSeq"):
            cached["summaryState"] = "none"
            log("    (재사용) 요약문 파일이 없는 사업으로 표시했습니다")
        else:
            try:
                text, pages = extract_pdf_text(download_file(cached["summaryFileSeq"]))
                per_page = len(text) / pages if pages else 0
                cached["summaryState"] = "ok" if per_page >= MIN_CHARS_PER_PAGE else "scanned"
                log(f"    (재사용) 요약문을 다시 읽어 봤습니다 — {pages}쪽 {len(text)}자"
                    f"(쪽당 {per_page:.0f}자) → {cached['summaryState']}")
            except Exception as e:
                # 못 받았으면 '모름'으로 둔다. 다음 수집에서 다시 시도한다.
                log(f"    [요약문 재확인 실패 — 다음에 다시 해 봅니다] {e}")
    return cached


# ============================================================
# 전체 흐름
# ============================================================
def build(args):
    today = today_kst()
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
        # 목록을 받다가 접속이 끊기면 SESSION 이 4번까지 다시 시도한다.
        # 그래도 안 되면 여기서 멈춘다. **반쪽짜리 결과를 저장하면 안 되기 때문이다.**
        # (예: 전략 43건은 받고 환경 16건을 못 받으면 48건이 43건으로 줄어든 채 저장된다.
        #  10% 남짓 줄어든 것이라 collect.yml 의 '절반 이하면 중단' 검사도 통과해 버린다)
        # 아무것도 저장하지 않고 끝내면 어제 자료가 그대로 남아 화면은 정상 동작한다.
        try:
            open_items = fetch_open_items(category_key, today, args.max_pages, args.delay)
        except Exception as e:
            log(f"[{label}] 목록을 받지 못했습니다 — {type(e).__name__}: {str(e)[:200]}")
            log("[중단] EIASS 접속이 끊겼습니다. 반쪽짜리 자료를 저장하지 않으려고 멈춥니다.")
            log("       오늘 자료는 안 바뀌지만 화면은 어제 자료로 정상 동작합니다.")
            log("       (자동 수집은 한국시간 13시에 한 번 더 시도합니다)")
            raise SystemExit(1)
        if args.limit:
            open_items = open_items[: args.limit]
        log(f"[{label}] 공람 중 {len(open_items)}건 확인")

        for it in open_items:
            project_id = f"{it['biz_cd']}-{it['biz_seq']}"

            cached = existing.get(project_id)

            # --retry-analysis: AI 해석이 비어 있는 사업만 골라 다시 받는다.
            # (응답이 잘리거나 형식이 깨져 실패했던 것들. 전체를 다시 받을 필요는 없다)
            #
            # ★ 단 **공람이 끝난 사업은 다시 받지 않는다.** 저장 직전에 해석을 지우므로
            #   (아래 '공람이 끝난 사업의 해석은 파일에서 지운다' 참고) 여기서 다시 받으면
            #   방금 지운 것을 되살리는 셈이 된다. 어차피 공람이 끝나면 EIASS 가 첨부를
            #   내려서 받아지지도 않는다 — 돈만 쓰고 빈손으로 끝난다.
            #   ★ 사진으로 된 요약문(scanned)도 다시 받지 않는다. 몇 번을 받아도 글자가
            #     없는 문서라 결과가 같은데, 1.85MB~10MB 를 매번 새로 내려받게 된다.
            if (cached and args.retry_analysis and not cached.get("analysis")
                    and cached.get("summaryState") != "scanned"
                    and not view_closed(it["period_end"], today)):
                log(f"  ! {it['name']} (해석이 비어 있어 다시 받습니다)")
                cached = None

            if cached:
                log(f"  = {it['name']} (이미 받아 둠)")
                all_projects.append(
                    refresh_cached(cached, it, vworld_key, args.skip_geocode,
                                   category_key, args.delay,
                                   vworld_domain, args.skip_route,
                                   args.skip_summary, today))
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
            # 요약문을 어떻게 했는지 화면에 알려 주기 위한 값.
            #   None       모름 (--skip-summary 로 건너뛰었거나 받다 실패)
            #   "none"     첨부 목록에 요약문이 없다
            #   "scanned"  요약문은 있는데 사진(스캔본)이라 글자를 못 뽑았다
            #   "ok"       읽었다
            summary_state = None
            if not args.skip_summary:
                if not summary_file:
                    summary_state = "none"
                else:
                    try:
                        pdf_bytes = download_file(summary_file["file_seq"])
                        raw_text, pages = extract_pdf_text(pdf_bytes)
                        per_page = len(raw_text) / pages if pages else 0
                        if per_page < MIN_CHARS_PER_PAGE:
                            # ★ 스캔본은 AI 에 넘기지 않는다. 목차와 쪽 번호만 든 글을 먹이면
                            #   지어낼 위험만 있고 얻을 것이 없다. 돈도 아낀다.
                            summary_state = "scanned"
                            log(f"    [요약문] 글자를 뽑지 못했습니다 — {pages}쪽에서 {len(raw_text)}자"
                                f"(쪽당 {per_page:.0f}자). 사진으로 된 문서로 봅니다")
                            raw_text = None
                        else:
                            summary_state = "ok"
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
                # 해석이 비었을 때 **왜 비었는지**를 화면이 갈라 말하기 위한 값
                "summaryState": summary_state,
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
    end_day = today_kst()

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

    # ★★ 공람이 끝난 사업의 환경영향분석은 **파일에서 아예 지운다.**
    #
    # 화면(app.js 의 eiaSection)이 공람 기간(viewOpen)으로 잠그고 있지만,
    # 그것은 "화면에 안 그린다"는 뜻일 뿐이다. data/projects.json 은
    # 누구나 주소로 곧장 내려받을 수 있는 공개 파일이라, 해석 글자가 파일 안에 남아 있으면
    # **화면 규칙만으로는 지켜지지 않는다.** (해커가 아니어도 주소만 알면 읽힌다)
    #
    # 평가서 초안은 법적으로 공람 기간에만 열람할 수 있으므로,
    # 그 내용을 옮긴 해석도 공람 종료와 함께 **자료에서** 닫아야 한다.
    # 사업명·기간·기관·설명회 같은 사실 정보는 그대로 둔다. 지우는 것은 해석뿐이다.
    #
    # 기준은 '의견제출 마감일'이 아니라 **'공람 종료일'** 이다. 절대 헷갈리지 말 것 —
    # 공람이 끝나고 의견만 받는 기간에도 해석은 닫혀 있어야 한다.
    withheld = 0
    for p in kept:
        if not view_closed(p.get("periodEnd"), end_day):
            continue
        if p.get("analysis") or p.get("summaryEasy"):
            p["analysis"] = None
            p.pop("summaryEasy", None)
            withheld += 1
    if withheld:
        log(f"[공람 종료] {withheld}건의 환경영향분석을 파일에서 지웠습니다 "
            f"(평가서 초안은 공람 기간에만 볼 수 있습니다).")

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

    # '우리가 처음 본 날'을 적는다. 반드시 **파일을 덮어쓰기 전에** 해야 한다
    # (지난 파일의 firstSeen 을 읽어 물려받는 것이라, 덮어쓴 뒤에는 읽을 것이 없다).
    fresh = stamp_first_seen(kept, end_day, OUT_PATH)
    if fresh:
        log(f"[새 사업] 오늘 처음 본 사업 {fresh}건에 발견일을 적었습니다.")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": end_day.isoformat(),
            "note": ("이 파일은 tools/build_data.py가 EIASS 공개 자료를 바탕으로 자동 생성합니다. "
                     "생성 시점에 초안 공람 기간 안에 있던 사업만 담겨 있습니다. "
                     "공람이 끝난 사업의 analysis(환경영향분석)는 담지 않습니다 — "
                     "평가서 초안은 법적으로 공람 기간에만 열람할 수 있기 때문입니다."),
            # 자료 출처 — 이 파일만 따로 받아 가는 사람에게도 이용 조건이 전달되어야 한다.
            # (EIASS 푸터 실측: 공공누리 제4유형 = 출처표시·상업적 이용금지·변경금지)
            "source": {
                "name": "환경영향평가 정보지원시스템(EIASS)",
                "org": "기후에너지환경부 국립환경과학원",
                "url": "https://www.eiass.go.kr/",
                "license": "공공누리 제4유형 (출처표시·상업적 이용금지·변경금지)",
                "licenseUrl": "https://www.kogl.or.kr/info/license.do",
            },
            "stats": {
                # EIASS 사업조회에서 '진행현황=진행중'으로 세어 온 건수.
                # 공람 중인 사업(projects)과는 다른 모수다.
                "underReview": stats,
            },
            "projects": kept,
        }, f, ensure_ascii=False, indent=2)

    build_calendars(kept)

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
