/* ============================================================
   설정 기본값
   이 값들은 관리자 화면에서 덮어쓸 수 있고, 덮어쓴 값은
   localStorage 에 저장되어 다음 방문 때 우선 적용됩니다.
   ============================================================ */
const DEFAULTS = {
  adminPw: "admin1234",
  vworldKey: "",
  serviceUrl: "http://localhost:8000",
  centerLon: "127.1946",
  centerLat: "37.5636",
  dataPath: "data/projects.json",
  regionPath: "data/regions.json",
  radiusKm: 3,
  showDemoBanner: true,
  org: "기후에너지환경부 국립환경과학원",
  person: "김동윤",
  tel: "032-560-xxxx",
  defHood: { sido:"경기도", sgg:"하남시", dong:"미사동" },
  /* 첫 화면 전국 현황 — 실제 집계값이 나오면 관리자 화면에서 교체 */
  nation: [
    { k:"등록된 개발사업", v:"48,231", u:"건" },
    { k:"지금 공람 중",    v:"228",    u:"건" },
    { k:"이번 주 새 사업",  v:"34",     u:"건" }
  ]
};

const LSKEY = "wdn.settings";
const LSRECENT = "wdn.recent";

function lsGet(k, fb){
  try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
  catch(e){ return fb; }
}
function lsSet(k, v){
  try{ localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch(e){ return false; }
}

let S = Object.assign({}, DEFAULTS, lsGet(LSKEY, {}));

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* 데이터에서 온 글자를 화면에 넣기 전에 HTML 특수문자를 막는다. */
function esc(v){
  if(v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

/* ============================================================
   환경영향분석 — 항목 틀
   요약문에 내용이 있으면 채우고, 없으면 "언급 없음"으로 남긴다.
   (없는 내용을 지어내지 않기 위해 항목을 고정한다)
   ============================================================ */
const EIA_FIELDS = [
  { key:"overview", label:"어떤 사업인가" },
  { key:"air",      label:"공기 · 먼지 · 냄새" },
  { key:"noise",    label:"소음 · 진동" },
  { key:"water",    label:"물 (수질 · 지하수)" },
  { key:"nature",   label:"동식물 · 생태" },
  { key:"land",     label:"토양 · 경관" },
  { key:"waste",    label:"폐기물" },
  { key:"etc",      label:"그 밖에" }
];

/* ============================================================
   사업 데이터
   data/projects.json (tools/build_data.py가 EIASS에서 만든 실제 데이터)을
   불러온다. 불러오지 못하면(파일이 아직 없거나 서버 없이 file://로 열었을 때)
   화면 확인용 표본 데이터로 대신한다.
   ============================================================ */
const SAMPLE_PROJECTS = [
  { id:"sample-1", category:"main", categoryLabel:"환경영향평가",
    name:"(표본) 미사강변 도시개발사업 3단계", periodStart:"2026-08-01", periodEnd:"2026-08-14",
    address:"하남시 미사동 일원", org:"경기도시공사", lat:null, lon:null },
  { id:"sample-2", category:"strat", categoryLabel:"전략환경영향평가",
    name:"(표본) 하남 교산지구 진입도로 개설사업", periodStart:"2026-08-01", periodEnd:"2026-08-19",
    address:"하남시 교산동 일원", org:"한국토지주택공사", lat:null, lon:null }
];

let PROJECTS = [];
let dataReady = false;
const CATEGORY_BADGE = { strat:"badge--navy", main:"badge--blue" };

/* 우리 집(기준 위치). 동네를 정하면 좌표를 찾아 여기에 넣는다. */
let HOME = { lat:+S.centerLat, lon:+S.centerLon, label:"", exact:false };

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* EIASS에서 수집한 원본 항목을 화면에서 쓰는 모양으로 바꾼다.
   원문에 없는 값(예: 주민 의견 수)은 만들어내지 않는다. */
function normalizeProject(p){
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let dday = null, stage = "공람 종료";
  if(p.periodEnd){
    const end = new Date(p.periodEnd + "T00:00:00");
    const diff = Math.round((end - today) / 86400000);
    if(diff >= 0){ dday = diff; stage = "초안 공람 중"; }
  }
  const hasCoord = typeof p.lat === "number" && typeof p.lon === "number";
  return {
    id: p.id,
    type: p.category,
    typeLabel: p.categoryLabel || p.category,
    badge: CATEGORY_BADGE[p.category] || "badge--gray",
    name: p.name,
    stage, dday,
    dist: null,                 // 우리 집 좌표가 정해진 뒤 계산한다
    period: (p.periodStart && p.periodEnd) ? `${p.periodStart} ~ ${p.periodEnd}` : "정보 없음",
    where: p.address || "위치 정보 없음",
    org: p.org || "기관 정보 없음",
    tel: p.tel || null,
    lat: hasCoord ? p.lat : null,
    lon: hasCoord ? p.lon : null,
    analysis: p.analysis || null,      // 정형화된 환경영향분석
    summaryEasy: p.summaryEasy || null, // 예전 방식(자유 문장) — 아직 남아있으면 같이 보여준다
    sourceBizCd: p.sourceBizCd || null,
    sourceBizSeq: p.sourceBizSeq || null,
    sourceStepCd: p.sourceStepCd || null,
    sourceViewPath: p.sourceViewPath || null
  };
}

/* 우리 집 좌표가 바뀌면 모든 사업의 거리를 다시 계산한다. */
function recomputeDistances(){
  PROJECTS.forEach(p => {
    p.dist = (p.lat != null && p.lon != null)
      ? haversineKm(HOME.lat, HOME.lon, p.lat, p.lon) : null;
  });
}

async function loadProjects(){
  let list = [];
  try{
    const res = await fetch(S.dataPath, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if(Array.isArray(json.projects) && json.projects.length) list = json.projects;
  }catch(e){
    console.warn("data/projects.json 을 불러오지 못해 표본 데이터를 표시합니다.", e);
  }
  PROJECTS = (list.length ? list : SAMPLE_PROJECTS).map(normalizeProject);
  dataReady = true;
  recomputeDistances();
  refreshAll();
}

/* 화면 전체를 데이터에 맞춰 다시 그린다. */
function refreshAll(){
  updateFilterCounts();
  updateDashboardStats();
  renderDashTick();
  render();
  renderOpenList();
  renderMiniMap();
  renderGisList();
  renderGisMarkers();
}

/* EIASS 원문 상세페이지는 GET 링크가 아니라 POST 로만 열려서,
   눈에 보이지 않는 폼을 만들어 새 탭으로 그대로 제출한다. */
function openEiassSource(p){
  if(!p.sourceBizCd || !p.sourceViewPath){
    alert("이 사업은 원문 연결 정보가 없습니다. 데이터를 다시 수집하면 연결됩니다.");
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "https://www.eiass.go.kr" + p.sourceViewPath;
  form.target = "_blank";
  const fields = { BIZ_CD:p.sourceBizCd, BIZ_SEQ:p.sourceBizSeq };
  if(p.sourceStepCd) fields.CCIL_STEP1_CD_CK = p.sourceStepCd;
  Object.entries(fields).forEach(([k, v]) => {
    const input = document.createElement("input");
    input.type = "hidden"; input.name = k; input.value = v;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

/* ============================================================
   행정구역 (전국 시도 / 시군구 / 읍면동)
   data/regions.json — tools/build_regions.py 가 만든다.
   ============================================================ */
let REGIONS = null;
const FALLBACK_REGIONS = {
  "경기도": { short:"경기", sgg:{ "하남시":["미사동","덕풍동","신장동","감일동"] }, dong:[] }
};

function fillSelect(sel, arr, pick){
  sel.innerHTML = arr.map(v =>
    `<option${v === pick ? " selected" : ""}>${esc(v)}</option>`).join("");
}
function sggList(sido){
  const r = REGIONS[sido];
  return r ? Object.keys(r.sgg) : [];
}
function dongList(sido, sgg){
  const r = REGIONS[sido];
  if(!r) return [];
  if(!Object.keys(r.sgg).length) return r.dong || [];   // 세종처럼 시군구가 없는 곳
  return r.sgg[sgg] || [];
}
function shortSido(sido){
  return (REGIONS && REGIONS[sido] && REGIONS[sido].short) || sido.slice(0, 2);
}

/* 시도 → 시군구 → 읍면동 순서로 이어지는 셀렉트 묶음을 만든다.
   첫 화면과 지도 화면에서 같은 방식으로 쓴다. */
function bindRegionSelects(sidoSel, sggSel, dongSel){
  const syncDong = pick => {
    const list = dongList(sidoSel.value, sggSel.value);
    fillSelect(dongSel, list.length ? list : ["전체"], pick);
  };
  const syncSgg = (sggPick, dongPick) => {
    const list = sggList(sidoSel.value);
    fillSelect(sggSel, list.length ? list : ["전체"], sggPick);
    syncDong(dongPick);
  };
  sidoSel.addEventListener("change", () => syncSgg());
  sggSel.addEventListener("change", () => syncDong());
  return {
    set(hood){
      if(!REGIONS) return;
      const sidoKeys = Object.keys(REGIONS);
      const sido = REGIONS[hood.sido] ? hood.sido : sidoKeys[0];
      fillSelect(sidoSel, sidoKeys, sido);
      syncSgg(hood.sgg, hood.dong);
    },
    get(){
      return { sido:sidoSel.value, sgg:sggSel.value, dong:dongSel.value };
    }
  };
}

const onbHood = bindRegionSelects($("#f-sido"), $("#f-sgg"), $("#f-dong"));
const mapHood = bindRegionSelects($("#m-sido"), $("#m-sgg"), $("#m-dong"));

/* 지금 보고 있는 동네 */
let currentHood = Object.assign({}, S.defHood);

async function loadRegions(){
  try{
    const res = await fetch(S.regionPath, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    REGIONS = json.regions && Object.keys(json.regions).length ? json.regions : FALLBACK_REGIONS;
  }catch(e){
    console.warn("data/regions.json 을 불러오지 못해 기본 목록만 표시합니다.", e);
    REGIONS = FALLBACK_REGIONS;
  }
  onbHood.set(S.defHood);
  mapHood.set(S.defHood);
  renderRecent();
}

/* ============================================================
   우리 집 좌표 찾기 — VWorld 지오코더
   브라우저에서 직접 부르면 CORS 에 막히는 경우가 있어 JSONP 방식으로 부른다.
   못 찾으면 관리자 설정의 기준 좌표를 그대로 쓴다.
   ============================================================ */
function geocodeJsonp(address, timeoutMs = 6000){
  return new Promise(resolve => {
    if(!S.vworldKey){ resolve(null); return; }
    const cbName = "wdnGeo" + Date.now() + Math.floor(Math.random() * 1000);
    const script = document.createElement("script");
    let done = false;
    const cleanup = () => {
      if(done) return;
      done = true;
      delete window[cbName];
      script.remove();
    };
    window[cbName] = res => {
      const point = res && res.response && res.response.result && res.response.result.point;
      cleanup();
      resolve(point ? { lat:+point.y, lon:+point.x } : null);
    };
    const q = new URLSearchParams({
      service:"address", request:"getCoord", version:"2.0", crs:"epsg:4326",
      address, format:"json", type:"parcel", key:S.vworldKey, callback:cbName
    });
    script.src = `https://api.vworld.kr/req/address?${q}`;
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
    setTimeout(() => { if(!done){ cleanup(); resolve(null); } }, timeoutMs);
  });
}

async function resolveHome(hood){
  currentHood = Object.assign({}, hood);
  const dong = hood.dong && hood.dong !== "전체" ? hood.dong : "";
  const sgg = hood.sgg && hood.sgg !== "전체" ? hood.sgg : "";
  const full = `${hood.sido} ${sgg} ${dong}`.replace(/\s+/g, " ").trim();
  HOME.label = full;

  // 동까지 못 찾으면 시군구, 그것도 못 찾으면 시도로 범위를 넓혀가며 찾는다.
  const hit = await geocodeJsonp(full)
    || (dong ? await geocodeJsonp(`${hood.sido} ${sgg}`.trim()) : null)
    || (sgg ? await geocodeJsonp(hood.sido) : null);
  if(hit){
    HOME.lat = hit.lat; HOME.lon = hit.lon; HOME.exact = true;
  }else{
    HOME.lat = +S.centerLat; HOME.lon = +S.centerLon; HOME.exact = false;
  }

  // 화면 곳곳의 동네 이름을 맞춘다.
  const label = `${shortSido(hood.sido)} ${sgg} ${dong}`.replace(/\s+/g, " ").trim();
  $("#h-hood").textContent = dong || sgg || hood.sido;
  $("#hood-pill-label").textContent = label;
  $("#hood-card-name").textContent = label;
  mapHood.set(hood);

  recomputeDistances();
  refreshAll();

  // 지도 화면을 보고 있으면 그 주소로 지도를 옮긴다.
  if($("#scr-map").classList.contains("on") && gisMap){
    selectedId = null;
    gisMap.setView([HOME.lat, HOME.lon], 13);
    renderGisMarkers(false);
    renderGisList();
    renderGisDetail();
  }
}

/* ============================================================
   설정 적용
   ============================================================ */
function applySettings(){
  $("#nationRow").innerHTML = S.nation.map(n => `
    <div class="nation-i">
      <p class="v">${esc(n.v)}<small>${esc(n.u || "")}</small></p>
      <p class="k">${esc(n.k)}</p>
    </div>`).join("");

  $("#demoBanner").hidden = !S.showDemoBanner;
  $("#v-radius").innerHTML = `${esc(S.radiusKm)}<small>km 이내</small>`;
  $("#h-radius").textContent = S.radiusKm;
  $("#gis-radius").textContent = S.radiusKm;
  $("#c-org").textContent = S.org;
  $("#c-person").textContent = S.person;
  $("#c-tel").textContent = S.tel;
  $("#f-org").textContent = S.org;
  $("#f-tel").textContent = S.tel;
  if(REGIONS) renderRecent();
}

/* 최근 설정 동네 */
function renderRecent(){
  const row = $("#recentRow");
  row.querySelectorAll(".kw-chip").forEach(el => el.remove());
  let list = lsGet(LSRECENT, []);
  if(!list.length) list = [ S.defHood ];
  list.slice(0, 3).forEach(h => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kw-chip";
    b.textContent = `${shortSido(h.sido)} ${h.sgg} ${h.dong}`;
    b.addEventListener("click", () => {
      if(REGIONS && REGIONS[h.sido]) onbHood.set(h);
    });
    row.appendChild(b);
  });
}
function pushRecent(h){
  let list = lsGet(LSRECENT, []);
  list = list.filter(x => !(x.sido === h.sido && x.sgg === h.sgg && x.dong === h.dong));
  list.unshift(h);
  lsSet(LSRECENT, list.slice(0, 3));
}

/* ============================================================
   화면 전환
   ============================================================ */
function show(id){
  $$(".screen").forEach(s => s.classList.remove("on"));
  $(id).classList.add("on");
  window.scrollTo(0, 0);
}

$("#setForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = ($("#f-name").value || "이웃").trim();
  const hood = onbHood.get();
  $("#greet-name").textContent = name;
  pushRecent(hood);
  show("#scr-home");
  startReveal();
  countUp();
  resolveHome(hood);   // 동네 이름 표시와 거리 계산은 여기서 함께 처리한다
});

$$(".js-change").forEach(b => b.addEventListener("click", () => {
  renderRecent();
  show("#scr-onboard");
}));

/* ============================================================
   모달
   ============================================================ */
let lastFocus = null;
function openModal(id){
  lastFocus = document.activeElement;
  const m = $("#" + id);
  m.hidden = false;
  document.body.style.overflow = "hidden";
  const x = m.querySelector(".modal-x");
  if(x) x.focus();
}
function closeModal(m){
  m.hidden = true;
  document.body.style.overflow = "";
  if(lastFocus) lastFocus.focus();
}
$$("[data-modal]").forEach(b => b.addEventListener("click", () => openModal(b.dataset.modal)));
$$(".modal").forEach(m => {
  m.querySelectorAll("[data-close]").forEach(el =>
    el.addEventListener("click", () => closeModal(m)));
});
addEventListener("keydown", e => {
  if(e.key === "Escape"){
    const open = $$(".modal").find(m => !m.hidden);
    if(open) closeModal(open);
  }
});

/* ============================================================
   반경 안/밖 구분
   ============================================================ */
let homeNearbyOnly = true;   // 홈 화면 사업 목록
let mapNearbyOnly = false;   // 지도 화면

function isNearby(p){
  return p.dist != null && p.dist <= S.radiusKm;
}
function nearbyProjects(){ return PROJECTS.filter(isNearby); }

/* ============================================================
   환경영향분석 그리기
   ============================================================ */
function eiaHtml(p){
  const rows = EIA_FIELDS.map(f => {
    const v = p.analysis ? p.analysis[f.key] : null;
    return v
      ? `<div class="eia-row"><p class="k">${esc(f.label)}</p><p class="v">${esc(v)}</p></div>`
      : `<div class="eia-row none"><p class="k">${esc(f.label)}</p><p class="v">요약문에 관련 내용이 없습니다</p></div>`;
  }).join("");

  const legacy = (!p.analysis && p.summaryEasy)
    ? `<div class="eia-row"><p class="v">${esc(p.summaryEasy)}</p></div>` : "";

  return `
    <div class="eia">
      <h4>환경영향분석</h4>
      <p class="eia-src">사업자가 낸 평가서 초안의 <b>요약문</b>에 적힌 내용만 쉬운 말로 옮긴 것입니다.
        판단이나 의견은 담지 않았고, 요약문에 없는 항목은 비워 둡니다.</p>
      ${legacy || rows}
    </div>`;
}

/* ============================================================
   홈 — 대시보드 숫자 / 알림줄
   ============================================================ */
function updateFilterCounts(){
  const base = homeNearbyOnly ? nearbyProjects() : PROJECTS;
  const counts = { all: base.length };
  base.forEach(p => { counts[p.type] = (counts[p.type] || 0) + 1; });
  $$("[data-filter]").forEach(chip => {
    const cnt = chip.querySelector(".cnt");
    if(cnt) cnt.textContent = counts[chip.dataset.filter] || 0;
  });
}

function updateDashboardStats(){
  const near = nearbyProjects();
  const openNear = near.filter(p => p.dday !== null);
  $("#stat-total").dataset.count = near.length;
  $("#stat-open").dataset.count = openNear.length;
  $("#h-count").textContent = near.length;

  const outside = PROJECTS.length - near.length;
  $("#stat-total-note").textContent = outside > 0
    ? `반경 밖에 ${outside}건 더 있음` : "";

  if(openNear.length){
    const minDday = Math.min(...openNear.map(p => p.dday));
    $("#stat-open-note").textContent = `가장 빠른 마감 D-${minDday}`;
  }else{
    $("#stat-open-note").textContent = "";
  }
  countUp();
}

function renderDashTick(){
  const soon = nearbyProjects().filter(p => p.dday !== null)
    .sort((a, b) => a.dday - b.dday).slice(0, 2);
  const box = $("#dashTick");
  if(!soon.length){
    box.innerHTML = `<div class="tick"><span class="msg">반경 ${esc(S.radiusKm)}km 안에 의견을 낼 수 있는 사업이 없습니다.</span></div>`;
    return;
  }
  box.innerHTML = soon.map(p => `
    <div class="tick">
      <span class="tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5" stroke-linecap="round"></path><circle cx="12" cy="16.5" r="1" fill="currentColor"></circle></svg>D-${p.dday}</span>
      <span class="msg">${esc(p.name)} — 의견 제출 마감까지 ${p.dday}일</span>
      <span class="date">~${esc(p.period.split("~")[1] || "")}</span>
    </div>`).join("");
}

/* ============================================================
   홈 — 사업 카드 목록
   ============================================================ */
let filter = "all", sortBy = "dist", query = "";

function visibleProjects(){
  let rows = (homeNearbyOnly ? nearbyProjects() : PROJECTS)
    .filter(p => filter === "all" || p.type === filter);
  if(query){
    const q = query.toLowerCase();
    rows = rows.filter(p => (p.name + p.typeLabel + p.where).toLowerCase().includes(q));
  }
  rows.sort((a, b) => {
    if(sortBy === "dist"){
      if(a.dist == null && b.dist == null) return 0;
      if(a.dist == null) return 1;
      if(b.dist == null) return -1;
      return a.dist - b.dist;
    }
    return (a.dday === null) - (b.dday === null) || (a.dday ?? 999) - (b.dday ?? 999);
  });
  return rows;
}

function render(){
  const rows = visibleProjects();
  const grid = $("#projGrid");

  if(!rows.length){
    const outside = PROJECTS.length;
    grid.innerHTML = homeNearbyOnly && outside
      ? `<div class="proj-empty">
           <p><b>${esc(HOME.label || "우리 동네")}</b> 반경 ${esc(S.radiusKm)}km 안에는 지금 공람 중인 사업이 없습니다.</p>
           <p style="margin-top:6px;font-size:var(--fs-body-s)">수집된 사업은 모두 ${outside}건입니다. 아래 버튼으로 전국 사업을 볼 수 있어요.</p>
           <button class="btn btn--line btn--sm btn--pill" type="button" id="btnShowAll" style="margin-top:14px">전국 사업 모두 보기</button>
         </div>`
      : `<p class="proj-empty">조건에 맞는 사업이 없습니다. 다른 유형을 눌러보세요.</p>`;
    const btn = $("#btnShowAll");
    if(btn) btn.addEventListener("click", () => {
      homeNearbyOnly = false;
      updateFilterCounts();
      render();
    });
    return;
  }

  grid.innerHTML = rows.map(p => `
    <article class="proj" data-id="${esc(p.id)}">
      <div class="badges">
        <span class="badge ${p.badge} badge--dot">${esc(p.typeLabel)}</span>
        ${p.dday !== null
          ? `<span class="badge ${p.dday <= 3 ? "badge--live" : "badge--dday"}">D-${p.dday}</span>`
          : `<span class="badge badge--line">${esc(p.stage)}</span>`}
        ${!isNearby(p) ? `<span class="badge badge--gray">반경 밖</span>` : ``}
      </div>
      <p class="ttl">${esc(p.name)}</p>
      <p class="desc">공람기간 ${esc(p.period)}</p>
      <div class="rows">
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"></path><circle cx="12" cy="10" r="2.4"></circle></svg><span>${esc(p.where)}${p.dist != null ? " · 우리 집에서 " + p.dist.toFixed(1) + "km" : ""}</span></div>
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"></path><path d="M15 3v4h4"></path></svg><span>${esc(p.org)} · ${esc(p.stage)}</span></div>
      </div>
      <div class="foot">
        <button class="btn btn--line btn--sm btn--pill" type="button" data-detail="${esc(p.id)}">자세히 보기</button>
        ${p.lat != null ? `<button class="btn btn--ghost btn--sm btn--pill" type="button" data-onmap="${esc(p.id)}">지도에서 보기</button>` : ``}
      </div>
    </article>`).join("");
}

$("#projGrid").addEventListener("click", e => {
  const d = e.target.closest("[data-detail]");
  if(d){ openDetail(d.dataset.detail); return; }
  const m = e.target.closest("[data-onmap]");
  if(m) openMapScreen(m.dataset.onmap);
});

/* 의견 낼 수 있는 초안 공람 목록 */
function renderOpenList(){
  const near = nearbyProjects().filter(p => p.dday !== null).sort((a, b) => a.dday - b.dday);
  const box = $("#openList");
  const note = $("#openListNote");
  note.textContent = HOME.label ? `${HOME.label} 반경 ${S.radiusKm}km 기준` : "";

  if(!near.length){
    box.innerHTML = `<p class="proj-empty" style="border-radius:var(--r-md)">반경 ${esc(S.radiusKm)}km 안에 의견을 낼 수 있는 사업이 없습니다.</p>`;
    return;
  }
  box.innerHTML = near.map(p => `
    <div class="row-item">
      <span class="dpill ${p.dday <= 3 ? "urgent" : ""}">D-${p.dday}</span>
      <div class="row-body">
        <p class="t">${esc(p.name)}</p>
        <p class="m">~${esc(p.period.split("~")[1] || "")} · ${esc(p.org)}${p.tel ? " · " + esc(p.tel) : ""}</p>
      </div>
      <button class="btn btn--line btn--sm btn--pill" type="button" data-detail="${esc(p.id)}">자세히 보기</button>
    </div>`).join("");
}
$("#openList").addEventListener("click", e => {
  const d = e.target.closest("[data-detail]");
  if(d) openDetail(d.dataset.detail);
});

/* 사업 상세 모달 */
function openDetail(id){
  const p = PROJECTS.find(x => String(x.id) === String(id));
  if(!p) return;
  $("#m-detail-t").textContent = p.name;
  $("#detailBody").innerHTML = `
    <div class="contact-card" style="margin-bottom:4px">
      <div class="contact-row"><span class="k">유형</span><span class="v">${esc(p.typeLabel)}</span></div>
      <div class="contact-row"><span class="k">위치</span><span class="v">${esc(p.where)}</span></div>
      <div class="contact-row"><span class="k">기관</span><span class="v">${esc(p.org)}${p.tel ? " · " + esc(p.tel) : ""}</span></div>
      <div class="contact-row"><span class="k">공람기간</span><span class="v">${esc(p.period)}${p.dday !== null ? ` (D-${p.dday})` : ""}</span></div>
    </div>
    ${eiaHtml(p)}
    <p style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
      ${p.lat != null ? `<button class="btn btn--line btn--sm" type="button" data-onmap="${esc(p.id)}">지도에서 보기</button>` : ""}
      ${p.sourceBizCd ? `<button class="btn btn--line btn--sm" type="button" data-eiass="${esc(p.id)}">EIASS 원문 페이지 열기 ↗</button>` : ""}
    </p>`;
  openModal("m-detail");
}
$("#detailBody").addEventListener("click", e => {
  const s = e.target.closest("[data-eiass]");
  if(s){
    const p = PROJECTS.find(x => String(x.id) === String(s.dataset.eiass));
    if(p) openEiassSource(p);
    return;
  }
  const m = e.target.closest("[data-onmap]");
  if(m){
    closeModal($("#m-detail"));
    openMapScreen(m.dataset.onmap);
  }
});

$$("[data-filter]").forEach(c => c.addEventListener("click", () => {
  $$("[data-filter]").forEach(x => x.classList.remove("on"));
  c.classList.add("on");
  filter = c.dataset.filter;
  render();
}));
$("#sortBtn").addEventListener("click", () => {
  sortBy = sortBy === "dist" ? "dday" : "dist";
  $("#sortLabel").textContent = sortBy === "dist" ? "가까운 순" : "마감 임박 순";
  render();
});
function runSearch(){
  query = $("#q").value.trim();
  render();
  $("#projects").scrollIntoView({ behavior:"smooth", block:"start" });
}
$("#btn-search").addEventListener("click", runSearch);
$("#q").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); runSearch(); } });
$$("[data-kw]").forEach(b => b.addEventListener("click", () => { $("#q").value = b.dataset.kw; runSearch(); }));
$("#btn-focus-search").addEventListener("click", () => $("#q").focus());

/* ============================================================
   지도 — 공통
   ============================================================ */
function vworldTileUrl(){
  return `https://api.vworld.kr/req/wmts/1.0.0/${S.vworldKey}/Base/{z}/{y}/{x}.png`;
}
function markerIcon(type, on){
  return L.divIcon({
    className: "",
    iconSize: [15, 15],
    iconAnchor: [7, 7],
    html: `<div class="mk mk--${type}${on ? " mk--on" : ""}"></div>`
  });
}
function mapGuideHtml(title, desc){
  return `
    <div class="map-guide">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"></path><path d="M9 4v14M15 6v14"></path></svg></div>
      <h4>${esc(title)}</h4>
      <p>${esc(desc)}</p>
    </div>`;
}

/* ============================================================
   지도 화면 (전체화면)
   ============================================================ */
let gisMap = null, gisMarkers = new Map(), gisHomeMarker = null, gisCircle = null;
let selectedId = null;

function gisProjects(){
  const rows = (mapNearbyOnly ? nearbyProjects() : PROJECTS).filter(p => p.lat != null);
  return rows.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
}

function ensureGisMap(){
  if(gisMap || typeof L === "undefined") return gisMap;
  const box = $("#gisMap");
  box.innerHTML = "";
  gisMap = L.map("gisMap", { zoomControl:true, attributionControl:true });
  L.tileLayer(vworldTileUrl(), { maxZoom:19, attribution:"ⓒ VWorld" }).addTo(gisMap);
  gisMap.setView([HOME.lat, HOME.lon], 12);
  return gisMap;
}

function renderGisMarkers(fit = true){
  if(!gisMap) return;
  gisMarkers.forEach(m => gisMap.removeLayer(m));
  gisMarkers = new Map();
  if(gisHomeMarker){ gisMap.removeLayer(gisHomeMarker); gisHomeMarker = null; }
  if(gisCircle){ gisMap.removeLayer(gisCircle); gisCircle = null; }

  gisHomeMarker = L.marker([HOME.lat, HOME.lon], { icon:markerIcon("home"), zIndexOffset:1000 })
    .addTo(gisMap).bindTooltip(HOME.label || "우리 집");
  gisCircle = L.circle([HOME.lat, HOME.lon], {
    radius: S.radiusKm * 1000, color:"#1c47d4", weight:1.4,
    dashArray:"5 5", fillColor:"#1c47d4", fillOpacity:.05
  }).addTo(gisMap);

  const rows = gisProjects();
  rows.forEach(p => {
    const m = L.marker([p.lat, p.lon], { icon:markerIcon(p.type, p.id === selectedId) })
      .addTo(gisMap)
      .bindTooltip(p.name, { direction:"top" });
    m.on("click", () => selectProject(p.id, false));
    gisMarkers.set(String(p.id), m);
  });

  if(fit){
    const pts = [[HOME.lat, HOME.lon], ...rows.map(p => [p.lat, p.lon])];
    if(pts.length > 1) gisMap.fitBounds(pts, { padding:[50, 50] });
    else gisMap.setView([HOME.lat, HOME.lon], 13);
  }
}

function gisItemHtml(p){
  return `
    <button class="gis-item${p.id === selectedId ? " on" : ""}" type="button" data-gis="${esc(p.id)}">
      <span class="badge ${p.badge} badge--dot" style="align-self:flex-start">${esc(p.typeLabel)}</span>
      <span class="t">${esc(p.name)}</span>
      <span class="m">${p.dist != null ? p.dist.toFixed(1) + "km" : "거리 모름"}${p.dday !== null ? ` · D-${p.dday}` : ""}</span>
    </button>`;
}

/* 왼쪽 목록 — 내 주소 기준으로 '우리 동네'와 '그 밖의 지역'을 나눠 보여준다. */
function renderGisList(){
  const rows = gisProjects();
  const near = rows.filter(isNearby);
  const far = rows.filter(p => !isNearby(p));
  const box = $("#gisList");
  const hoodName = HOME.label || "내 동네";

  let html = `<p class="gis-list-head">${esc(hoodName)} 반경 ${esc(S.radiusKm)}km · ${near.length}건</p>`;
  html += near.length
    ? near.map(gisItemHtml).join("")
    : `<p class="gis-empty">이 주소 반경 ${esc(S.radiusKm)}km 안에는
        공람 중인 사업이 없습니다.${far.length ? "<br>아래 '그 밖의 지역'에서 확인해 보세요." : ""}</p>`;

  if(far.length){
    html += `<p class="gis-list-head gis-list-head--out">그 밖의 지역 · ${far.length}건</p>`;
    html += far.map(gisItemHtml).join("");
  }else if(mapNearbyOnly){
    html += `<p class="gis-empty">위쪽 '내 동네 반경만' 체크를 풀면 전국 사업이 보입니다.</p>`;
  }
  box.innerHTML = html;
}
$("#gisList").addEventListener("click", e => {
  const b = e.target.closest("[data-gis]");
  if(b) selectProject(b.dataset.gis, true);
});

function renderGisDetail(){
  const box = $("#gisDetail");
  const p = PROJECTS.find(x => String(x.id) === String(selectedId));
  if(!p){
    box.innerHTML = `<p class="gis-detail-empty">지도에서 사업 위치를 누르거나<br>왼쪽 목록에서 사업을 고르면<br>여기에 내용이 나옵니다.</p>`;
    return;
  }
  box.innerHTML = `
    <span class="badge ${p.badge} badge--dot">${esc(p.typeLabel)}</span>
    ${p.dday !== null ? `<span class="badge ${p.dday <= 3 ? "badge--live" : "badge--dday"}" style="margin-left:6px">D-${p.dday}</span>` : ""}
    <p class="ttl">${esc(p.name)}</p>
    <div class="kv"><span class="k">위치</span><span class="v">${esc(p.where)}</span></div>
    <div class="kv"><span class="k">거리</span><span class="v">${p.dist != null ? "우리 집에서 " + p.dist.toFixed(1) + "km" : "모름"}</span></div>
    <div class="kv"><span class="k">공람</span><span class="v">${esc(p.period)}</span></div>
    <div class="kv"><span class="k">기관</span><span class="v">${esc(p.org)}${p.tel ? "<br>" + esc(p.tel) : ""}</span></div>
    ${eiaHtml(p)}
    ${p.sourceBizCd ? `
      <button class="eiass-link" type="button" data-eiass-side="${esc(p.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>
        EIASS 원문 페이지 열기
      </button>` : ""}`;
}
$("#gisDetail").addEventListener("click", e => {
  const b = e.target.closest("[data-eiass-side]");
  if(!b) return;
  const p = PROJECTS.find(x => String(x.id) === String(b.dataset.eiassSide));
  if(p) openEiassSource(p);
});

function selectProject(id, moveMap){
  selectedId = String(id);
  // 마커 강조를 위해 아이콘만 갈아끼운다
  gisMarkers.forEach((m, key) => {
    const p = PROJECTS.find(x => String(x.id) === key);
    if(p) m.setIcon(markerIcon(p.type, key === selectedId));
  });
  const p = PROJECTS.find(x => String(x.id) === selectedId);
  if(p && gisMap && moveMap && p.lat != null){
    gisMap.setView([p.lat, p.lon], Math.max(gisMap.getZoom(), 13), { animate:true });
  }
  renderGisList();
  renderGisDetail();
}

function openMapScreen(focusId){
  show("#scr-map");
  mapHood.set(currentHood);      // 왼쪽 주소 칸을 지금 보고 있는 동네로 맞춘다
  if(!S.vworldKey){
    $("#gisMap").innerHTML = mapGuideHtml(
      "VWorld 인증키가 아직 등록되지 않았습니다",
      "vworld.kr에서 인증키를 발급받아 관리자 설정에 등록하면 지도가 표시됩니다."
    );
    renderGisList();
    renderGisDetail();
    return;
  }
  ensureGisMap();
  renderGisMarkers(!focusId);
  renderGisList();
  if(focusId) selectProject(focusId, true);
  else renderGisDetail();
  setTimeout(() => { if(gisMap) gisMap.invalidateSize(); }, 60);
}

$("#btn-openmap").addEventListener("click", () => openMapScreen());
$("#btn-map-back").addEventListener("click", () => {
  show("#scr-home");
  renderMiniMap();
});
$("#mapNearbyOnly").addEventListener("change", e => {
  mapNearbyOnly = e.target.checked;
  selectedId = null;
  renderGisMarkers(true);
  renderGisList();
  renderGisDetail();
});

/* 지도 화면에서 주소를 바꾸면 그 주소로 지도를 옮기고 목록을 다시 계산한다. */
$("#btn-map-addr").addEventListener("click", async () => {
  const btn = $("#btn-map-addr");
  const hood = mapHood.get();
  btn.disabled = true;
  btn.textContent = "주소를 찾고 있어요…";
  await resolveHome(hood);
  pushRecent(hood);
  btn.disabled = false;
  btn.textContent = "이 주소로 보기";
  if(!HOME.exact){
    $("#gisList").insertAdjacentHTML("afterbegin",
      `<p class="gis-empty">주소의 좌표를 찾지 못해 기준 위치를 옮기지 못했습니다.</p>`);
  }
});

/* ============================================================
   홈 화면 미니 지도 — 우리 동네 수준으로 보여주는 미리보기
   ============================================================ */
let miniMap = null, miniLayers = [];

function renderMiniMap(){
  const canvas = $("#miniMapCanvas");
  if(!canvas) return;

  if(!S.vworldKey){
    canvas.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;
      font-size:12.5px;color:var(--ink-3);text-align:center;padding:0 20px">
      VWorld 인증키를 등록하면<br>여기에 실제 지도가 표시됩니다</div>`;
    return;
  }
  if(typeof L === "undefined") return;
  // 홈 화면이 안 보이는 상태(크기 0)에서 그리면 축척이 엉뚱하게 잡힌다.
  // 화면이 보이게 될 때 다시 호출되므로 여기서는 건너뛴다.
  if(!canvas.offsetWidth) return;

  if(!miniMap){
    canvas.innerHTML = "";
    miniMap = L.map("miniMapCanvas", {
      zoomControl:false, dragging:false, scrollWheelZoom:false, doubleClickZoom:false,
      boxZoom:false, keyboard:false, attributionControl:false, tap:false
    });
    L.tileLayer(vworldTileUrl(), { maxZoom:19 }).addTo(miniMap);
    miniMap.setView([HOME.lat, HOME.lon], 13);   // 레이어를 올리기 전에 기준 시점을 먼저 정한다
  }
  miniMap.invalidateSize();

  miniLayers.forEach(l => miniMap.removeLayer(l));
  miniLayers = [];

  miniLayers.push(L.marker([HOME.lat, HOME.lon], { icon:markerIcon("home") }).addTo(miniMap));
  miniLayers.push(L.circle([HOME.lat, HOME.lon], {
    radius: S.radiusKm * 1000, color:"#1c47d4", weight:1.4,
    dashArray:"5 5", fillColor:"#1c47d4", fillOpacity:.06
  }).addTo(miniMap));

  nearbyProjects().forEach(p => {
    miniLayers.push(L.marker([p.lat, p.lon], { icon:markerIcon(p.type) }).addTo(miniMap));
  });

  // 우리 동네가 보이는 정도의 축척 — 반경 원이 화면에 꽉 차게.
  // (지도 없이 계산되는 toBounds 를 써서 초기화 순서에 상관없이 안전하게)
  miniMap.fitBounds(L.latLng(HOME.lat, HOME.lon).toBounds(S.radiusKm * 2000), { padding:[6, 6] });
}

/* ============================================================
   관리자
   ============================================================ */
function enterAdmin(){
  show("#scr-admin");
  $("#admLock").hidden = false;
  $("#admPanel").hidden = true;
  $("#admPw").value = "";
  $("#admErr").textContent = "";
  setTimeout(() => $("#admPw").focus(), 60);
}
$("#btn-admin-enter").addEventListener("click", enterAdmin);
$("#btn-admin-exit").addEventListener("click", () => show("#scr-onboard"));

function unlock(){
  if($("#admPw").value === S.adminPw){
    $("#admLock").hidden = true;
    $("#admPanel").hidden = false;
    fillAdmin();
  }else{
    $("#admErr").textContent = "비밀번호가 맞지 않습니다.";
  }
}
$("#admGo").addEventListener("click", unlock);
$("#admPw").addEventListener("keydown", e => { if(e.key === "Enter") unlock(); });

function fillAdmin(){
  $("#a-vworld").value      = S.vworldKey;
  $("#a-service-url").value = S.serviceUrl;
  $("#a-lon").value         = S.centerLon;
  $("#a-lat").value         = S.centerLat;
  $("#a-datapath").value    = S.dataPath;
  $("#a-radius").value      = S.radiusKm;
  $("#a-demo").checked      = S.showDemoBanner;
  $("#a-org").value         = S.org;
  $("#a-person").value      = S.person;
  $("#a-tel").value         = S.tel;
  $("#a-d-sido").value      = S.defHood.sido;
  $("#a-d-sgg").value       = S.defHood.sgg;
  $("#a-d-dong").value      = S.defHood.dong;
  $("#a-pw").value          = S.adminPw;
  ["1","2","3"].forEach((n, i) => {
    $(`#a-n${n}-k`).value = S.nation[i].k;
    $(`#a-n${n}-v`).value = S.nation[i].v;
  });
}

$("#admSave").addEventListener("click", () => {
  S.vworldKey      = $("#a-vworld").value.trim();
  S.serviceUrl     = $("#a-service-url").value.trim();
  S.centerLon      = $("#a-lon").value.trim() || DEFAULTS.centerLon;
  S.centerLat      = $("#a-lat").value.trim() || DEFAULTS.centerLat;
  S.dataPath       = $("#a-datapath").value.trim() || DEFAULTS.dataPath;
  S.radiusKm       = +$("#a-radius").value || DEFAULTS.radiusKm;
  S.showDemoBanner = $("#a-demo").checked;
  S.org            = $("#a-org").value.trim();
  S.person         = $("#a-person").value.trim();
  S.tel            = $("#a-tel").value.trim();
  S.defHood        = { sido:$("#a-d-sido").value.trim(), sgg:$("#a-d-sgg").value.trim(), dong:$("#a-d-dong").value.trim() };
  S.adminPw        = $("#a-pw").value || DEFAULTS.adminPw;
  S.nation         = ["1","2","3"].map(n => ({
    k: $(`#a-n${n}-k`).value.trim(),
    v: $(`#a-n${n}-v`).value.trim(),
    u: "건"
  }));

  const ok = lsSet(LSKEY, S);
  applySettings();
  if(dataReady) refreshAll();
  const tag = $("#admSaved");
  tag.textContent = ok ? "저장되었습니다" : "이 브라우저에는 저장할 수 없어 이번만 적용됩니다";
  tag.classList.add("on");
  setTimeout(() => tag.classList.remove("on"), 2600);
});

$("#admReset").addEventListener("click", () => {
  if(!confirm("모든 설정을 기본값으로 되돌립니다. 계속할까요?")) return;
  try{ localStorage.removeItem(LSKEY); }catch(e){}
  S = Object.assign({}, DEFAULTS);
  fillAdmin();
  applySettings();
});

/* ============================================================
   부가 동작
   ============================================================ */
let io;
function startReveal(){
  if(io) io.disconnect();
  io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if(en.isIntersecting){
        const d = parseInt(en.target.dataset.delay || 0, 10);
        setTimeout(() => en.target.classList.add("in"), d);
        io.unobserve(en.target);
      }
    });
  }, { threshold:.12 });
  $$("#scr-home .reveal").forEach(el => io.observe(el));
}
function countUp(){
  $$("[data-count]").forEach(el => {
    const target = +el.dataset.count, dur = 850, t0 = performance.now();
    (function step(t){
      const k = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString();
      if(k < 1) requestAnimationFrame(step);
    })(t0);
  });
}
const tt = $("#totop");
addEventListener("scroll", () => tt.classList.toggle("show", scrollY > 600), { passive:true });
tt.addEventListener("click", () => scrollTo({ top:0, behavior:"smooth" }));

/* 지도 화면은 키보드로도 열 수 있게 */
$("#miniMap").addEventListener("click", () => openMapScreen());
$("#miniMap").addEventListener("keydown", e => {
  if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openMapScreen(); }
});

applySettings();
loadRegions();
loadProjects();
