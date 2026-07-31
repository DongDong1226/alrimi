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
  radiusKm: 3,
  showDemoBanner: true,
  org: "기후·에너지환경부 국립환경과학원",
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

/* ============================================================
   사업 데이터
   data/projects.json (tools/build_data.py가 EIASS에서 만든 실제 데이터)을
   불러온다. 불러오지 못하면(파일이 아직 없거나 서버 없이 file://로 열었을 때)
   화면 확인용 표본 데이터로 대신한다.
   ============================================================ */
const SAMPLE_PROJECTS = [
  { id:"sample-1", type:"main",  typeLabel:"환경영향평가",       badge:"badge--blue",
    name:"(표본) 미사강변 도시개발사업 3단계", stage:"초안 공람 중", dday:3, dist:1.4, opinions:0,
    desc:"공람기간 2026.08.01 ~ 2026.08.14", where:"하남시 미사동 일원", org:"경기도시공사", lat:null, lon:null, summaryEasy:null },
  { id:"sample-2", type:"strat", typeLabel:"전략환경영향평가",   badge:"badge--navy",
    name:"(표본) 하남 교산지구 진입도로 개설사업", stage:"초안 공람 중", dday:8, dist:2.1, opinions:0,
    desc:"공람기간 2026.08.01 ~ 2026.08.19", where:"하남시 교산동 일원", org:"한국토지주택공사", lat:null, lon:null, summaryEasy:null }
];

let PROJECTS = SAMPLE_PROJECTS;
const CATEGORY_BADGE = { strat:"badge--navy", main:"badge--blue" };

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* EIASS에서 수집한 원본 항목을 화면에서 쓰는 모양으로 바꾼다.
   여기서 실제 원문에 없는 값(예: 주민 의견 수)은 만들어내지 않고 0/없음으로 둔다. */
function normalizeProject(p){
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let dday = null, stage = "공람 종료";
  if(p.periodEnd){
    const end = new Date(p.periodEnd + "T00:00:00");
    const diff = Math.round((end - today) / 86400000);
    if(diff >= 0){ dday = diff; stage = "초안 공람 중"; }
  }
  const hasCoord = typeof p.lat === "number" && typeof p.lon === "number";
  const dist = hasCoord ? haversineKm(+S.centerLat, +S.centerLon, p.lat, p.lon) : null;
  return {
    id: p.id,
    type: p.category,
    typeLabel: p.categoryLabel || p.category,
    badge: CATEGORY_BADGE[p.category] || "badge--gray",
    name: p.name,
    stage,
    dday,
    dist,
    opinions: 0,
    desc: (p.periodStart && p.periodEnd) ? `공람기간 ${p.periodStart} ~ ${p.periodEnd}` : "공람기간 정보 없음",
    where: p.address || "위치 정보 없음",
    org: p.org || "기관 정보 없음",
    lat: hasCoord ? p.lat : null,
    lon: hasCoord ? p.lon : null,
    summaryEasy: p.summaryEasy || null
  };
}

async function loadProjects(){
  try{
    const res = await fetch(S.dataPath, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const list = Array.isArray(json.projects) ? json.projects : [];
    if(list.length){
      PROJECTS = list.map(normalizeProject);
    }
  }catch(e){
    console.warn("data/projects.json 을 불러오지 못해 표본 데이터를 표시합니다.", e);
    PROJECTS = SAMPLE_PROJECTS;
  }
  updateFilterCounts();
  updateDashboardStats();
  render();
  renderMapMarkers();
}

const REGION = {
  "서울특별시":["마포구","강남구","송파구","은평구","성동구"],
  "경기도":["하남시","성남시","남양주시","광주시","고양시"],
  "인천광역시":["서구","연수구","계양구"],
  "세종특별자치시":["한솔동","보람동","조치원읍"],
  "강원특별자치도":["강릉시","춘천시","원주시"],
  "충청남도":["보령시","천안시","아산시"]
};
const DONG = {
  "하남시":["미사동","덕풍동","신장동","감일동","위례동"],
  "마포구":["상암동","합정동","서교동","연남동"],
  "성남시":["분당동","수정동","중원동"],
  "강릉시":["교동","포남동","경포동"]
};
const SHORT = { "서울특별시":"서울","경기도":"경기","인천광역시":"인천",
  "세종특별자치시":"세종","강원특별자치도":"강원","충청남도":"충남" };

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ============================================================
   설정 적용
   ============================================================ */
function applySettings(){
  $("#nationRow").innerHTML = S.nation.map(n => `
    <div class="nation-i">
      <p class="v">${n.v}<small>${n.u || ""}</small></p>
      <p class="k">${n.k}</p>
    </div>`).join("");

  $("#demoBanner").hidden = !S.showDemoBanner;
  $("#v-radius").innerHTML = `${S.radiusKm}<small>km 이내</small>`;
  $("#h-radius").textContent = S.radiusKm;
  $("#c-org").textContent = S.org;
  $("#c-person").textContent = S.person;
  $("#c-tel").textContent = S.tel;
  $("#f-org").textContent = S.org;
  $("#f-tel").textContent = S.tel;
  renderRecent();
}

/* 최근 설정 동네 — 실제 이력 */
function renderRecent(){
  const row = $("#recentRow");
  row.querySelectorAll(".kw-chip").forEach(el => el.remove());
  let list = lsGet(LSRECENT, []);
  if(!list.length) list = [ S.defHood ];
  list.slice(0, 3).forEach(h => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kw-chip";
    b.textContent = `${SHORT[h.sido] || h.sido} ${h.sgg} ${h.dong}`;
    b.addEventListener("click", () => {
      selSido.value = h.sido; syncSgg(h.sgg); syncDong(h.dong);
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
   지역 셀렉트
   ============================================================ */
const selSido = $("#f-sido"), selSgg = $("#f-sgg"), selDong = $("#f-dong");
function fill(sel, arr, pick){
  sel.innerHTML = arr.map(v => `<option${v === pick ? " selected" : ""}>${v}</option>`).join("");
}
function syncSgg(pick){ fill(selSgg, REGION[selSido.value] || [], pick); syncDong(); }
function syncDong(pick){ fill(selDong, DONG[selSgg.value] || ["전체"], pick); }

fill(selSido, Object.keys(REGION), S.defHood.sido);
syncSgg(S.defHood.sgg); syncDong(S.defHood.dong);
selSido.addEventListener("change", () => syncSgg());
selSgg.addEventListener("change", () => syncDong());

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
  const hood = { sido:selSido.value, sgg:selSgg.value, dong:selDong.value };
  const dong = hood.dong === "전체" ? hood.sgg : hood.dong;
  const full = `${SHORT[hood.sido] || hood.sido} ${hood.sgg} ${hood.dong === "전체" ? "" : hood.dong}`.trim();

  $("#greet-name").textContent = name;
  $("#h-hood").textContent = dong;
  $("#hood-pill-label").textContent = full;
  $("#hood-card-name").textContent = full;

  pushRecent(hood);
  show("#scr-home");
  startReveal();
  countUp();
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
   지도 모달 — Leaflet + VWorld 2D 지도 API 타일
   인증키가 없으면 안내 문구만 표시한다.
   ============================================================ */
let leafletMap = null, leafletMarkers = [];

function showMapGuide(title, desc){
  $("#mapBox").innerHTML = `
    <div class="map-guide">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"></path><path d="M9 4v14M15 6v14"></path></svg></div>
      <h4>${title}</h4>
      <p>${desc}</p>
    </div>`;
}

function ensureLeafletMap(){
  if(leafletMap || typeof L === "undefined") return leafletMap;
  $("#mapBox").innerHTML = "";
  leafletMap = L.map("mapBox", { attributionControl:true });
  L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${S.vworldKey}/Base/{z}/{y}/{x}.png`, {
    maxZoom: 19,
    attribution: "ⓒ VWorld"
  }).addTo(leafletMap);
  return leafletMap;
}

function renderMapMarkers(){
  if(!leafletMap) return;
  leafletMarkers.forEach(m => leafletMap.removeLayer(m));
  leafletMarkers = [];

  const homeIcon = L.divIcon({ className:"", html:
    `<div style="width:16px;height:16px;border-radius:50%;background:#1f8a5b;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>` });
  const home = L.marker([+S.centerLat, +S.centerLon], { icon:homeIcon }).addTo(leafletMap).bindPopup("우리 집(기준 위치)");
  leafletMarkers.push(home);

  const withCoord = PROJECTS.filter(p => p.lat != null && p.lon != null);
  withCoord.forEach(p => {
    const marker = L.marker([p.lat, p.lon]).addTo(leafletMap);
    marker.bindPopup(`<b>${p.name}</b><br>${p.typeLabel} · ${p.stage}<br>${p.org}`);
    leafletMarkers.push(marker);
  });

  const boundsPoints = [[+S.centerLat, +S.centerLon], ...withCoord.map(p => [p.lat, p.lon])];
  if(boundsPoints.length > 1){
    leafletMap.fitBounds(boundsPoints, { padding:[30, 30] });
  }else{
    leafletMap.setView([+S.centerLat, +S.centerLon], 11);
  }
}

function openMap(){
  if(!S.vworldKey){
    showMapGuide(
      "VWorld 인증키가 아직 등록되지 않았습니다",
      "vworld.kr에서 인증키를 발급받아 관리자 설정에 등록하면, 이 자리에 실제 지도와 사업 위치가 표시됩니다."
    );
    openModal("m-map");
    return;
  }
  openModal("m-map");
  ensureLeafletMap();
  renderMapMarkers();
  setTimeout(() => { if(leafletMap) leafletMap.invalidateSize(); }, 80);
}
$("#btn-openmap").addEventListener("click", openMap);
$("#miniMap").addEventListener("click", openMap);
$("#miniMap").addEventListener("keydown", e => {
  if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openMap(); }
});
$("#btn-map-admin").addEventListener("click", () => {
  closeModal($("#m-map"));
  enterAdmin();
});

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
   사업 목록
   ============================================================ */
let filter = "all", sortBy = "dist", query = "";

function updateFilterCounts(){
  const counts = { all: PROJECTS.length };
  PROJECTS.forEach(p => { counts[p.type] = (counts[p.type] || 0) + 1; });
  $$("[data-filter]").forEach(chip => {
    const cnt = chip.querySelector(".cnt");
    if(cnt) cnt.textContent = counts[chip.dataset.filter] || 0;
  });
}

function updateDashboardStats(){
  const openList = PROJECTS.filter(p => p.dday !== null);
  $("#stat-total").dataset.count = PROJECTS.length;
  $("#stat-open").dataset.count = openList.length;
  $("#h-count").textContent = PROJECTS.length;

  $("#stat-total-note").textContent = "";
  if(openList.length){
    const minDday = Math.min(...openList.map(p => p.dday));
    $("#stat-open-note").innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6"></path><path d="M12 16.5v.5"></path></svg>가장 빠른 마감 D-${minDday}`;
  }else{
    $("#stat-open-note").textContent = "";
  }
  // 설명회·협의현황은 아직 수집하지 않아 0으로 둔다 (지어내지 않음).
}

function render(){
  let rows = PROJECTS.filter(p => filter === "all" || p.type === filter);
  if(query){
    const q = query.toLowerCase();
    rows = rows.filter(p => (p.name + p.typeLabel + p.desc).toLowerCase().includes(q));
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

  const grid = $("#projGrid");
  if(!rows.length){
    grid.innerHTML = `<p class="proj-empty">조건에 맞는 사업이 없습니다. 다른 유형을 눌러보세요.</p>`;
    return;
  }
  grid.innerHTML = rows.map(p => `
    <article class="proj" data-id="${p.id}">
      <div class="badges">
        <span class="badge ${p.badge} badge--dot">${p.typeLabel}</span>
        ${p.dday !== null
          ? `<span class="badge ${p.dday <= 3 ? "badge--live" : "badge--dday"}">D-${p.dday}</span>`
          : `<span class="badge badge--line">${p.stage}</span>`}
      </div>
      <p class="ttl">${p.name}</p>
      <p class="desc">${p.desc}</p>
      <div class="rows">
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"></path><circle cx="12" cy="10" r="2.4"></circle></svg><span>${p.where}${p.dist != null ? " · 우리 집에서 " + p.dist.toFixed(1) + "km" : ""}</span></div>
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"></path><path d="M15 3v4h4"></path></svg><span>${p.org} · ${p.stage}</span></div>
      </div>
      <div class="foot">
        ${p.dday !== null ? `<button class="btn btn--primary btn--sm btn--pill" type="button">의견 제출</button>` : ``}
        <button class="btn btn--line btn--sm btn--pill" type="button" data-detail="${p.id}">자세히 보기</button>
      </div>
    </article>`).join("");
}

function openDetail(id){
  const p = PROJECTS.find(x => String(x.id) === String(id));
  if(!p) return;
  $("#m-detail-t").textContent = p.name;
  $("#detailBody").innerHTML = `
    <div class="contact-card" style="margin-bottom:16px">
      <div class="contact-row"><span class="k">유형</span><span class="v">${p.typeLabel}</span></div>
      <div class="contact-row"><span class="k">위치</span><span class="v">${p.where}</span></div>
      <div class="contact-row"><span class="k">협의기관</span><span class="v">${p.org}</span></div>
      <div class="contact-row"><span class="k">공람기간</span><span class="v">${p.desc}</span></div>
    </div>
    <h4>환경영향 요약 (AI가 평가서 요약문을 쉬운 말로 옮긴 것)</h4>
    ${p.summaryEasy
      ? `<div style="white-space:pre-wrap;line-height:1.7">${p.summaryEasy}</div>`
      : `<p style="color:var(--ink-3)">아직 쉬운말 요약이 만들어지지 않았습니다.</p>`}
  `;
  openModal("m-detail");
}
$("#projGrid").addEventListener("click", e => {
  const btn = e.target.closest("[data-detail]");
  if(btn) openDetail(btn.dataset.detail);
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

applySettings();
render();
loadProjects();
