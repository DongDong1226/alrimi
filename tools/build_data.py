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
  5. 뽑은 글자를 Anthropic API로 보내 주민이 읽기 쉬운 요약을 받는다. (ANTHROPIC_API_KEY 필요)

키가 없으면 해당 단계만 건너뛰고 나머지는 정상적으로 만든다.
API 키는 코드에 직접 적지 말고, 실행 전에 환경변수로 넣어서 쓴다.

    (윈도우 PowerShell)
    $env:VWORLD_KEY = "발급받은 vworld 키"
    $env:ANTHROPIC_API_KEY = "발급받은 anthropic 키"
    python tools/build_data.py

테스트로 몇 건만 빠르게 돌려보고 싶으면:
    python tools/build_data.py --limit 3 --skip-summary --skip-geocode
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
from lxml import html as lhtml

BASE = "https://www.eiass.go.kr"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}

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
    print(msg, flush=True)


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


def parse_detail_html(html_text):
    tree = lhtml.fromstring(html_text)
    result = {"address": None, "org": None, "tel": None, "files": []}

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
        result["address"] = addr.split(")")[0].strip() + ")" if ")" in addr else addr

    # "협의기관" 표기가 없는 유형(환경영향평가)은 "승인기관"으로 대신한다.
    result["org"] = _row_first_td_text(tree, "협의기관") or _row_first_td_text(tree, "승인기관")
    result["tel"] = _row_first_td_text(tree, "전화번호")

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
def geocode_address(address, vworld_key):
    if not vworld_key or not address:
        return None, None
    url = "https://api.vworld.kr/req/address"
    base_params = {
        "service": "address",
        "request": "getcoord",
        "version": "2.0",
        "crs": "epsg:4326",
        "address": address,
        "key": vworld_key,
    }
    for addr_type in ("road", "parcel"):
        try:
            r = requests.get(url, params={**base_params, "type": addr_type},
                              verify=VERIFY_SSL, timeout=10)
            point = r.json().get("response", {}).get("result", {}).get("point")
            if point:
                return float(point["y"]), float(point["x"])
        except Exception as e:
            log(f"    [지오코딩 오류:{addr_type}] {e}")
    return None, None


# ============================================================
# 5) LLM 요약 — 어려운 평가서 요약문을 주민이 읽을 말로 바꾸기
# ============================================================
def summarize_easy(name, address, raw_text, anthropic_key):
    if not anthropic_key or not raw_text:
        return None
    import anthropic

    client = anthropic.Anthropic(api_key=anthropic_key)
    prompt = (
        "너는 환경영향평가 요약문을, 관련 지식이 없는 동네 주민에게 설명하는 사람이야.\n"
        "아래는 실제 평가서 요약문에서 뽑은 원문이야. 이걸 읽고 다음 형식으로 답해.\n\n"
        "- 전문용어를 쓰지 말고, 한 문장은 짧게.\n"
        "- 소음, 교통, 먼지, 자연환경 등 생활에 영향을 주는 부분 위주로 3~5문장.\n"
        "- 사업 자체를 홍보하거나 판단하지 말고, 사실만 담백하게 전달.\n\n"
        f"사업명: {name}\n"
        f"위치: {address or '정보 없음'}\n\n"
        "요약문 원문(일부):\n"
        f"{raw_text[:6000]}\n"
    )
    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=500,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in msg.content if block.type == "text").strip()
    except Exception as e:
        log(f"    [LLM 요약 오류] {name}: {e}")
        return None


# ============================================================
# 전체 흐름
# ============================================================
def build(args):
    today = datetime.date.today()
    vworld_key = os.environ.get("VWORLD_KEY", "")
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
                log(f"    [상세 조회 실패] {e}")
                detail = {"address": None, "org": None, "tel": None, "files": []}
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

            easy_summary = None
            if raw_text:
                easy_summary = summarize_easy(it["name"], detail["address"], raw_text, anthropic_key)

            all_projects.append({
                "id": f"{it['biz_cd']}-{it['biz_seq']}",
                "category": category_key,
                "categoryLabel": label,
                "name": it["name"],
                "org": detail["org"] or it["list_meta"],
                "tel": detail["tel"],
                "address": detail["address"],
                "lat": lat,
                "lon": lon,
                "periodStart": it["period_start"],
                "periodEnd": it["period_end"],
                "summaryFileSeq": summary_file["file_seq"] if summary_file else None,
                "summaryEasy": easy_summary,
            })

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": today.isoformat(),
            "note": "이 파일은 tools/build_data.py가 EIASS 공개 자료를 바탕으로 자동 생성합니다.",
            "projects": all_projects,
        }, f, ensure_ascii=False, indent=2)

    log(f"완료: {OUT_PATH} 에 {len(all_projects)}건 저장")


def main():
    parser = argparse.ArgumentParser(description="EIASS 초안 공람 데이터 수집")
    parser.add_argument("--limit", type=int, default=None, help="유형별 최대 수집 건수 (테스트용)")
    parser.add_argument("--max-pages", type=int, default=60, help="목록 페이지 최대 조회 수")
    parser.add_argument("--delay", type=float, default=0.4, help="요청 사이 대기 시간(초)")
    parser.add_argument("--skip-geocode", action="store_true", help="vworld 지오코딩 건너뛰기")
    parser.add_argument("--skip-summary", action="store_true", help="요약문 PDF 다운로드/LLM 요약 건너뛰기")
    args = parser.parse_args()
    build(args)


if __name__ == "__main__":
    sys.exit(main())
