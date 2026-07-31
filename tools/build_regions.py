# -*- coding: utf-8 -*-
"""
전국 시도 / 시군구 / 읍면동 목록을 만들어 data/regions.json 으로 저장한다.

첫 화면의 "동네 설정" 드롭다운과 지도 화면의 주소 변경 칸이 이 파일을 읽는다.
행정구역은 자주 바뀌지 않으니 한 번 만들어 두고, 개편이 있을 때만 다시 돌리면 된다.

    python tools/build_regions.py

자료는 VWorld 2D데이터 API의 읍면동 경계 레이어(LT_C_ADEMD_INFO)에서 가져온다.
각 항목의 full_nm 에 "시도 시군구 읍면동" 전체 이름이 들어 있어서 그것으로 목록을 만든다.
VWORLD_KEY 는 .env 파일에서 읽는다. (build_data.py 와 같은 키)

인증키를 발급받을 때 등록한 서비스 URL이 http://localhost:8000 이 아니라면
.env 에 VWORLD_DOMAIN=등록한주소 를 추가한다.
"""

import json
import os
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

VWORLD_DATA_URL = "https://api.vworld.kr/req/data"
EMD_LAYER = "LT_C_ADEMD_INFO"          # 읍면동 경계
KOREA_BOX = "BOX(124,33,132,39)"        # 우리나라 전체를 덮는 사각형
PAGE_SIZE = 1000

VERIFY_SSL = os.environ.get("EIASS_INSECURE_SSL") != "1"
if not VERIFY_SSL:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "regions.json")

# 화면의 좁은 칸에 넣기 위한 짧은 이름
SHORT_NAME = {
    "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천",
    "광주광역시": "광주", "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종",
    "경기도": "경기", "강원도": "강원", "강원특별자치도": "강원", "충청북도": "충북",
    "충청남도": "충남", "전라북도": "전북", "전북특별자치도": "전북", "전라남도": "전남",
    "전남광주통합특별시": "전남광주", "경상북도": "경북", "경상남도": "경남",
    "제주특별자치도": "제주",
}


def fetch_emd_names(key, domain):
    """읍면동 전체 이름(full_nm) 목록을 페이지 단위로 모아서 돌려준다."""
    names = []
    for page in range(1, 30):
        params = {
            "service": "data", "request": "GetFeature", "data": EMD_LAYER,
            "key": key, "domain": domain, "format": "json",
            "size": PAGE_SIZE, "page": page,
            "geometry": "false", "geomFilter": KOREA_BOX,
        }
        r = requests.get(VWORLD_DATA_URL, params=params, verify=VERIFY_SSL, timeout=60)
        r.raise_for_status()
        res = r.json().get("response", {})
        if res.get("status") != "OK":
            err = res.get("error", {})
            raise SystemExit(
                f"[VWorld 오류] {err.get('code')} {err.get('text')}\n"
                "  · 인증키에 '2D데이터 API'가 포함돼 있는지\n"
                "  · .env 의 VWORLD_DOMAIN 이 발급 때 등록한 서비스 URL과 같은지 확인하세요."
            )
        features = res.get("result", {}).get("featureCollection", {}).get("features", [])
        if not features:
            break
        names += [f["properties"]["full_nm"] for f in features]
        print(f"  {page}페이지 ({len(names)}건 누적)")
        if len(features) < PAGE_SIZE:
            break
        time.sleep(0.2)
    return names


def build():
    key = os.environ.get("VWORLD_KEY", "")
    if not key:
        raise SystemExit("VWORLD_KEY 가 없습니다. .env 파일에 넣어 주세요.")
    domain = os.environ.get("VWORLD_DOMAIN", "http://localhost:8000")

    print("VWorld에서 읍면동 목록을 받아옵니다")
    names = fetch_emd_names(key, domain)
    print(f"읍면동 {len(names)}건")

    regions = {}
    for full in names:
        parts = full.split()          # 세종처럼 공백이 두 칸인 경우도 있어 split() 로 처리
        if len(parts) < 2:
            continue
        sido, dong = parts[0], parts[-1]
        # 가운데 부분이 시군구. "성남시 분당구"처럼 두 단계인 곳도 있다.
        sgg = " ".join(parts[1:-1])
        entry = regions.setdefault(sido, {
            "short": SHORT_NAME.get(sido, sido[:2]),
            "sgg": {},
            "dong": [],
        })
        if sgg:
            entry["sgg"].setdefault(sgg, []).append(dong)
        else:
            entry["dong"].append(dong)   # 세종처럼 시군구 단계가 없는 곳

    for sido, entry in regions.items():
        entry["sgg"] = {k: sorted(set(v)) for k, v in sorted(entry["sgg"].items())}
        entry["dong"] = sorted(set(entry["dong"]))
        print(f"  {sido}: 시군구 {len(entry['sgg'])}개, 직속 읍면동 {len(entry['dong'])}개")

    regions = dict(sorted(regions.items()))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"regions": regions}, f, ensure_ascii=False, indent=1)
    print(f"완료: {OUT_PATH} (시도 {len(regions)}개)")


if __name__ == "__main__":
    sys.exit(build())
