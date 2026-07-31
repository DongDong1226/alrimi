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
   표본 데이터 — 실제 서비스에서는 data/projects.json 으로 분리
   ============================================================ */
const PROJECTS = [
  { id:1, type:"main",  typeLabel:"환경영향평가",       badge:"badge--blue",
    name:"미사강변 도시개발사업 3단계", stage:"초안 공람 중", dday:3, dist:1.4, opinions:12,
    desc:"공동주택 2,400세대 · 사업면적 38만㎡", where:"하남시 미사동 일원", org:"경기도시공사" },
  { id:2, type:"small", typeLabel:"소규모 환경영향평가", badge:"badge--orange",
    name:"▽▽물류단지 조성사업", stage:"초안 공람 중", dday:8, dist:3.2, opinions:3,
    desc:"창고시설 · 사업면적 6.2만㎡", where:"하남시 감일동 일원", org:"민간사업자" },
  { id:3, type:"strat", typeLabel:"전략환경영향평가",   badge:"badge--navy",
    name:"하남 교산지구 진입도로 개설사업", stage:"협의 진행 중", dday:null, dist:2.1, opinions:0,
    desc:"도로 연장 3.4km · 왕복 4차로", where:"하남시 교산동 일원", org:"한국토지주택공사" },
  { id:4, type:"post",  typeLabel:"사후환경영향조사",   badge:"badge--teal",
    name:"미사대로 확장공사", stage:"공사 중 조사", dday:null, dist:0.9, opinions:0,
    desc:"소음·비산먼지 분기 조사 결과 공개", where:"하남시 미사동 일원", org:"하남시청" },
  { id:5, type:"main",  typeLabel:"환경영향평가",       badge:"badge--blue",
    name:"△△근린공원 조성사업", stage:"협의 완료", dday:null, dist:2.6, opinions:7,
    desc:"근린공원 4.1만㎡ · 착공 예정", where:"하남시 덕풍동 일원", org:"하남시청" }
];

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
   지도 모달
   VWorld Static Map API — 인증키가 있으면 실제 지도 이미지,
   없으면 안내 문구.
   ※ 파라미터명은 vworld.kr 의 Static Map API 레퍼런스에서
     최종 확인 후 조정하세요.
   ============================================================ */
function vworldStaticUrl(){
  const markers = PROJECTS
    .map(p => `point:${S.centerLon} ${S.centerLat}|label:${encodeURIComponent(p.id)}`)
    .join("&marker=");
  const q = new URLSearchParams({
    service: "image",
    request: "getmap",
    key: S.vworldKey,
    format: "png",
    basemap: "GRAPHIC",
    crs: "EPSG:4326",
    center: `${S.centerLon},${S.centerLat}`,
    zoom: "14",
    size: "1000,620"
  });
  return `https://api.vworld.kr/req/image?${q}&marker=${markers}`;
}

function openMap(){
  const box = $("#mapBox");
  if(!S.vworldKey){
    box.innerHTML = `
      <div class="map-guide">
        <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"></path><path d="M9 4v14M15 6v14"></path></svg></div>
        <h4>VWorld 인증키가 아직 등록되지 않았습니다</h4>
        <p>vworld.kr에서 인증키를 발급받아 관리자 설정에 등록하면, 이 자리에 실제 지도와 사업 위치가 표시됩니다.</p>
      </div>`;
  }else{
    box.innerHTML = `<img alt="우리 동네 개발사업 위치 지도" src="${vworldStaticUrl()}">`;
    box.querySelector("img").addEventListener("error", () => {
      box.innerHTML = `
        <div class="map-guide">
          <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><circle cx="12" cy="16.3" r=".7" fill="currentColor"></circle></svg></div>
          <h4>지도를 불러오지 못했습니다</h4>
          <p>인증키가 승인 상태인지, 발급 시 등록한 서비스 URL과 지금 접속한 주소가 같은지 확인해 주세요.</p>
        </div>`;
    });
  }
  openModal("m-map");
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

function render(){
  let rows = PROJECTS.filter(p => filter === "all" || p.type === filter);
  if(query){
    const q = query.toLowerCase();
    rows = rows.filter(p => (p.name + p.typeLabel + p.desc).toLowerCase().includes(q));
  }
  rows.sort((a, b) => sortBy === "dist"
    ? a.dist - b.dist
    : (a.dday === null) - (b.dday === null) || (a.dday ?? 999) - (b.dday ?? 999));

  const grid = $("#projGrid");
  if(!rows.length){
    grid.innerHTML = `<p class="proj-empty">조건에 맞는 사업이 없습니다. 다른 유형을 눌러보세요.</p>`;
    return;
  }
  grid.innerHTML = rows.map(p => `
    <article class="proj">
      <div class="badges">
        <span class="badge ${p.badge} badge--dot">${p.typeLabel}</span>
        ${p.dday !== null
          ? `<span class="badge ${p.dday <= 3 ? "badge--live" : "badge--dday"}">D-${p.dday}</span>`
          : `<span class="badge badge--line">${p.stage}</span>`}
      </div>
      <p class="ttl">${p.name}</p>
      <p class="desc">${p.desc}</p>
      <div class="rows">
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"></path><circle cx="12" cy="10" r="2.4"></circle></svg><span>${p.where} · 우리 집에서 ${p.dist}km</span></div>
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"></path><path d="M15 3v4h4"></path></svg><span>${p.org} · ${p.stage}${p.opinions ? ` · 주민 의견 ${p.opinions}건` : ""}</span></div>
      </div>
      <div class="foot">
        ${p.dday !== null ? `<button class="btn btn--primary btn--sm btn--pill" type="button">의견 제출</button>` : ``}
        <button class="btn btn--line btn--sm btn--pill" type="button">자세히 보기</button>
      </div>
    </article>`).join("");
}

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
