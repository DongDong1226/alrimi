/* ============================================================
   설정 기본값
   이 값들은 관리자 화면에서 덮어쓸 수 있고, 덮어쓴 값은
   localStorage 에 저장되어 다음 방문 때 우선 적용됩니다.
   ============================================================ */
/* 배포할 때 assets/config.js 에 채워지는 값. 내 PC 에서 열면 비어 있다.
   키 앞뒤 공백은 반드시 걷어낸다 — 공백이 하나만 붙어도 VWorld 지오코더가
   INVALID_KEY 로 거부한다(지도 타일은 그대로 나와서 원인을 찾기 어렵다). */
const BUILD = window.WDN_CONFIG || {};
const BUILD_VWORLD_KEY = String(BUILD.vworldKey || "").trim();

const DEFAULTS = {
  adminPw: "admin1234",
  vworldKey: BUILD_VWORLD_KEY,
  serviceUrl: "http://localhost:8000",
  centerLon: "127.1946",
  centerLat: "37.5636",
  dataPath: "data/projects.json",
  regionPath: "data/regions.json",
  routePath: "data/routes.json",
  sidoPath: "data/sido.json",      // 시·도 경계 (미리 단순화해 둔 것)
  radiusKm: 5,
  showDemoBanner: true,
  org: "기후에너지환경부 국립환경과학원",
  person: "김동윤",
  tel: "032-560-xxxx",
  // 처음 들어온 사람은 자기 동네를 아직 안 정했다. 전국을 먼저 보여주고 좁혀 가게 한다.
  // ("전국"/"전체"는 아래 ALL_SIDO/ANY 와 같은 값이다. 여기서는 아직 선언 전이라 글자로 적는다)
  defHood: { sido:"전국", sgg:"전체", dong:"전체" }
};

/* 반경 고르는 칸에 넣을 값 (km) */
const RADIUS_STEPS = [1, 2, 3, 5, 10, 20];

/* 동네를 안 정했을 때(전국) 지도가 바라볼 자리 — 남한이 한눈에 들어오는 지점 */
const KOREA_CENTER = [36.3, 127.8];

const LSKEY = "wdn.settings";
const LSRECENT = "wdn.recent";
/* 주민이 별표로 담아 둔 사업 번호 목록.
   계정이 없는 서비스라 **이 브라우저에만** 남는다 — 폰에서 담은 것이 PC에 나오지 않는다.
   고칠 수 있는 문제가 아니라(회원가입·서버가 필요하다) 화면에서 그 사실을 알려 준다. */
const LSSAVED = "wdn.saved";

function lsGet(k, fb){
  try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
  catch(e){ return fb; }
}
function lsSet(k, v){
  try{ localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch(e){ return false; }
}

/* ---------- 담아 둔 사업 ----------
   저장하는 것은 사업 번호뿐이다. 사업 내용은 매번 data/projects.json 에서 다시 읽는다
   (내용까지 저장해 두면 기간이 연장돼도 옛 날짜를 계속 보여주게 된다). */
let SAVED_IDS = lsGet(LSSAVED, []).map(String);

/* ============================================================
   마감일을 캘린더에 넣기 (.ics / 구글 캘린더)

   ■ 왜 캘린더인가
     이 서비스의 존재 이유가 "의견을 낼 수 있는 동안 알려 주는 것"인데,
     정작 **알림을 보낼 수단이 없다**. 웹 푸시는 서버가 필요하고,
     아이폰은 홈 화면에 추가까지 해야 한다 — 서버 0원·개인정보 0건이 깨진다.
     캘린더에 넣어 두면 **폰이 알아서 알려 준다.** 우리는 아무것도 안 해도 된다.

   ■ 두 가지 길을 다 준다 (기기마다 편한 쪽이 다르다)
     · .ics 파일 내려받기 — 아이폰·PC 에서 매끄럽다. **미리 알림도 넣을 수 있다**
     · 구글 캘린더 링크  — **갤럭시(안드로이드)에서 이쪽이 훨씬 편하다.**
       파일을 받아 '어떤 앱으로 열까' 고를 필요 없이 바로 일정 추가 화면이 뜬다
   ============================================================ */

/* 캘린더 파일에서 쉼표·세미콜론·줄바꿈은 뜻이 있는 글자라 지워 준다 */
function icsEsc(s){
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
/* "2026-08-19" → "20260819" */
function icsDate(iso){ return String(iso || "").replace(/-/g, ""); }
/* 하루 뒤 (온종일 일정은 끝날짜를 하루 뒤로 적는 규칙이다) */
function nextDay(iso){
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + 1);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/* 캘린더에 넣을 날짜 — 의견 제출 마감일. 없으면 공람 종료일을 대신 쓴다. */
function calDeadline(p){
  if(p.opinionEnd) return p.opinionEnd;
  const m = /~\s*(\d{4})-(\d{2})-(\d{2})/.exec(p.period || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function calText(p){
  return [
    `사업: ${p.name}`,
    `유형: ${p.typeLabel}`,
    `위치: ${p.where}`,
    `기관: ${p.org}`,
    `공람기간: ${p.period}`,
    p.opinionEnd ? `의견 제출 마감: ${p.opinionEnd}` : "",
    "",
    "의견은 EIASS(환경영향평가 정보지원시스템)에서 본인인증 후 제출합니다.",
    "https://www.eiass.go.kr/",
    "",
    "우리동네 개발사업 알리미에서 담은 일정입니다."
  ].filter(Boolean).join("\n");
}

/* 여러 사업을 한 파일에 담는다 (담은 사업을 한 번에 넣을 때 쓴다) */
function buildIcs(list){
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//우리동네 개발사업 알리미//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:우리동네 개발사업 의견 마감"
  ];
  list.forEach(p => {
    const day = calDeadline(p);
    if(!day) return;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEsc(p.id)}@alrimi`,
      `DTSTAMP:${icsDate(todayStr())}T000000Z`,
      `DTSTART;VALUE=DATE:${icsDate(day)}`,
      `DTEND;VALUE=DATE:${nextDay(day)}`,     // 온종일 일정은 끝날짜가 하루 뒤다
      `SUMMARY:[의견 마감] ${icsEsc(p.name)}`,
      `DESCRIPTION:${icsEsc(calText(p))}`,
      `LOCATION:${icsEsc(p.where)}`,
      // 미리 알림 — 사흘 전 아침 9시, 그리고 당일 아침 9시
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P3DT15H",
      `DESCRIPTION:${icsEsc(p.name)} 의견 제출 마감 3일 전`, "END:VALARM",
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15H",
      `DESCRIPTION:${icsEsc(p.name)} 의견 제출 오늘 마감`, "END:VALARM",
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  // 캘린더 파일은 줄바꿈이 CRLF 여야 한다 (일부 앱이 LF 만 있으면 못 읽는다)
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/* 한 줄이 75바이트를 넘으면 접어야 한다 (iCalendar 규격).
   사업명이 길고 한글은 한 글자가 3바이트라 대부분 넘는다 —
   접지 않으면 까다로운 캘린더 앱이 파일을 통째로 못 읽는다.
   이어지는 줄은 **맨 앞에 공백 한 칸**을 넣어 표시하고,
   한글이 중간에 잘리지 않도록 글자 단위로 센다. */
function icsFold(line){
  const enc = new TextEncoder();
  if(enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "", curBytes = 0, limit = 75;
  for(const ch of line){
    const n = enc.encode(ch).length;
    if(curBytes + n > limit){
      out.push(cur);
      cur = " " + ch;            // 이어지는 줄은 공백으로 시작한다
      curBytes = 1 + n;
      limit = 75;
    }else{
      cur += ch; curBytes += n;
    }
  }
  if(cur) out.push(cur);
  return out.join("\r\n");
}

function downloadIcs(name, list){
  const rows = list.filter(p => calDeadline(p));
  if(!rows.length) return false;
  const blob = new Blob([buildIcs(rows)], { type:"text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

/* 구글 캘린더 '일정 추가' 화면을 바로 연다.
   갤럭시에서는 파일을 받아 여는 것보다 이쪽이 훨씬 매끄럽다. */
function googleCalUrl(p){
  const day = calDeadline(p);
  if(!day) return null;
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: `[의견 마감] ${p.name}`,
    dates: `${icsDate(day)}/${nextDay(day)}`,   // 온종일
    details: calText(p),
    location: p.where || "",
    ctz: "Asia/Seoul"
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/* ============================================================
   지역 캘린더 구독 — 새 사업이 뜨면 저절로 들어온다

   앞의 '캘린더에 넣기'는 **한 번 받으면 끝**이다. 구독은 다르다 —
   폰 캘린더가 주소를 기억해 두고 주기적으로 다시 받아 오므로,
   그 지역에 **새 사업이 뜨면 일정이 저절로 들어오고 알림도 온다.**
   우리는 파일만 올려 두면 된다 (build_data.py 가 지역마다 만든다).
   ============================================================ */
const CAL_BASE = "data/cal/";
const LSCALREGION = "wdn.calRegion";

/* ★ 구독 지역은 **보고 있는 동네와 따로 고른다.**
   읍·면·동까지 좁혀 놓고 보는 사람도, 알림은 시·군·구 전체로 받고 싶을 수 있다
   (옆 동네 사업도 우리 생활권이다). 그래서 이 칸에서 다시 고르게 한다.
   처음 값은 지금 보고 있는 동네를 따라간다.

   **고른 단계가 곧 받는 범위다** — 시·군·구까지만 고르면 그 시·군·구 전체가 오고,
   읍·면·동까지 고르면 그 동네 것만 온다. 그래서 세 칸을 다 보여 준다. */
let CAL_REGION = lsGet(LSCALREGION, null);

function calRegion(){
  if(CAL_REGION) return CAL_REGION;
  return isNation(currentHood)
    ? { sido:ALL_SIDO, sgg:ANY, dong:ANY }
    : { sido:currentHood.sido, sgg:hoodSgg(currentHood) || ANY,
        dong:hoodDong(currentHood) || ANY };
}

function setCalRegion(r){
  CAL_REGION = r;
  lsSet(LSCALREGION, r);
  renderCalSub();
}

/* 고른 지역에 맞는 캘린더 파일 이름.
   **고른 만큼만 좁힌다** — 읍·면·동을 안 골랐으면 시·군·구 파일, 시·군·구도 안 골랐으면 시·도 파일.
   이름 규칙은 build_data.py 의 cal_slug() 와 반드시 같아야 한다. */
function calFeedName(){
  const r = calRegion();
  if(!r.sido || r.sido === ALL_SIDO) return { file:"all.ics", label:"전국" };
  const slug = s => s.replace(/ /g, "-");
  const parts = [r.sido];
  if(r.sgg && r.sgg !== ANY) parts.push(r.sgg);
  // 읍·면·동은 시·군·구를 고른 뒤에만 뜻이 있다 (세종은 시·군·구가 없어 바로 이어진다)
  if(r.dong && r.dong !== ANY && (parts.length > 1 || !sggList(r.sido).length)) parts.push(r.dong);
  return { file:`${parts.map(slug).join("_")}.ics`, label:parts.join(" ") };
}

/* 구독 주소는 **절대 주소**여야 한다 — 캘린더 앱이 우리 페이지 밖에서 부르기 때문이다. */
function calFeedUrl(){
  const f = calFeedName();
  return { url:new URL(CAL_BASE + encodeURIComponent(f.file), location.href).href, label:f.label };
}

function renderCalSub(){
  const box = $("#calSub");
  if(!box || !box.classList) return;
  const r = calRegion();
  const { url, label } = calFeedUrl();
  // 아이폰은 webcal:// 을 누르면 구독 창이 바로 뜬다. 구글 캘린더는 cid= 로 받는다.
  const webcal = url.replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;

  const sidos = REGIONS ? Object.keys(REGIONS) : [];
  const sggs = (r.sido && r.sido !== ALL_SIDO) ? sggList(r.sido) : [];
  // 읍·면·동은 시·군·구를 고른 뒤에 열린다. 세종처럼 시·군·구가 없는 곳은 바로 열린다.
  const dongs = (r.sido && r.sido !== ALL_SIDO && (hoodSgg(r) || !sggs.length))
    ? dongList(r.sido, r.sgg) : [];
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`;

  // ★ PC 는 '구글 캘린더로 구독' 하나만 둔다.
  //   아이폰 구독(webcal:)은 PC 에서 열 앱이 없고, 주소 복사는 구글 단추가 하는 일을
  //   손으로 하는 것이라 셋을 나란히 두면 오히려 어느 것을 눌러야 할지 헷갈린다.
  //   휴대폰(m.html)은 기기마다 편한 길이 달라 셋을 그대로 둔다.
  const isPhone = document.body.classList.contains("m");

  box.innerHTML = `
    <p class="cal-t">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8Z"></path><path d="M13.7 21a2 2 0 0 1-3.4 0" stroke-linecap="round"></path></svg>
      새 사업이 뜨면 캘린더로 자동으로 받기
    </p>
    <p class="cal-h">한 번만 등록해 두면 <b>그 지역에 새 사업이 생길 때마다 폰 캘린더에 저절로 들어옵니다.</b>
      알림도 폰이 줍니다. 이 화면을 다시 안 열어도 됩니다.</p>

    <div class="cal-pick">
      <label class="cal-pick-lb" for="calSido">알림 받을 지역</label>
      <div class="cal-pick-row">
        <span class="msel"><select id="calSido" aria-label="알림 받을 시·도">
          ${opt(ALL_SIDO, r.sido)}${sidos.map(s => opt(s, r.sido)).join("")}
        </select></span>
        <span class="msel"><select id="calSgg" aria-label="알림 받을 시·군·구"${sggs.length ? "" : " disabled"}>
          ${opt(ANY, r.sgg)}${sggs.map(s => opt(s, r.sgg)).join("")}
        </select></span>
        <span class="msel"><select id="calDong" aria-label="알림 받을 읍·면·동"${dongs.length ? "" : " disabled"}>
          ${opt(ANY, r.dong)}${dongs.map(s => opt(s, r.dong)).join("")}
        </select></span>
      </div>
      <p class="cal-h cal-h--sub">보고 있는 동네와 <b>따로 고를 수 있습니다.</b>
        <b>고른 만큼만 옵니다</b> — 시·군·구까지만 고르면 그 시·군·구 전체가, 읍·면·동까지 고르면 그 동네 것만 옵니다.</p>
    </div>

    <p class="cal-now">지금 받는 지역 <b>${esc(label)}</b></p>
    <div class="cal-btns">
      <a class="btn btn--primary btn--sm btn--pill" href="${esc(google)}" target="_blank" rel="noopener">구글 캘린더로 구독 ↗</a>
      ${isPhone ? `
      <a class="btn btn--line btn--sm btn--pill" href="${esc(webcal)}">아이폰 · 캘린더 구독</a>
      <button class="btn btn--ghost btn--sm btn--pill" type="button" id="btnCalCopy">주소 복사</button>` : ``}
    </div>
    <p class="cal-h cal-h--sub" id="calSubMsg">${isPhone
      ? `아이폰은 <b>아이폰 · 캘린더 구독</b>, 갤럭시는 <b>구글 캘린더로 구독</b>이 가장 쉽습니다.`
      : `누르면 구글 캘린더에 <b>이 지역 달력이 추가</b>됩니다. 등록해 두면 새 사업이 저절로 들어옵니다.`}</p>`;

  // 위 칸을 바꾸면 아래 칸은 '전체'로 되돌린다.
  // (다른 시·도의 시·군·구나, 다른 시·군·구의 읍·면·동이 남으면 없는 파일을 가리키게 된다)
  $("#calSido").addEventListener("change", e => {
    setCalRegion({ sido:e.target.value, sgg:ANY, dong:ANY });
  });
  $("#calSgg").addEventListener("change", e => {
    setCalRegion({ sido:$("#calSido").value, sgg:e.target.value, dong:ANY });
  });
  $("#calDong").addEventListener("change", e => {
    setCalRegion({ sido:$("#calSido").value, sgg:$("#calSgg").value, dong:e.target.value });
  });
  $("#btnCalCopy").addEventListener("click", async () => {
    try{
      await navigator.clipboard.writeText(url);
      $("#calSubMsg").textContent = "주소를 복사했습니다. 캘린더 앱의 'URL로 추가'에 붙여넣으세요.";
    }catch(e){
      $("#calSubMsg").textContent = url;   // 복사가 막히면 눈으로 보고 옮길 수 있게 보여 준다
    }
  });
}

/* ---------- 새로 올라온 사업 ----------
   "의견을 낼 수 있는 동안 알려 주는 것"이 이 서비스의 존재 이유인데,
   주민이 다시 들어왔을 때 **그 사이에 새로 뜬 사업**을 못 보고 지나치면 소용이 없다.

   서버도 계정도 알림 권한도 쓰지 않는다 — **마지막으로 본 날짜만 이 브라우저에 적어 두고**,
   그보다 늦게 공람이 시작된 사업을 '새것'으로 본다.

   기준은 **우리가 그 사업을 처음 본 날(firstSeen)** 이다. build_data.py 가 적어 준다.
   공람 시작일(periodStart)이 아니다 — 그건 EIASS 쪽 사정이라 우리 화면에 나타난 날과 다르다.
   둘이 어긋나면 알림이 통째로 새는데, 어긋나는 경우가 실제로 둘 있다:
     · EIASS 가 공람이 시작된 뒤에 목록에 늦게 올리는 경우
     · **우리 수집이 하루라도 실패한 경우** (그날 몫이 다음 날 한꺼번에 들어온다)
   늦게 나타난 사업일수록 남은 기간이 짧다. 공람 시작일로 재면
   **가장 급한 사업이 가장 조용히** 들어온다.

   firstSeen 이 없으면 공람 시작일로 대신한다 — 이 기능을 넣기 전에 수집된 사업이 그렇다.
   (그때는 예전과 똑같이 동작한다. 값이 없다고 새것으로 몰지 않는다)

   ★ 처음 온 사람에게는 아무것도 새것으로 표시하지 않는다.
     41건이 전부 NEW 면 아무 뜻이 없다. 그래서 첫 방문에는 오늘 날짜를 적어 두기만 한다. */
const LSSEEN = "wdn.lastSeen";
let LAST_SEEN = lsGet(LSSEEN, null);

function todayStr(){
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 날짜는 YYYY-MM-DD 라 글자 그대로 견주면 된다 (앞자리부터 커지는 형식) */
function isNewProject(p){
  const seen = p.firstSeen || p.periodStart;   // 옛 자료에는 firstSeen 이 없다
  return Boolean(LAST_SEEN && seen && seen > LAST_SEEN);
}

/* 지금 보고 있는 범위 안에서 새로 올라온 사업 */
function newProjects(){
  return scopedProjects().filter(isNewProject);
}

/* 새 사업을 확인한 것으로 치고 표시를 지운다 */
function markSeen(){
  LAST_SEEN = todayStr();
  lsSet(LSSEEN, LAST_SEEN);
  renderNewBanner();
  if(dataReady) render();
}

function isSaved(id){ return SAVED_IDS.includes(String(id)); }

function toggleSaved(id){
  const key = String(id);
  SAVED_IDS = isSaved(key) ? SAVED_IDS.filter(x => x !== key) : SAVED_IDS.concat(key);
  lsSet(LSSAVED, SAVED_IDS);
  syncSavedUi();
  return isSaved(key);
}

let S = Object.assign({}, DEFAULTS, lsGet(LSKEY, {}));

/* ★ 옛 기본 동네('경기도 하남시 미사동')를 걷어낸다.
   2026-08-06 에 기본값을 '전국'으로 바꿨는데, 그 전에 한 번이라도 들어온 브라우저는
   설정에 옛 값이 저장돼 있어서 **새 기본값이 영영 안 먹는다**
   (저장된 설정이 DEFAULTS 를 덮어쓰기 때문). 그래서 그 값이면 지우고 새 기본값을 쓴다.
   관리자가 일부러 하남 미사동을 넣어 둔 경우도 같이 초기화되지만,
   그건 관리자 화면에서 다시 넣으면 된다. */
const LEGACY_DEF_HOOD = { sido:"경기도", sgg:"하남시", dong:"미사동" };
if(S.defHood && S.defHood.sido === LEGACY_DEF_HOOD.sido
   && S.defHood.sgg === LEGACY_DEF_HOOD.sgg && S.defHood.dong === LEGACY_DEF_HOOD.dong){
  S.defHood = Object.assign({}, DEFAULTS.defHood);
  lsSet(LSKEY, S);
}

/* 저장해 둔 키에 공백이 섞여 있으면 걷어낸다. 비어 있으면 배포에 심어 둔 키를 쓴다.
   (안 그러면 방문자에게 지도가 안 보인다) */
S.vworldKey = String(S.vworldKey || "").trim() || BUILD_VWORLD_KEY;

/* ============================================================
   화면에서 칸 찾기

   이 파일 하나가 **두 화면**을 움직인다 —
     index.html  … 데스크톱·태블릿
     m.html      … 휴대폰 전용
   두 화면은 배치가 완전히 다르고, 한쪽에만 있는 칸이 있다
   (예: 관리자 설정은 휴대폰 화면에 두지 않는다).

   그런데 없는 칸을 만지면 자바스크립트가 **그 자리에서 통째로 멈춘다.**
   화면 하나가 빈 채로 뜨는 것이다. 그래서 없는 칸을 찾으면
   '아무 일도 하지 않는 빈 자리'를 대신 돌려준다.
   ============================================================ */
const NO_EL = {
  textContent:"", innerHTML:"", value:"", placeholder:"", hidden:true,
  disabled:false, checked:false, scrollTop:0, offsetWidth:0,
  dataset:{}, style:{},
  classList:{ add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  addEventListener(){}, removeEventListener(){},
  focus(){}, click(){}, remove(){}, scrollIntoView(){}, insertAdjacentHTML(){},
  setAttribute(){}, getAttribute(){ return null; }, appendChild(){},
  closest(){ return null; },
  querySelector(){ return NO_EL; }, querySelectorAll(){ return []; }
};

/* 없는 칸은 한 번만 알려 준다. 오타로 없는 것인지, 이 화면에 원래 없는 것인지
   구분해야 할 때 개발자도구 콘솔에서 확인한다. */
const missingEls = new Set();
function $(s){
  const el = document.querySelector(s);
  if(el) return el;
  if(!missingEls.has(s)){
    missingEls.add(s);
    console.debug("[알리미] 이 화면에는 없는 칸:", s);
  }
  return NO_EL;
}
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
  { key:"overview", label:"사업개요" },
  { key:"air",      label:"대기 · 악취" },
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

let PROJECTS = [];          // 아직 의견을 낼 수 있는 사업 (화면에 보이는 것)
let CLOSED_PROJECTS = [];   // 기간이 지난 사업 (화면에서 빼지만, 참조되면 최소 정보만 보여준다)
let dataReady = false;
let usingSample = false;    // 실제 파일을 못 읽어 표본으로 대신하고 있는가
/* 협의 진행 중인 사업 수 — EIASS 사업조회에서 세어 온 건수.
   공람 중인 사업(PROJECTS)과는 **모수가 다르다.**
   공람은 "지금 의견을 낼 수 있는 사업", 이쪽은 "환경청과 협의가 진행 중인 사업 전체". */
let UNDER_REVIEW = {};
const REVIEW_LABEL = { strat:"전략환경영향평가", main:"환경영향평가", small:"소규모환경영향평가" };
const REVIEW_SHORT = { strat:"전략", main:"환경", small:"소규모" };
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
/* 의견제출 기간의 끝날을 읽는다. "2026.07.30 ~ 2026.09.23" 형식.
   못 읽으면 null 을 돌려주고, 그때는 공람 종료일을 대신 쓴다. */
function opinionEndOf(p){
  if(p.opinionEnd) return p.opinionEnd;                 // 수집기가 이미 계산해 둔 값
  const m = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s*~\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/
    .exec(p.opinionPeriod || "");
  if(!m) return null;
  const pad = v => String(v).padStart(2, "0");
  return `${m[4]}-${pad(m[5])}-${pad(m[6])}`;
}

function normalizeProject(p){
  // 파일을 만든 날과 보는 날이 다를 수 있으므로, 화면에서 매번 다시 따진다.
  //
  // **기준은 '공람 종료일'이 아니라 '의견 제출 마감일'이다.**
  // 환경영향평가법 시행령 제38조: 주민은 공람이 끝난 뒤 7일 이내까지 의견을 낼 수 있다.
  // 공람 종료일로 끊으면 아직 의견을 낼 수 있는 사업이 화면에서 사라진다
  // (실제로 36건 중 30건이 공람 종료보다 7~10일 뒤에 마감된다).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = p.periodStart ? new Date(p.periodStart + "T00:00:00") : null;
  const viewEnd = p.periodEnd ? new Date(p.periodEnd + "T00:00:00") : null;
  const oEndStr = opinionEndOf(p);
  const oEnd = oEndStr ? new Date(oEndStr + "T00:00:00") : null;
  const deadline = oEnd && viewEnd ? new Date(Math.max(oEnd, viewEnd)) : (oEnd || viewEnd);

  const started = !start || today >= start;
  const ended = deadline && today > deadline;
  const open = Boolean(start && deadline && started && !ended);
  const dday = open ? Math.round((deadline - today) / 86400000) : null;
  // 공람은 끝났지만 의견은 아직 낼 수 있는 기간
  const viewClosed = Boolean(viewEnd && today > viewEnd);
  // **공람 기간 안인가** — 평가서 초안을 볼 수 있는 기간. 환경영향분석은 이때만 보여준다.
  const viewOpen = Boolean(start && viewEnd && started && !viewClosed);
  const stage = !open ? (ended ? "의견 접수 종료" : "공람 시작 전")
    : (viewClosed ? "공람 종료 · 의견 접수 중" : "초안 공람 중");

  const hasCoord = typeof p.lat === "number" && typeof p.lon === "number";
  return {
    id: p.id,
    type: p.category,
    typeLabel: p.categoryLabel || p.category,
    badge: CATEGORY_BADGE[p.category] || "badge--gray",
    name: p.name,
    open,                       // 아직 의견을 낼 수 있는가 (의견제출 마감 기준)
    stage, dday,
    viewClosed,                 // 공람은 끝났지만 의견은 낼 수 있는 상태
    viewOpen,                   // 공람 기간 안인가 (환경영향분석은 이때만 보여준다)
    opinionEnd: oEndStr,        // 의견 제출 마감일 (없으면 null)
    dist: null,                 // 우리 집 좌표가 정해진 뒤 계산한다
    periodStart: p.periodStart || null,   // '새로 올라온 사업' 판단에 쓴다
    period: (p.periodStart && p.periodEnd) ? `${p.periodStart} ~ ${p.periodEnd}` : "정보 없음",
    where: p.address || "위치 정보 없음",
    org: p.org || "기관 정보 없음",
    tel: p.tel || null,
    lat: hasCoord ? p.lat : null,
    lon: hasCoord ? p.lon : null,
    analysis: p.analysis || null,      // 정형화된 환경영향분석
    summaryEasy: p.summaryEasy || null, // 예전 방식(자유 문장) — 아직 남아있으면 같이 보여준다
    routeGeom: p.routeGeom || null,     // 하천 사업의 실제 도형
    routeSource: p.routeSource || null,
    locationTypes: p.locationTypes || [],  // 면형 / 선형 / 점형 (EIASS 표시가 있을 때만)
    segments: p.segments || [],             // 선형 사업의 구간 목록
    bizType: p.bizType || null,
    isRiver: !!p.isRiver,
    viewPlace: p.viewPlace || null,
    briefPlace: p.briefPlace || null,
    briefWhen: p.briefWhen || null,
    opinionPeriod: p.opinionPeriod || null,
    deptName: p.deptName || null,
    deptTel: p.deptTel || null,
    sourceBizCd: p.sourceBizCd || null,
    sourceBizSeq: p.sourceBizSeq || null,
    sourceStepCd: p.sourceStepCd || null,
    sourceViewPath: p.sourceViewPath || null
  };
}

/* 노선 도형의 좌표를 [[위도,경도], ...] 한 줄로 펴서 돌려준다.
   (GeoJSON 은 [경도,위도] 순서라 뒤집는다) */
function routePointsOf(p){
  const r = (typeof routeOf === "function") ? routeOf(p) : null;
  const out = [];
  if(!r) return out;
  const walk = c => {
    if(!Array.isArray(c)) return;
    if(typeof c[0] === "number"){ out.push([c[1], c[0]]); return; }
    c.forEach(walk);
  };
  r.geoms.forEach(g => walk(g && g.coordinates));
  return out;
}

/* 우리 집 좌표가 바뀌면 모든 사업의 거리를 다시 계산한다.
   선형 사업(하천·도로)은 **대표 주소가 노선에서 아주 멀 수 있다.**
   실제로 한강 고양권역 하천사업은 주소가 파주시라 계양구에서 22.9km 로 나오지만,
   하천 노선은 4.1km 앞을 지난다. 주소만 보면 "우리 동네 사업"에서 빠진다.
   그래서 노선까지의 최단 거리도 따로 재고, 둘 중 가까운 쪽을 기준으로 삼는다. */
function recomputeDistances(){
  // **전국을 보는 중에는 '우리 집'이 없다.**
  // 동네를 안 정했으면 기준 좌표는 설정 기본값(하남 근처)일 뿐인데,
  // 그걸로 거리를 재면 "우리 집에서 19.7km" 같은 **거짓말**이 화면에 뜬다.
  // 거리를 아예 비워 두면 반경 판정·정렬·표시가 전부 조용히 빠진다.
  if(isNation(currentHood)){
    PROJECTS.forEach(p => { p.dist = null; p.routeDist = null; p.nearDist = null; });
    return;
  }
  PROJECTS.forEach(p => {
    p.dist = (p.lat != null && p.lon != null)
      ? haversineKm(HOME.lat, HOME.lon, p.lat, p.lon) : null;

    let best = null;
    routePointsOf(p).forEach(([la, lo]) => {
      const d = haversineKm(HOME.lat, HOME.lon, la, lo);
      if(best === null || d < best) best = d;
    });
    p.routeDist = best;

    const both = [p.dist, p.routeDist].filter(v => v != null);
    p.nearDist = both.length ? Math.min(...both) : null;
  });
}

/* 사업 하나를 번호로 찾는다.
   기한이 지난 사업(CLOSED_PROJECTS)까지 뒤지는 이유는 **담아 둔 사업** 때문이다 —
   담아 뒀는데 마감됐다고 상세를 못 열면 담은 사람 입장에서는 고장난 것으로 보인다.
   기간 규칙은 그대로다: 마감된 사업은 의견 제출 단추가 안 나오고(dday 가 null),
   환경영향분석은 eiaSection() 이 공람 기간(viewOpen)으로 잠근다. */
function findProject(id){
  const key = String(id);
  return PROJECTS.find(x => String(x.id) === key)
    || CLOSED_PROJECTS.find(x => String(x.id) === key)
    || null;
}

/* 화면에 쓸 거리 문구. 노선 쪽이 더 가까우면 그렇다고 밝힌다. */
function distText(p){
  if(p.nearDist == null) return null;
  const viaRoute = p.routeDist != null && (p.dist == null || p.routeDist < p.dist - 0.05);
  return `${p.nearDist.toFixed(1)}km${viaRoute ? " (노선 기준)" : ""}`;
}

async function loadProjects(){
  let list = [];
  try{
    const res = await fetch(S.dataPath, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if(Array.isArray(json.projects) && json.projects.length) list = json.projects;
    // 협의 진행 중인 사업 수 (EIASS 사업조회에서 세어 온 건수)
    UNDER_REVIEW = (json.stats && json.stats.underReview) || {};
  }catch(e){
    console.warn("data/projects.json 을 불러오지 못해 표본 데이터를 표시합니다.", e);
  }
  // 실제 파일을 못 읽었을 때만 표본으로 대신한다. 이때만 상단에 안내 띠를 띄운다.
  usingSample = !list.length;
  const all = (list.length ? list : SAMPLE_PROJECTS).map(normalizeProject);

  // 화면에는 '아직 의견을 낼 수 있는' 사업만 올린다 (공람 종료가 아니라 의견제출 마감 기준).
  // 마감이 지난 사업은 CLOSED_PROJECTS 로 따로 빼서 목록·지도·통계에서 제외한다.
  PROJECTS = all.filter(p => p.open);
  CLOSED_PROJECTS = all.filter(p => !p.open);
  if(CLOSED_PROJECTS.length){
    console.info(`의견 제출 기한이 지난 사업 ${CLOSED_PROJECTS.length}건은 화면에서 제외했습니다.`);
  }

  dataReady = true;

  // 처음 온 사람에게는 아무것도 새것으로 표시하지 않는다 — 오늘 날짜만 적어 둔다.
  // (41건이 전부 NEW 로 뜨면 아무 뜻이 없다)
  if(!LAST_SEEN){
    LAST_SEEN = todayStr();
    lsSet(LSSEEN, LAST_SEEN);
  }

  applyDemoBanner();
  renderNation();          // 첫 화면 숫자는 자료를 읽은 뒤에야 채울 수 있다
  recomputeDistances();
  refreshAll();
}

/* 표본 데이터를 쓰고 있을 때만 상단 안내 띠를 보여준다.
   실제 데이터에 "표본입니다"라고 붙이면 거짓 안내가 되므로 자동으로 판단한다. */
function applyDemoBanner(){
  const el = $("#demoBanner");
  const on = usingSample && S.showDemoBanner;
  el.hidden = !on;
  if(on){
    el.textContent = "실제 수집 데이터를 읽지 못해 화면 확인용 표본을 보여주고 있습니다. "
      + "python -m http.server 로 열었는지, data/projects.json 이 있는지 확인하세요.";
  }
}

/* 화면 전체를 데이터에 맞춰 다시 그린다. */
function refreshAll(){
  renderScope();
  updateFilterCounts();
  updateDashboardStats();
  renderHoodFoot();
  renderDashTick();
  render();
  renderOpenList();
  renderMiniMap();
  renderGisList();
  renderGisMarkers();
  syncSavedUi();      // 별표 상태와 머리쪽 숫자는 자료를 읽은 뒤에 맞춘다
  renderNewBanner();  // 새로 올라온 사업 알림 줄 (범위가 바뀌면 건수도 달라진다)
  renderCalSub();     // 구독 주소는 고른 동네에 따라 달라진다
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
  // 브라우저가 새 탭으로 보내기 전에 폼이 사라지면 안 되므로 한 박자 뒤에 치운다.
  setTimeout(() => form.remove(), 0);
}

/* ============================================================
   행정구역 (전국 시도 / 시군구 / 읍면동)
   data/regions.json — tools/build_regions.py 가 만든다.
   ============================================================ */
let REGIONS = null;
const FALLBACK_REGIONS = {
  "경기도": { short:"경기", sgg:{ "하남시":["미사동","덕풍동","신장동","감일동"] }, dong:[] }
};

/* 세 칸을 다 고르지 않아도 되게 하려고 쓰는 표시값.
   ALL_SIDO 는 시·도 칸 맨 위의 "전국", ANY 는 시군구·읍면동 칸 맨 위의 "전체". */
const ALL_SIDO = "전국";
const ANY = "전체";

/* 같은 시·도를 다르게 적은 경우. EIASS 주소는 옛 이름으로 적힌 것이 섞여 있다
   (예: regions.json 은 "전남광주통합특별시", 주소 한 건은 "전라남도").
   짧은 이름("전남")은 다른 지역과 헷갈릴 수 있어 넣지 않는다. */
const SIDO_ALIAS = {
  "전남광주통합특별시": ["전라남도", "광주광역시"],
  "강원특별자치도": ["강원도"],
  "전북특별자치도": ["전라북도"],
  "제주특별자치도": ["제주도"],
  "세종특별자치시": ["세종시"]
};
function sidoNames(sido){ return [sido].concat(SIDO_ALIAS[sido] || []); }

/* 고른 동네를 읽는 도우미. "전국"/"전체"는 '고르지 않음'으로 본다. */
function isNation(h){ return !h || !h.sido || h.sido === ALL_SIDO; }
function hoodSgg(h){ return (h && h.sgg && h.sgg !== ANY) ? h.sgg : ""; }
function hoodDong(h){ return (h && h.dong && h.dong !== ANY) ? h.dong : ""; }

function hoodLabel(h, short){
  if(isNation(h)) return "전국";
  const s = short ? shortSido(h.sido) : h.sido;
  return `${s} ${hoodSgg(h)} ${hoodDong(h)}`.replace(/\s+/g, " ").trim();
}
/* 화면에 크게 쓰는 짧은 이름 — 고른 것 중 가장 좁은 단위 */
function hoodShort(h){
  if(isNation(h)) return "전국";
  return hoodDong(h) || hoodSgg(h) || shortSido(h.sido);
}

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
   첫 화면과 지도 화면, 동네 변경 모달에서 같은 방식으로 쓴다.

   **세 칸을 다 고를 필요는 없다.** 시군구·읍면동 칸에는 늘 맨 위에 "전체"가 있고,
   시·도 칸 맨 위에는 "전국"이 있다. 위 칸을 고르지 않으면 아래 칸은 잠긴다
   (시군구를 안 정한 채 읍면동만 고르면 같은 이름이 전국에 여럿이라 뜻이 없다). */
function bindRegionSelects(sidoSel, sggSel, dongSel){
  const syncDong = pick => {
    const list = sidoSel.value === ALL_SIDO ? [] : dongList(sidoSel.value, sggSel.value);
    fillSelect(dongSel, [ANY].concat(list), pick);
    dongSel.disabled = !list.length;
  };
  const syncSgg = (sggPick, dongPick) => {
    const list = sidoSel.value === ALL_SIDO ? [] : sggList(sidoSel.value);
    fillSelect(sggSel, [ANY].concat(list), sggPick);
    sggSel.disabled = !list.length;
    syncDong(dongPick);
  };
  sidoSel.addEventListener("change", () => syncSgg());
  sggSel.addEventListener("change", () => syncDong());
  return {
    set(hood){
      if(!REGIONS) return;
      const sidoKeys = Object.keys(REGIONS);
      // 모르는 시·도 이름이 들어오면 임의로 다른 지역을 고르지 않고 "전국"으로 둔다.
      const sido = (hood && REGIONS[hood.sido]) ? hood.sido : ALL_SIDO;
      fillSelect(sidoSel, [ALL_SIDO].concat(sidoKeys), sido);
      syncSgg((hood && hood.sgg) || ANY, (hood && hood.dong) || ANY);
    },
    get(){
      return { sido:sidoSel.value, sgg:sggSel.value, dong:dongSel.value };
    }
  };
}

const onbHood  = bindRegionSelects($("#f-sido"), $("#f-sgg"), $("#f-dong"));  // 첫 화면
const mapHood  = bindRegionSelects($("#m-sido"), $("#m-sgg"), $("#m-dong"));  // 지도 화면
const pickHood = bindRegionSelects($("#h-sido"), $("#h-sgg"), $("#h-dong"));  // 동네 변경 모달

/* 지금 보고 있는 동네 */
let currentHood = Object.assign({}, S.defHood);
let hoodShortName = "";   // 화면에 크게 쓰는 짧은 이름 (예: 미사동)

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
  pickHood.set(S.defHood);
  renderRecent();
}

/* ============================================================
   우리 집 좌표 찾기 — VWorld 지오코더
   브라우저에서 직접 부르면 CORS 에 막히는 경우가 있어 JSONP 방식으로 부른다.
   못 찾으면 관리자 설정의 기준 좌표를 그대로 쓴다.
   ============================================================ */
let jsonpSeq = 0;

/* VWorld 를 JSONP 로 부르는 공통 통로. 실패·시간초과는 모두 null 로 돌려준다
   (지도나 경계가 안 나오는 것뿐이고, 화면 나머지는 그대로 동작해야 한다). */
function jsonp(base, params, timeoutMs = 8000){
  return new Promise(resolve => {
    const cbName = "wdnCb" + (++jsonpSeq) + Date.now().toString(36);
    const script = document.createElement("script");
    let done = false;
    const cleanup = () => {
      if(done) return;
      done = true;
      delete window[cbName];
      script.remove();
    };
    window[cbName] = data => { cleanup(); resolve(data); };
    const q = new URLSearchParams(Object.assign({}, params, { callback:cbName }));
    script.src = `${base}?${q}`;
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
    setTimeout(() => { if(!done){ cleanup(); resolve(null); } }, timeoutMs);
  });
}

const VWORLD_ADDR = "https://api.vworld.kr/req/address";
const VWORLD_DATA = "https://api.vworld.kr/req/data";

/* 주소 → 좌표 */
async function geocodeJsonp(address){
  if(!S.vworldKey || !address) return null;
  const res = await jsonp(VWORLD_ADDR, {
    service:"address", request:"getCoord", version:"2.0", crs:"epsg:4326",
    address, format:"json", type:"parcel", key:S.vworldKey
  }, 6000);
  const point = res && res.response && res.response.result && res.response.result.point;
  return point ? { lat:+point.y, lon:+point.x } : null;
}

/* 좌표 → 주소 (내 위치 찾기에 쓴다) */
async function reverseGeocode(lat, lon){
  if(!S.vworldKey) return null;
  const res = await jsonp(VWORLD_ADDR, {
    service:"address", request:"getAddress", version:"2.0", crs:"epsg:4326",
    point:`${lon},${lat}`, format:"json", type:"parcel", key:S.vworldKey
  }, 8000);
  const r = res && res.response && res.response.status === "OK"
    && res.response.result && res.response.result[0];
  return r ? { text:r.text, st:r.structure || {} } : null;
}

/* 역지오코딩 결과(시도/시군구/법정동)를 regions.json 의 항목으로 맞춘다.
   regions.json 이 VWorld 읍면동 레이어에서 만들어졌으므로 대개 그대로 들어맞지만,
   못 맞추면 한 단계 넓혀서(동 → 시군구 → 시도) 돌려준다. 지어내지 않는다. */
function matchHood(sido, sgg, dong){
  if(!REGIONS || !sido) return null;
  const key = REGIONS[sido] ? sido
    : Object.keys(REGIONS).find(k => sidoNames(k).indexOf(sido) >= 0);
  if(!key) return null;

  const sggKeys = Object.keys(REGIONS[key].sgg);
  let sggHit = ANY;
  if(sgg && sggKeys.length){
    sggHit = sggKeys.indexOf(sgg) >= 0 ? sgg
      : (sggKeys.find(k => k === sgg || k.endsWith(" " + sgg) || k.split(/\s+/)[0] === sgg) || ANY);
  }
  const dongs = dongList(key, sggHit);
  const dongHit = (dong && dongs.indexOf(dong) >= 0) ? dong : ANY;
  return { sido:key, sgg:sggHit, dong:dongHit };
}

/* 동네를 정한다.
   coord 를 주면(내 위치로 찾은 경우) 지오코딩하지 않고 그 좌표를 그대로 쓴다. */
async function resolveHome(hood, coord){
  currentHood = Object.assign({}, hood);
  const dong = hoodDong(hood), sgg = hoodSgg(hood);
  HOME.label = hoodLabel(hood, false);
  HOME.gps = !!coord;

  if(coord){
    HOME.lat = coord.lat; HOME.lon = coord.lon; HOME.exact = true;
  }else if(isNation(hood)){
    // 전국을 보는 중에는 기준점이 뜻을 갖지 않는다. 설정의 기준 좌표를 그대로 둔다.
    HOME.lat = +S.centerLat; HOME.lon = +S.centerLon; HOME.exact = false;
  }else{
    // 동까지 못 찾으면 시군구, 그것도 못 찾으면 시도로 범위를 넓혀가며 찾는다.
    const full = `${hood.sido} ${sgg} ${dong}`.replace(/\s+/g, " ").trim();
    const hit = await geocodeJsonp(full)
      || (dong ? await geocodeJsonp(`${hood.sido} ${sgg}`.trim()) : null)
      || (sgg ? await geocodeJsonp(hood.sido) : null);
    if(hit){
      HOME.lat = hit.lat; HOME.lon = hit.lon; HOME.exact = true;
    }else{
      HOME.lat = +S.centerLat; HOME.lon = +S.centerLon; HOME.exact = false;
    }
  }

  // 화면 곳곳의 동네 이름을 맞춘다.
  const label = hoodLabel(hood, true);
  hoodShortName = hoodShort(hood);
  $("#hood-pill-label").textContent = label;
  $("#hood-card-name").textContent = label;
  mapHood.set(hood);
  pickHood.set(hood);

  applyAutoScope();
  recomputeDistances();
  refreshAll();

  // 지도 화면을 보고 있으면 그 주소로 지도를 옮기고 목록을 처음부터 다시 보여준다.
  if($("#scr-map").classList.contains("on")){
    selectedId = null;
    if(gisMap){
      gisMap.setView([HOME.lat, HOME.lon], 13);
      renderGisMarkers(false);
    }
    backToGisList();
  }

  // 경계는 시간이 걸리므로 화면을 먼저 그린 뒤에 받아서 덧붙인다.
  loadHoodBoundary();
}

/* ============================================================
   읍면동 · 시군구 경계
   VWorld 2D데이터 API 에서 고른 동네의 실제 경계 도형을 받아
   ① 지도에 그리고 ② "이 동네 안에 있는 사업"을 가리는 데 쓴다.

   시·도만 고른 경우에는 받지 않는다 — 도 하나의 도형이 수 MB라 화면이 느려지고,
   그 정도 범위는 주소 글자만으로도 정확히 가려진다.
   ============================================================ */
let HOOD_BOUNDARY = null;      // { name, level, geom, bbox }
let boundarySeq = 0;           // 늦게 도착한 옛 응답이 새 것을 덮어쓰지 않게

const BOUND_LAYER = {
  dong: { data:"LT_C_ADEMD_INFO",  attr:"emd_kor_nm" },
  sgg:  { data:"LT_C_ADSIGG_INFO", attr:"sig_kor_nm" }
};

function normName(s){ return String(s || "").replace(/\s+/g, " ").trim(); }

/* 발급 때 등록한 서비스 URL. 배포 사이트에서는 지금 열려 있는 주소가 곧 그 주소다. */
function vworldDomain(){
  return location.protocol.startsWith("http")
    ? location.origin + location.pathname.replace(/[^/]*$/, "")
    : S.serviceUrl;
}

async function fetchBoundary(layer, like){
  const base = {
    service:"data", request:"GetFeature", data:layer.data, key:S.vworldKey,
    format:"json", size:30, geometry:"true", crs:"EPSG:4326",
    attrFilter:`${layer.attr}:like:${like}`
  };
  // domain 없이 먼저 부른다(브라우저는 Referer 로 확인된다).
  // 거부되면 지금 열려 있는 주소를 domain 으로 붙여 한 번 더 시도한다.
  let res = await jsonp(VWORLD_DATA, base, 12000);
  let ok = res && res.response && res.response.status === "OK";
  if(!ok){
    res = await jsonp(VWORLD_DATA, Object.assign({}, base, { domain:vworldDomain() }), 12000);
    ok = res && res.response && res.response.status === "OK";
  }
  if(!ok) return [];
  const fc = res.response.result && res.response.result.featureCollection;
  return (fc && fc.features) || [];
}

/* 시·도 경계는 `data/sido.json` 에서 읽는다.
   VWorld 원본은 시·도 하나가 1~3MB(경기도 79,576점)라 화면에서 매번 받을 수 없다.
   `tools/build_boundaries.py` 가 미리 200m 로 단순화해 둔 것을 쓴다 (전체 367KB).

   **처음 필요할 때 한 번만 받는다.** 시·도를 안 고르는 사람은 아예 받지 않는다.
   못 받아도 경계만 안 그려질 뿐 화면은 그대로 동작한다. */
let SIDO_GEOMS = null;      // null = 아직 안 받음, {} = 받으려다 실패
let sidoLoading = null;

async function sidoBoundary(sido){
  if(!SIDO_GEOMS){
    if(!sidoLoading){
      sidoLoading = fetch(S.sidoPath, { cache:"force-cache" })
        .then(r => r.ok ? r.json() : null)
        .then(j => { SIDO_GEOMS = (j && j.sido) || {}; })
        .catch(() => { SIDO_GEOMS = {}; });
    }
    await sidoLoading;
  }
  // regions.json 과 이름이 다르게 적힌 경우까지 본다 (전남광주통합특별시 / 전라남도 등)
  for(const n of sidoNames(sido)){
    if(SIDO_GEOMS[n]) return SIDO_GEOMS[n];
  }
  return null;
}

async function loadHoodBoundary(){
  const seq = ++boundarySeq;
  const prev = HOOD_BOUNDARY;
  HOOD_BOUNDARY = null;

  const dong = hoodDong(currentHood), sgg = hoodSgg(currentHood);
  if(isNation(currentHood)){
    if(prev) afterBoundary();
    return;
  }

  // 시·도만 골랐으면 미리 만들어 둔 파일에서 꺼낸다 (VWorld 를 부르지 않는다).
  // 원본은 너무 커서(경기도 3.2MB) 화면에서 매번 받을 수 없다 — tools/build_boundaries.py 참고.
  if(!dong && !sgg){
    const geom = await sidoBoundary(currentHood.sido);
    if(seq !== boundarySeq) return;
    if(geom){
      HOOD_BOUNDARY = {
        name: currentHood.sido, level:"sido", geom, bbox: geomBbox(geom)
      };
    }
    afterBoundary();
    return;
  }

  if(!S.vworldKey){
    if(prev) afterBoundary();
    return;
  }

  const level = dong ? "dong" : "sgg";
  // like 는 앞에서부터 맞춘다("의창구"로는 안 찾아지고 "창원시"로는 찾아진다).
  const like = dong || sgg.split(/\s+/)[0];
  const feats = await fetchBoundary(BOUND_LAYER[level], like);
  if(seq !== boundarySeq) return;      // 그 사이에 동네가 또 바뀌었다

  const want = sidoNames(currentHood.sido)
    .map(n => normName(`${n} ${sgg} ${dong}`));
  const hit = feats.find(f => want.indexOf(normName(f.properties && f.properties.full_nm)) >= 0)
    || (feats.length === 1 ? feats[0] : null);

  if(hit && hit.geometry){
    HOOD_BOUNDARY = {
      name: (hit.properties && hit.properties.full_nm) || hoodLabel(currentHood, false),
      level,
      geom: hit.geometry,
      bbox: geomBbox(hit.geometry)
    };
    // 기준점을 경계 한가운데로 옮긴다 (아래 설명 참고).
    // 단 **내 위치로 잡은 자리는 절대 옮기지 않는다** — 그건 진짜 내가 서 있는 곳이다.
    if(!HOME.gps){
      const c = boundaryCenter(HOOD_BOUNDARY);
      if(c){ HOME.lat = c[0]; HOME.lon = c[1]; HOME.exact = true; }
    }
    recomputeDistances();
  }
  afterBoundary();
}

/* ---------- 동네의 '한가운데' ----------
   VWorld 지오코더는 "인천광역시 서해구 경서동" 같은 이름을 넣으면
   **그 동의 대표 지번 한 곳**을 돌려준다. 동사무소도 아니고 도형의 중심도 아니라서,
   경계를 그려 놓고 보면 기준점이 한쪽에 치우쳐 있다 (실제로 그랬다).
   경계를 받았으면 도형에서 직접 중심을 구해 그쪽으로 옮긴다.

   면적으로 가중한 무게중심을 쓰되, 초승달처럼 굽은 동네는 무게중심이
   경계 **밖**으로 나갈 수 있다. 그때는 격자를 훑어 안쪽 점 중 무게중심에
   가장 가까운 곳을 고른다. */
function ringCentroid(ring){
  let a = 0, cx = 0, cy = 0;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if(!a) return null;
  return { lon: cx / (3 * a), lat: cy / (3 * a), area: Math.abs(a / 2) };
}

function boundaryCenter(b){
  const g = b.geom;
  const polys = g.type === "Polygon" ? [g.coordinates]
    : (g.type === "MultiPolygon" ? g.coordinates : []);
  if(!polys.length) return null;

  // 섬이 딸린 동네는 가장 넓은 덩어리를 본체로 삼는다
  let best = null;
  polys.forEach(poly => {
    const c = poly[0] && ringCentroid(poly[0]);
    if(c && (!best || c.area > best.area)) best = c;
  });
  if(!best) return null;
  if(ptInBoundary(best.lat, best.lon)) return [best.lat, best.lon];

  // 무게중심이 경계 밖 — 안쪽에서 가장 가까운 자리를 찾는다
  const [minX, minY, maxX, maxY] = b.bbox;
  let hit = null, bestD = Infinity;
  for(let i = 1; i < 20; i++){
    for(let j = 1; j < 20; j++){
      const lon = minX + (maxX - minX) * i / 20;
      const lat = minY + (maxY - minY) * j / 20;
      if(!ptInBoundary(lat, lon)) continue;
      const d = (lon - best.lon) ** 2 + (lat - best.lat) ** 2;
      if(d < bestD){ bestD = d; hit = [lat, lon]; }
    }
  }
  return hit;
}

/* 경계가 들어오거나 사라지면 지도에 다시 그리고, 목록도 다시 가린다
   (경계 안/밖 판정이 바뀌기 때문). */
function afterBoundary(){
  drawBoundary();
  if(dataReady) refreshAll();
}

function geomBbox(g){
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const walk = c => {
    if(!Array.isArray(c)) return;
    if(typeof c[0] === "number"){
      if(c[0] < minX) minX = c[0];
      if(c[0] > maxX) maxX = c[0];
      if(c[1] < minY) minY = c[1];
      if(c[1] > maxY) maxY = c[1];
      return;
    }
    c.forEach(walk);
  };
  walk(g.coordinates);
  return [minX, minY, maxX, maxY];
}

/* 점이 다각형 안에 있는지 (교차 횟수 세기). 구멍(호수 등)도 처리한다. */
function ptInRing(x, y, ring){
  let inside = false;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ptInPoly(x, y, poly){
  if(!poly.length || !ptInRing(x, y, poly[0])) return false;
  for(let i = 1; i < poly.length; i++) if(ptInRing(x, y, poly[i])) return false;
  return true;
}
function ptInBoundary(lat, lon){
  const b = HOOD_BOUNDARY;
  if(!b || lat == null || lon == null) return false;
  const bb = b.bbox;
  if(lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) return false;   // 빠른 걸러내기
  const g = b.geom;
  if(g.type === "Polygon") return ptInPoly(lon, lat, g.coordinates);
  if(g.type === "MultiPolygon") return g.coordinates.some(poly => ptInPoly(lon, lat, poly));
  return false;
}

/* ============================================================
   "이 동네에 있는 사업인가"
   ① 주소 글자로 맞춰 보고 (경계 자료 없이도 동작한다)
   ② 경계 도형이 있으면 사업 위치·노선이 그 안을 지나는지도 본다
      (선형 사업은 대표 주소가 옆 시군구인 경우가 흔하다)
   ============================================================ */
function projectAddr(p){ return String(p.where || "").replace(/\(.*$/, "").trim(); }

function inHoodByAddress(p, hood){
  const a = projectAddr(p);
  if(!a) return false;
  if(!sidoNames(hood.sido).some(n => a.startsWith(n))) return false;
  const sgg = hoodSgg(hood);
  if(sgg && !sgg.split(/\s+/).every(t => a.indexOf(t) >= 0)) return false;
  const dong = hoodDong(hood);
  if(dong && a.indexOf(dong) < 0) return false;
  return true;
}

function inHood(p){
  if(isNation(currentHood)) return true;
  if(inHoodByAddress(p, currentHood)) return true;
  if(!HOOD_BOUNDARY) return false;
  if(ptInBoundary(p.lat, p.lon)) return true;
  // 노선은 점이 많아 몇 개 걸러 본다 (경계를 스치기만 해도 '우리 동네 사업'이다)
  const pts = routePointsOf(p);
  const step = Math.max(1, Math.floor(pts.length / 200));
  for(let i = 0; i < pts.length; i += step){
    if(ptInBoundary(pts[i][0], pts[i][1])) return true;
  }
  return false;
}

/* ============================================================
   지금 내 위치로 보기
   휴대폰에서 가장 쓸모 있다. 좌표를 받아 그 자리의 동네를 찾아 넣고,
   거리 기준점은 동 중심이 아니라 **실제 서 있는 자리**로 삼는다.
   ============================================================ */
const GEO_ERR = {
  1: "위치 권한이 거부되었습니다. 브라우저 주소창의 자물쇠에서 위치를 허용해 주세요.",
  2: "지금 위치를 확인할 수 없습니다. 실내라면 창가에서 다시 시도해 보세요.",
  3: "위치를 찾는 데 시간이 너무 오래 걸립니다. 잠시 뒤 다시 시도해 주세요."
};

function geoSay(text){
  $$(".geo-msg").forEach(el => { el.textContent = text; });
}
function geoBusy(on){
  $$("[data-geo]").forEach(b => { b.disabled = on; });
}

function getPosition(){
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ pos }),
      err => resolve({ err }),
      { enableHighAccuracy:true, timeout:12000, maximumAge:30000 }
    );
  });
}

async function useMyLocation(){
  if(!navigator.geolocation){
    geoSay("이 브라우저는 위치 기능을 지원하지 않습니다.");
    return;
  }
  if(!location.protocol.startsWith("https") && location.hostname !== "localhost"){
    geoSay("위치 기능은 보안 연결(https)에서만 동작합니다.");
    return;
  }
  geoBusy(true);
  geoSay("현재 위치를 확인하고 있어요…");

  const { pos, err } = await getPosition();
  if(err){
    geoBusy(false);
    geoSay(GEO_ERR[err.code] || "위치를 확인하지 못했습니다.");
    return;
  }
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  const acc = Math.round(pos.coords.accuracy || 0);

  geoSay("주소를 찾고 있어요…");
  const rev = await reverseGeocode(lat, lon);
  const hood = rev ? matchHood(rev.st.level1, rev.st.level2, rev.st.level4L) : null;

  if(hood){
    onbHood.set(hood);
    await resolveHome(hood, { lat, lon });
    pushRecent(hood);
    geoSay(`현재 위치: ${hoodLabel(hood, true)} (오차 약 ${acc}m)`);
  }else{
    // 주소를 못 찾아도 좌표는 있으므로 반경 기준점으로는 쓸 수 있다.
    HOME.lat = lat; HOME.lon = lon; HOME.exact = true; HOME.gps = true;
    HOME.label = "현재 위치";
    hoodShortName = "현재 위치";
    $("#hood-pill-label").textContent = "현재 위치";
    $("#hood-card-name").textContent = "현재 위치";
    homeScope = "near"; mapScope = "near";
    recomputeDistances();
    refreshAll();
    geoSay(S.vworldKey
      ? `현재 위치를 잡았습니다 (오차 약 ${acc}m). 주소는 찾지 못해 반경으로만 봅니다.`
      : `현재 위치를 잡았습니다 (오차 약 ${acc}m). VWorld 인증키가 없어 주소는 찾지 못했습니다.`);
  }
  geoBusy(false);

  // 첫 화면에서 눌렀으면 그대로 우리 동네 홈으로 넘어간다.
  if($("#scr-onboard").classList.contains("on")){
    show("#scr-home");
    startReveal();
    countUp();
  }
  const hoodModal = $("#m-hood");
  if(hoodModal && !hoodModal.hidden) closeModal(hoodModal);
}

$$("[data-geo]").forEach(b => b.addEventListener("click", useMyLocation));

/* 첫 화면 아래의 전국 숫자 3칸.
   **전부 수집한 실제 값이다.** 값이 없으면 그 칸을 만들지 않는다(지어내지 않는다). */
function renderNation(){
  const brief = PROJECTS.reduce((n, p) => n + briefInfo(p).upcoming, 0);
  const cells = [
    UNDER_REVIEW.total ? { v:UNDER_REVIEW.total, u:"건", k:"협의 진행 중" } : null,
    dataReady && !usingSample ? { v:PROJECTS.length, u:"건", k:"지금 공람 중" } : null,
    dataReady && !usingSample ? { v:brief, u:"회", k:"예정 설명회" } : null
  ].filter(Boolean);

  $("#nationRow").innerHTML = cells.map(n => `
    <div class="nation-i">
      <p class="v">${esc(n.v.toLocaleString())}<small>${esc(n.u)}</small></p>
      <p class="k">${esc(n.k)}</p>
    </div>`).join("");
}

/* ============================================================
   설정 적용
   ============================================================ */
function applySettings(){
  renderNation();
  applyDemoBanner();
  fillRadiusPick();
  $("#scope-radius").textContent = S.radiusKm;
  $("#gis-radius").textContent = S.radiusKm;
  $("#c-org").textContent = S.org;
  $("#c-person").textContent = S.person;
  $("#c-tel").textContent = S.tel;
  $("#f-org").textContent = S.org;
  $("#f-tel").textContent = S.tel;
  renderScope();
  if(REGIONS) renderRecent();
}

/* 반경 고르는 칸. 관리자 설정과 같은 값(S.radiusKm)을 쓰고, 바꾸면 바로 저장한다.
   설정에 없는 값(관리자가 7km 로 넣었다든지)이 들어와도 목록에 끼워 넣어 보여준다. */
function fillRadiusPick(){
  const sel = $("#v-radius");
  if(!sel) return;
  const steps = RADIUS_STEPS.indexOf(+S.radiusKm) >= 0
    ? RADIUS_STEPS : RADIUS_STEPS.concat([+S.radiusKm]).sort((a, b) => a - b);
  sel.innerHTML = steps.map(v =>
    `<option value="${v}"${v === +S.radiusKm ? " selected" : ""}>${v}km 이내</option>`).join("");
}

$("#v-radius").addEventListener("change", e => {
  S.radiusKm = +e.target.value || DEFAULTS.radiusKm;
  lsSet(LSKEY, S);
  applySettings();          // 반경 글자가 들어가는 곳이 여러 군데다
  recomputeDistances();
  if(dataReady) refreshAll();
});

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
    b.textContent = hoodLabel(h, true);
    b.addEventListener("click", () => {
      if(REGIONS && (REGIONS[h.sido] || isNation(h))) onbHood.set(h);
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
function show(id, push = true){
  $$(".screen").forEach(s => s.classList.remove("on"));
  $(id).classList.add("on");
  window.scrollTo(0, 0);
  rememberScreen(id, push);
}

/* ---------- 브라우저 뒤로가기 ----------
   화면을 <div> 로 갈아 끼우는 방식이라, 그냥 두면 뒤로가기가 이 사이트를 아예 벗어난다.
   화면을 바꿀 때마다 방문 기록을 하나 남겨 두면 뒤로가기가 앞 화면으로 돌아온다.
   push=false 는 '뒤로가기로 되돌아온 경우'라 기록을 새로 남기지 않는다. */
function rememberScreen(id, push){
  const cur = history.state && history.state.screen;
  if(!history.state){
    history.replaceState({ screen:id }, "");     // 첫 진입 — 지금 기록에 표시만 해 둔다
  }else if(push && cur !== id){
    history.pushState({ screen:id }, "");
  }
}

addEventListener("popstate", e => {
  // 모달 위에서 뒤로가기를 누르면 **모달만 닫는다.** 화면까지 넘어가면 하던 것을 잃는다.
  const open = $$(".modal:not([hidden])");
  if(open.length){
    open.forEach(m => closeModal(m));
    const now = $$(".screen").find(s => s.classList.contains("on"));
    if(now) history.pushState({ screen:"#" + now.id }, "");   // 물러난 기록을 도로 채운다
    return;
  }
  // 화면 표시가 없는 기록(#projects 같은 본문 이동)은 건드리지 않는다
  if(e.state && e.state.screen) show(e.state.screen, false);
});

$("#setForm").addEventListener("submit", e => {
  e.preventDefault();
  const hood = onbHood.get();
  pushRecent(hood);
  show("#scr-home");
  startReveal();
  countUp();
  resolveHome(hood);   // 동네 이름 표시와 거리 계산은 여기서 함께 처리한다
});

/* 동네 변경 — 첫 화면으로 되돌아가지 않고 모달에서 바로 바꾼다.
   (한 번 들어온 뒤에 처음 화면으로 튕기면 하던 것을 잃어버린다) */
$$(".js-change").forEach(b => b.addEventListener("click", () => {
  pickHood.set(currentHood);
  $("#hoodPickMsg").textContent = "";
  openModal("m-hood");
}));

$("#btn-hood-apply").addEventListener("click", async () => {
  const btn = $("#btn-hood-apply");
  const hood = pickHood.get();
  btn.disabled = true;
  btn.textContent = "주소를 찾고 있어요…";
  $("#hoodPickMsg").textContent = "";
  await resolveHome(hood);
  pushRecent(hood);
  btn.disabled = false;
  btn.textContent = "이 동네로 보기";
  if(!HOME.exact){
    $("#hoodPickMsg").textContent = "이 주소의 좌표를 찾지 못해 기준 위치를 옮기지 못했습니다. 다른 동네를 골라 보세요.";
    return;
  }
  closeModal($("#m-hood"));
});

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
/* 보는 범위는 세 가지다.
     region — 고른 행정구역(읍·면·동 또는 시·군·구) 안에 실제로 있는 사업만
     near   — 우리 집에서 반경 N km 안 (행정구역 경계를 넘어도 가까우면 보인다)
     all    — 전국 전부                                                        */
let homeScope = "near";   // 홈 화면 사업 목록
let mapScope = "all";     // 지도 화면 (지도는 넓게 보는 화면이라 기본이 전국)

/* 반경 안인지 판단할 때는 '주소까지'가 아니라 '주소 또는 노선 중 가까운 쪽'을 쓴다.
   (노선이 우리 집 앞을 지나는데 주소가 멀다고 빼면 안 된다) */
function isNearby(p){
  return p.nearDist != null && p.nearDist <= S.radiusKm;
}
function nearbyProjects(){ return PROJECTS.filter(isNearby); }

/* 범위 이름에 맞는 '보일 사업인가' 판정 함수를 돌려준다. */
function scopeTest(scope){
  if(scope === "region") return inHood;
  if(scope === "near") return isNearby;
  return () => true;
}
function scopedProjects(){ return PROJECTS.filter(scopeTest(homeScope)); }

/* 고른 동네 모양에 맞는 기본 범위.
   전국이면 전국, 읍·면·동까지 골랐으면 반경(경계 너머 가까운 사업도 봐야 하므로),
   시·도나 시·군·구만 골랐으면 그 구역 안. (시·도 한가운데를 기준으로 잡은
   반경 3km 는 아무 뜻이 없다) */
function autoScopeFor(hood){
  if(isNation(hood)) return "all";
  if(hoodDong(hood)) return "near";
  return "region";
}
function applyAutoScope(){
  homeScope = autoScopeFor(currentHood);
  mapScope = homeScope;
  resetPages();
}

/* 카드에 붙는 '범위 밖' 표시.
   행정구역으로 보고 있을 때는 보이는 것이 모두 그 구역 안이므로 붙이지 않고,
   전국을 보는 중이면 반경 자체가 뜻이 없으므로 붙이지 않는다. */
function outsideBadge(p, scope){
  if(isNation(currentHood) || scope === "region" || isNearby(p)) return "";
  return `<span class="badge badge--gray">반경 밖</span>`;
}

/* "○○에" — 안내 문장에 넣는 말 */
function scopeWhere(scope){
  if(scope === "region") return `${esc(hoodLabel(currentHood, true))} 안에`;
  if(scope === "near") return `반경 ${esc(S.radiusKm)}km 안에`;
  return "전국에";
}

/* 범위에 따라 제목·라벨·강조를 맞춘다. */
function renderScope(){
  const nation = isNation(currentHood);
  $$("[data-scope]").forEach(b => {
    b.classList.toggle("on", b.dataset.scope === homeScope);
    // 전국을 보는 중이면 '동네 안'·'반경'은 고를 것이 없으므로 잠근다
    if(b.dataset.scope !== "all") b.disabled = nation;
  });
  $$("[data-mapscope]").forEach(b => {
    b.classList.toggle("on", b.dataset.mapscope === mapScope);
    if(b.dataset.mapscope !== "all") b.disabled = nation;
  });
  const rBtn = $("#scopeRegionBtn");
  if(rBtn) rBtn.textContent = nation ? "우리 동네 안" : `${hoodShort(currentHood)} 안`;

  $$("[data-nav]").forEach(el => {
    if(el.dataset.nav === "near" || el.dataset.nav === "all"){
      el.parentElement.classList.toggle("active",
        el.dataset.nav === (homeScope === "all" ? "all" : "near"));
    }
  });

  const where = esc(hoodLabel(currentHood, true));
  $("#projKicker").textContent = homeScope === "all" ? "전국 사업" : "우리 동네 사업";
  $("#projHead").innerHTML =
    homeScope === "region" ? `<span class="em">${where}</span> 안에서 계획 중인 사업입니다.`
    : homeScope === "near" ? `우리 집 반경 ${esc(S.radiusKm)}km 안, <span class="em">계획 중인 사업</span>입니다.`
    : `<span class="em">전국</span>에서 계획 중인 사업입니다.`;
  $("#h-hood").textContent = homeScope === "all" ? "전국" : (hoodShortName || "우리 동네");
  $("#stat-open-lab").textContent = homeScope === "all"
    ? "전국에서 의견 낼 수 있는 사업" : "우리 동네에서 의견 낼 수 있는 사업";
}

function setScope(scope){
  homeScope = scope;
  resetPages();
  renderScope();
  updateFilterCounts();
  updateDashboardStats();
  renderDashTick();
  render();
  renderOpenList();
  renderMiniMap();
}
$$("[data-scope]").forEach(b =>
  b.addEventListener("click", () => setScope(b.dataset.scope)));

/* 상단 메뉴 — 실제로 있는 기능으로만 보낸다. */
$$("[data-nav]").forEach(el => el.addEventListener("click", e => {
  const kind = el.dataset.nav;
  if(kind === "map"){ openMapScreen(); return; }
  // '내가 담은 사업'은 본문 이동이 아니라 **화면 전환**이다 (지도로 보기와 같은 방식).
  if(kind === "saved"){ show("#scr-saved"); renderSaved(); return; }
  if(kind === "near" || kind === "all"){
    e.preventDefault();
    // '우리 동네 사업' 메뉴는 지금 고른 동네에 맞는 범위로 보여준다.
    setScope(kind === "all" ? "all" : autoScopeFor(currentHood));
    $("#projects").scrollIntoView({ behavior:"smooth", block:"start" });
  }
}));

/* ============================================================
   환경영향분석 그리기
   ============================================================ */
function eiaSection(p){
  // ★ 환경영향분석은 **공람 기간 안에서만** 보여준다.
  //   평가서 초안은 법적으로 공람 기간에만 열람할 수 있다. 공람이 끝난 뒤에도
  //   그 내용을 옮긴 해석을 계속 띄우면 볼 수 없는 문서를 대신 보여주는 셈이 된다.
  //   그래서 의견 제출 기한(p.open)이 아니라 **공람 기간(p.viewOpen)** 을 기준으로 잠근다.
  if(!p.viewOpen){
    const note = p.open
      ? `공람 기간이 끝나 평가서 초안을 볼 수 없으므로 해석 결과도 표시하지 않습니다.
         <b>의견은 ${esc(p.opinionEnd || "")}까지 낼 수 있습니다.</b> 사업 내용은 EIASS 원문에서 확인하세요.`
      : `공람 기간이 아니라서 평가서 초안에 대한 해석 결과는 표시하지 않습니다.
         사업 내용은 EIASS 원문에서 확인하세요.`;
    return { title:"환경영향분석", hint:"표시하지 않음",
      body:`<p class="eia-src">${note}</p>` };
  }
  // 내용이 있는 항목만 카드로 보여주고, 없는 항목은 맨 아래에 한 줄로 모은다.
  // (8개 항목 중 절반이 "내용 없습니다"로 채워지면 정작 읽어야 할 내용이 묻힌다)
  const has = [], missing = [];
  EIA_FIELDS.forEach(f => {
    const v = p.analysis ? p.analysis[f.key] : null;
    (v ? has : missing).push(v ? { f, v } : f);
  });

  // ★ 해석이 **통째로** 비었을 때는 왜 비었는지를 갈라서 말한다.
  //   "요약문에 내용이 없습니다"는 요약문을 **읽었는데** 그 항목이 없었다는 뜻이다.
  //   못 읽은 것을 그렇게 쓰면 읽어 보고 없다고 한 것처럼 들려 **사실과 다르다.**
  //   (실측: 현경 수양저수지 사업 — 10쪽 요약문에서 글자가 112자밖에 안 뽑혔다. 사진 문서다)
  //   일부라도 채워졌으면 기존 문구가 맞으므로 건드리지 않는다.
  const readNothing = !has.length && !p.summaryEasy;
  if(readNothing && (p.summaryState === "scanned" || p.summaryState === "none")){
    const why = p.summaryState === "scanned"
      ? `요약문이 글자가 아닌 <b>사진(스캔한 문서)</b>으로 되어 있어 내용을 읽지 못했습니다.`
      : `이 사업은 <b>요약문 파일이 공개되어 있지 않아</b> 내용을 읽지 못했습니다.`;
    return { title:"환경영향분석", hint:"읽지 못함", body:`
      <p class="eia-src">${why}
        <b>내용이 없다는 뜻이 아닙니다.</b> 평가서 초안은 EIASS 원문에서 직접 확인해 주세요.</p>` };
  }

  const rows = has.map(({ f, v }, i) => {
    const lead = i === 0 && f.key === "overview" ? " lead" : "";
    return `<section class="eia-row${lead}">
      <p class="k">${esc(f.label)}</p>
      ${sentenceListHtml(v)}
    </section>`;
  }).join("");

  const missingRow = missing.length
    ? `<p class="eia-missing"><b>요약문에 내용이 없는 항목</b>
        ${missing.map(f => esc(f.label)).join(" · ")}</p>` : "";

  const legacy = (!p.analysis && p.summaryEasy)
    ? `<section class="eia-row">${sentenceListHtml(p.summaryEasy)}</section>` : "";

  const filled = p.analysis ? Object.values(p.analysis).filter(Boolean).length : 0;
  const hint = p.analysis ? `${filled}/${EIA_FIELDS.length}개 항목` : (p.summaryEasy ? "요약" : "없음");

  return { title:"환경영향분석", hint, body:`
    <p class="eia-src">사업자가 낸 평가서 초안의 <b>요약문</b>에 적힌 내용만 쉬운 말로 옮긴 것입니다.
      판단이나 의견은 담지 않았고, 요약문에 없는 항목은 비워 둡니다.</p>
    <div class="eia-list">${legacy || rows}${legacy ? "" : missingRow}</div>` };
}

/* 한 덩어리로 붙어 있는 문장을 문장 단위로 끊어 목록으로 만든다.
   글자는 그대로 두고 보기만 나눈다 — 내용을 고치거나 요약하지 않는다.
   문장이 하나뿐이면 목록으로 만들지 않고 그냥 한 문단으로 둔다. */
function sentenceListHtml(text){
  // '~다.' '~함.' 처럼 문장이 끝나는 자리에서만 끊는다.
  // ('1.5km' 처럼 숫자 사이의 점은 앞 글자가 달라서 안 끊긴다)
  const parts = (String(text).replace(/\s+/g, " ").trim()
    .match(/.*?[다요음임함됨]\.(?=\s|$)|.+$/g) || [])
    .map(s => s.trim())
    .filter(Boolean);
  if(parts.length <= 1) return `<p class="v">${esc(text)}</p>`;
  return `<ul class="v v-list">${parts.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`;
}

/* ============================================================
   가로로 눌러서 바꿔 보는 묶음
   내용이 길어 한 화면에 다 넣으면 읽기 어려우므로, 한 번에 하나만 보여준다.
   sections = [{ title, hint, body }] — 빈 것(null)은 알아서 걸러낸다.
   ============================================================ */
let tabSeq = 0;

function tabsHtml(sections){
  const rows = sections.filter(Boolean);
  if(!rows.length) return "";
  const g = "tab" + (++tabSeq);   // 탭과 내용을 이어주는 이름표
  const strip = rows.map((s, i) => `
    <button class="tab" type="button" role="tab" id="${g}-t${i}" aria-controls="${g}-p${i}"
            aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(s.title)}</button>`).join("");
  const panels = rows.map((s, i) => `
    <div class="tab-panel" role="tabpanel" id="${g}-p${i}" aria-labelledby="${g}-t${i}"${i ? " hidden" : ""}>
      ${s.hint ? `<p class="tab-hint">${esc(s.hint)}</p>` : ""}
      ${s.body}
    </div>`).join("");
  return `<div class="tabs"><div class="tab-strip" role="tablist">${strip}</div>${panels}</div>`;
}

function selectTab(btn){
  const strip = btn.closest(".tab-strip");
  if(!strip) return;
  strip.querySelectorAll(".tab").forEach(t => {
    const on = t === btn;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute("aria-controls"));
    if(panel) panel.hidden = !on;
  });
}

/* 탭은 상세 화면이 다시 그려질 때마다 새로 만들어지므로,
   버튼 하나하나에 붙이지 않고 문서 전체에서 한 번만 받는다. */
document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest(".tab");
  if(t) selectTab(t);
});
/* 키보드 좌우 화살표로도 탭을 옮길 수 있게 한다. */
document.addEventListener("keydown", e => {
  const t = e.target.closest && e.target.closest(".tab");
  if(!t) return;
  const tabs = Array.from(t.closest(".tab-strip").querySelectorAll(".tab"));
  const step = { ArrowLeft:-1, ArrowRight:1 }[e.key];
  let next = null;
  if(step) next = tabs[(tabs.indexOf(t) + step + tabs.length) % tabs.length];
  else if(e.key === "Home") next = tabs[0];
  else if(e.key === "End") next = tabs[tabs.length - 1];
  if(!next) return;
  e.preventDefault();
  selectTab(next);
  next.focus();
});

/* ============================================================
   위치 유형 태그 (면형 / 선형)
   EIASS가 표시해 주는 경우에만 붙인다. 표시가 없으면 태그를 만들지 않는다.
   ============================================================ */
const LOC_BADGE = { "면형":"badge--eco", "선형":"badge--teal", "점형":"badge--gray" };

function locTagHtml(p){
  if(!p.locationTypes.length) return "";
  return p.locationTypes.map(t =>
    `<span class="badge ${LOC_BADGE[t] || "badge--line"}">${esc(t)}</span>`).join("");
}

/* ============================================================
   설명회 일시 읽기
   일시 표기는 사업마다 자유 형식이라 **원문을 고치지 않는다.**
   다만 이미 끝난 설명회를 안내처럼 보여주면 안 되므로,
   형식이 분명한 것만 골라 날짜로 읽어 "지남"을 표시한다.

   읽는 형식: 2026년 8월 6일 / 2026.08.06 / 2026-08-06 / 20260806 / 2026 8 6(목)
   읽고 남은 자리에 날짜 같은 조각이 또 있으면(예: "30일(목)~31일(금), 08월 03일")
   해석을 포기하고 원문만 보여준다. 틀린 안내가 없는 안내보다 나쁘기 때문이다.
   ============================================================ */
/* 여러 회에 걸쳐 여는 설명회는 일시와 장소가 쉼표(또는 빗금)로 나란히 적혀 있고
   **순서가 1:1로 맞는다**(확인함: 36건 중 32건). 그래서 같은 자리끼리 짝지어 쓴다.
   괄호 안의 쉼표(주소)에서는 자르면 안 된다. */
function splitSessions(s){
  const seps = /\d{4}\/\d{1,2}\/\d{1,2}/.test(s) ? "," : ",/";  // 날짜에 빗금을 쓰면 빗금으로 안 자른다
  const out = [];
  let buf = "", depth = 0;
  for(const ch of s){
    if("([{".includes(ch)) depth++;
    else if(")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if(seps.includes(ch) && depth === 0){ out.push(buf.trim()); buf = ""; }
    else buf += ch;
  }
  if(buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/* 시각만 적힌 조각("14:00")은 앞 조각에 붙인다 — "2026.08.19(수), 14:00" 같은 경우 */
const TIME_ONLY_RE = /^[\s\d시:분초오전후~∼\-–()월화수목금토일요]*$/;

const BRIEF_FULL_RES = [
  /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
  /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/,
  /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/,
  /(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s*\(/
];

function mkDate(y, m, d){
  const v = new Date(y, m - 1, d);
  return (v.getFullYear() === y && v.getMonth() === m - 1 && v.getDate() === d) ? v : null;
}

/* 조각 하나에서 날짜들을 뽑는다. carry 는 앞 조각에서 물려받은 [연,월] —
   "08월 03일(월)"처럼 연도를 생략한 경우에 쓴다. */
function datesInPiece(text, carry){
  const got = [];
  let y = null, m = null, mt = null;
  for(const re of BRIEF_FULL_RES){
    mt = re.exec(text);
    if(mt){
      y = +mt[1]; m = +mt[2];
      const v = mkDate(y, m, +mt[3]);
      if(v) got.push(v);
      break;
    }
  }
  if(!got.length && (mt = /(?<!\d)(2\d)(\d{2})(\d{2})(?!\d)/.exec(text))){   // 260814
    y = 2000 + +mt[1]; m = +mt[2];
    const v = mkDate(y, m, +mt[3]);
    if(v) got.push(v);
  }
  if(!got.length && carry[0] && (mt = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text))){
    y = carry[0]; m = +mt[1];
    const v = mkDate(y, m, +mt[2]);
    if(v) got.push(v);
  }
  if(got.length && y && m && (mt = /[~∼]\s*(\d{1,2})\s*일/.exec(text))){      // "30일~31일" 의 끝날
    const v = mkDate(y, m, +mt[1]);
    if(v) got.push(v);
  }
  return { dates: got, carry: [y || carry[0], m || carry[1]] };
}

function today0(){ const t = new Date(); t.setHours(0, 0, 0, 0); return t; }

/* 일시 조각과 장소 조각을 짝짓는다. 짝을 못 지으면 null 을 돌려주고,
   그때는 일시와 장소를 원문 통째로 따로 보여준다.

   **순서대로 짝짓는 것을 기본으로 삼으면 안 된다.** 실제로 어긋나는 자료가 있다 —
   기장군 사업은 일시가 "장안읍…, 정관읍…, 철마면…" 순인데
   장소는 "기장읍…, 일광읍…, 장안읍…" 순이라 그대로 붙이면 틀린 안내가 된다.
   그래서 ① 일시에 지역 이름이 있으면 그 이름으로 찾아 짝짓고,
   ② 지역 이름이 아예 없고 회차가 3번 이상일 때만 순서대로 짝짓는다. */
const PLACE_HINT_RE = /[가-힣]{2,10}?(읍|면|동|리|시|군|구)(?![가-힣])/g;

function matchPlaces(pieces, places){
  if(!places.length || !pieces.length) return null;

  // ① 일시 조각에 적힌 지역 이름으로 찾기 (가장 구체적인 이름 = 마지막 것부터)
  const hints = pieces.map(t => (t.split(/\d/)[0] || "").match(PLACE_HINT_RE) || []);
  if(hints.some(h => h.length)){
    const out = [];
    for(let i = 0; i < pieces.length; i++){
      const list = hints[i].slice().reverse();
      let hit = null;
      for(const h of list){
        const found = places.filter(pl => pl.includes(h));
        if(found.length === 1){ hit = found[0]; break; }
      }
      if(!hit) return null;             // 하나라도 못 찾으면 통째로 포기한다
      out.push(hit);
    }
    return out;
  }

  // ② 지역 이름이 없는 목록형(예: 9회차) — 개수가 같고 3회 이상일 때만 순서대로
  if(places.length === pieces.length && pieces.length >= 3) return places.slice();
  return null;
}

/* 설명회 안내를 회차 단위로 정리한다.
   { items:[{when, place, date}], next, dday, past, upcoming, total, text } */
function briefInfo(p){
  const raw = (p.briefWhen || "").trim();
  const rawPlace = (p.briefPlace || "").trim();
  if(!raw) return { items:[], next:null, dday:null, past:false, upcoming:0, total:0, text:null, place:rawPlace || null };

  // 조각 나누기 (시각만 있는 조각은 앞에 붙인다)
  const pieces = [];
  splitSessions(raw).forEach(x => {
    // 날짜가 없고 시각만 있는 조각만 앞에 붙인다.
    // ("20260715(수) 10:00" 은 날짜가 있으므로 따로 둔다 — 붙이면 9회차가 한 덩어리가 된다)
    // (연도가 생략된 "08월 03일(월)~04일(화)" 도 붙이면 안 되므로 월·일이 있으면 제외한다)
    const noDate = datesInPiece(x, [null, null]).dates.length === 0 && !/\d\s*[월일]/.test(x);
    if(pieces.length && noDate && TIME_ONLY_RE.test(x)) pieces[pieces.length - 1] += ", " + x;
    else pieces.push(x);
  });
  const places = splitSessions(rawPlace);
  const matched = matchPlaces(pieces, places);

  const items = [];
  let carry = [null, null];
  pieces.forEach((text, i) => {
    const r = datesInPiece(text, carry);
    carry = r.carry;
    const pl = matched ? matched[i] : null;
    if(r.dates.length){
      r.dates.forEach((d, k) => items.push({ when:text, place:pl, date:d, extra:k > 0 }));
    }else{
      items.push({ when:text, place:pl, date:null, extra:false });
    }
  });
  const paired = !!matched;

  const t = today0();
  const future = items.filter(x => x.date && x.date >= t).sort((a, b) => a.date - b.date);
  const dated = items.filter(x => x.date);
  const next = future[0] || null;
  return {
    items, paired, next,
    dday: next ? Math.round((next.date - t) / 86400000) : null,
    past: !next && dated.length > 0,      // 날짜는 읽었는데 앞으로 남은 게 없다
    upcoming: future.length,
    total: items.length,
    text: raw,
    place: rawPlace || null
  };
}

/* 의견 받는 곳 — EIASS에 적힌 그대로 쓴다. 전화번호는 넣지 않는다.
   앞에 기관명을 붙이지 않는 이유: `org`는 협의기관(유역환경청)이고
   `deptName`은 사업자 쪽 부서라서, 붙이면
   "낙동강유역환경청 창원시청 도시계획과" 같은 없는 이름이 만들어진다.
   부서명만 적힌 몇 건은 기관을 알 수 없으므로 그대로 둔다(지어내지 않는다). */
function deptFull(p){
  return (p.deptName || "")
    .replace(/\(?\s*0\d{1,2}[-‑]\d{3,4}[-‑]\d{4}\s*\)?/g, "")   // 부서명 안에 박혀 있는 전화번호
    .replace(/\s*,\s*$/, "").replace(/\s{2,}/g, " ").trim() || null;
}

/* ============================================================
   설명회 · 공람 · 의견제출 정보
   EIASS 원문을 그대로 보여준다. (일시 표기가 사업마다 자유 형식이라 손대지 않는다)
   ============================================================ */
function participationSection(p){
  const b = briefInfo(p);
  const sessions = briefListHtml(b);   // 회차별로 짝지어 나눌 수 있으면 그 HTML, 아니면 null

  // [이름, 값, HTML 인가]
  const rows = [
    ["공람 기간", p.period, false],
    ["의견제출 기간", p.opinionPeriod, false],
    ["공람 장소", p.viewPlace, false],
    ...(sessions
      ? [[`설명회 ${b.items.length}회`, sessions, true]]
      : [["설명회 일시", p.briefWhen, false], ["설명회 장소", p.briefPlace, false]]),
    ["의견 받는 곳", deptFull(p), false]
  ].filter(([, v]) => v);

  if(!rows.length) return null;
  return {
    title: "공람 · 설명회",
    hint: !b.text ? ""
      : (/생략/.test(b.text) ? "설명회 없음"
        : b.upcoming ? `설명회 ${b.upcoming}회 남음`
          : b.past ? "설명회 지남" : "설명회 있음"),
    body: rows.map(([k, v, isHtml]) => `
      <div class="eia-row"><p class="k">${esc(k)}</p>${isHtml ? v : `<p class="v">${esc(v)}</p>`}</div>`).join("")
  };
}

/* 설명회를 회차별로 "일시 — 장소" 한 줄씩 나눈다.
   짝을 못 지었거나 한 번뿐이면 null 을 돌려주고, 그때는 원문 두 줄을 그대로 낸다. */
function briefListHtml(b){
  if(!b.paired || b.items.length < 2) return null;
  const t = today0();
  const seen = new Set();
  const lis = b.items.filter(i => {                      // 날짜 범위로 두 번 들어온 회차는 한 번만
    const key = i.when + "|" + (i.place || "");
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(i => `
    <li${i.date && i.date < t ? ' class="past"' : ""}>
      <span class="bs-when">${esc(i.when)}${i.date && i.date < t ? ` <span class="brief-past">지남</span>` : ""}</span>
      ${i.place ? `<span class="bs-at">${esc(i.place)}</span>` : ""}
    </li>`).join("");
  return `<ul class="v brief-list">${lis}</ul>`;
}

/* 선형 사업의 구간 목록 (시점 → 종점, 연장) */
function segmentsSection(p){
  if(!p.segments.length) return null;
  return {
    title: "구간",
    hint: `${p.segments.length}개 구간 (시점 · 종점)`,
    body: p.segments.map((s, i) => `
      <div class="eia-row">
        <p class="k">구간 ${i + 1}${s.length ? " · " + esc(s.length) : ""}</p>
        <p class="v">시점 ${esc(s.from)}<br>종점 ${esc(s.to)}</p>
      </div>`).join("")
  };
}

/* ============================================================
   의견 제출 — EIASS 주민의견등록으로 보내기
   EIASS는 본인인증 로그인이 필요해서 우리 화면에서 직접 접수할 수 없다.
   그래서 해당 사업 페이지까지 데려다주고, 남은 단계를 안내한다.
   ============================================================ */
let opinionTarget = null;

function openOpinion(id){
  const p = PROJECTS.find(x => String(x.id) === String(id));
  if(!p) return;
  opinionTarget = p;
  $("#opinionBody").innerHTML = `
    <p style="margin-bottom:14px"><b>${esc(p.name)}</b></p>
    ${p.opinionPeriod ? `<p style="margin-bottom:14px">의견을 받는 기간은 <b>${esc(p.opinionPeriod)}</b>입니다.
      이 기간이 지나면 접수되지 않습니다.</p>` : ""}
    <h4>의견은 EIASS에서 접수합니다</h4>
    <p>이 서비스는 안내만 하고, 실제 접수는 환경영향평가 정보지원시스템(EIASS)에서 이루어집니다.
      EIASS는 <b>본인인증 로그인</b>이 필요합니다.</p>
    <ol>
      <li>아래 <b>EIASS로 이동</b>을 누르면 이 사업의 페이지가 새 창에서 열립니다.</li>
      <li>그 페이지에서 <b>주민의견수렴</b> 탭을 누릅니다.</li>
      <li><b>주민의견등록</b>을 누르고 본인인증 후 의견을 작성합니다.</li>
    </ol>
    <h4>이렇게 쓰면 검토에 반영되기 쉽습니다</h4>
    <p>소음, 교통, 먼지, 일조, 생활환경 등 <b>내가 겪을 일을 구체적으로</b> 적습니다.
      "언제, 어디서, 어떤 점이 걱정된다"처럼 쓰면 좋습니다.</p>
    ${deptFull(p) ? `<p style="margin-top:12px">이 사업의 의견을 받는 곳은
      <b>${esc(deptFull(p))}</b>입니다. 연락처는 EIASS 원문 페이지에 있습니다.</p>` : ""}`;
  openModal("m-opinion");
}
$("#btn-opinion-go").addEventListener("click", () => {
  if(opinionTarget) openEiassSource(opinionTarget);
});

/* ============================================================
   홈 — 대시보드 숫자 / 알림줄
   ============================================================ */
function updateFilterCounts(){
  const base = scopedProjects();
  const counts = { all: base.length };
  base.forEach(p => { counts[p.type] = (counts[p.type] || 0) + 1; });
  $$("[data-filter]").forEach(chip => {
    const cnt = chip.querySelector(".cnt");
    if(cnt) cnt.textContent = counts[chip.dataset.filter] || 0;
  });
}

function updateDashboardStats(){
  const rows = scopedProjects();
  const openRows = rows.filter(p => p.dday !== null);
  $("#stat-open").dataset.count = openRows.length;
  $("#h-count").textContent = rows.length;

  // 범위 밖 사업 수는 '전국 개발사업' 칸이 없어졌으므로 이 칸 아래에 함께 적는다.
  const outside = PROJECTS.length - rows.length;
  let note = openRows.length
    ? esc(`가장 빠른 의견 마감 D-${Math.min(...openRows.map(p => p.dday))}`) : "";
  // '밖에 N건 더 있음'은 따로 감싼다 — 휴대폰에서는 이 부분만 숨긴다.
  // 좁은 화면에서는 지금 보는 것 말고 다른 것까지 알려 주면 글자만 빽빽해진다.
  if(homeScope !== "all" && outside > 0){
    note += `<span class="stat-outside">${note ? " · " : ""}` +
      esc(`${homeScope === "region" ? "이 동네" : "반경"} 밖에 ${outside}건 더 있음`) + `</span>`;
  }
  $("#stat-open-note").innerHTML = note;

  // 협의 진행 중 — EIASS 사업조회에서 세어 온 전국 건수 (우리 동네 범위와 무관)
  const ur = UNDER_REVIEW;
  $("#stat-nego").dataset.count = ur.total || 0;
  $("#stat-nego-note").textContent = ur.total
    ? ["strat", "main", "small"].filter(k => ur[k] != null)
        .map(k => `${REVIEW_SHORT[k]} ${ur[k].toLocaleString()}`).join(" · ")
    : "아직 수집하지 않음";

  // 예정 설명회 — 사업이 아니라 **설명회 횟수**를 센다.
  // 한 사업이 여러 지역에서 여러 번 열기 때문에 사업 수보다 많을 수 있다.
  const briefs = openRows.map(p => briefInfo(p));
  const events = briefs.reduce((n, b) => n + b.upcoming, 0);
  const nextDdays = briefs.map(b => b.dday).filter(v => v !== null);
  const unknown = briefs.filter(b => b.dday === null && !b.past).length;
  $("#stat-events").dataset.count = events;
  $("#stat-events-note").textContent = nextDdays.length
    ? `가장 빠른 설명회 ${Math.min(...nextDdays) === 0 ? "오늘" : "D-" + Math.min(...nextDdays)}`
      + (unknown ? ` · 일시 미정 ${unknown}건` : "")
    : (unknown ? `일시가 정해진 설명회가 없습니다` : "남은 설명회가 없습니다");
  countUp();
}

/* 내 동네 카드 아래 숫자 세 개.
   EIASS에서 오지 않는 값(주민 의견 수 등)은 넣지 않고, 수집한 것만 계산해 보여준다. */
function renderHoodFoot(){
  const dists = PROJECTS.map(p => p.nearDist).filter(d => d != null);
  $("#v-nearest").innerHTML = dists.length
    ? `${Math.min(...dists).toFixed(1)}<small>km</small>` : "—";

  const ddays = PROJECTS.map(p => p.dday).filter(d => d !== null);
  $("#v-soonest").innerHTML = ddays.length
    ? `${Math.min(...ddays)}<small>일 뒤</small>` : "—";
}

function renderDashTick(){
  const soon = scopedProjects().filter(p => p.dday !== null)
    .sort((a, b) => a.dday - b.dday).slice(0, 2);
  const box = $("#dashTick");
  if(!soon.length){
    box.innerHTML = `<div class="tick"><span class="msg">${scopeWhere(homeScope)} 의견을 낼 수 있는 사업이 없습니다.</span></div>`;
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
  let rows = scopedProjects()
    .filter(p => filter === "all" || p.type === filter);
  if(query){
    const q = query.toLowerCase();
    rows = rows.filter(p => (p.name + p.typeLabel + p.where).toLowerCase().includes(q));
  }
  rows.sort((a, b) => {
    if(sortBy === "dist"){
      if(a.nearDist == null && b.nearDist == null) return 0;
      if(a.nearDist == null) return 1;
      if(b.nearDist == null) return -1;
      return a.nearDist - b.nearDist;
    }
    return (a.dday === null) - (b.dday === null) || (a.dday ?? 999) - (b.dday ?? 999);
  });
  return rows;
}

/* ============================================================
   페이지 나누기
   목록이 길어서 한 화면에 다 깔면 아래로 한없이 이어진다.
   per = 0 이면 "전체"라서 나누지 않는다.
   ============================================================ */
const PAGER = {
  proj: { page:1, per:6 },
  open: { page:1, per:5 }
};

/* 필터·검색·범위가 바뀌면 보던 페이지 번호는 의미가 없어진다. */
function resetPages(){ PAGER.proj.page = 1; PAGER.open.page = 1; }

function pageSlice(rows, st){
  if(!st.per) return { rows, pages:1, from:1, to:rows.length };
  const pages = Math.max(1, Math.ceil(rows.length / st.per));
  st.page = Math.min(Math.max(1, st.page), pages);
  const from = (st.page - 1) * st.per;
  return { rows: rows.slice(from, from + st.per), pages, from: from + 1, to: Math.min(from + st.per, rows.length) };
}

/* 화살표는 EIASS 원본(docs/reference)의 캐러셀 단추와 같은 모양을 쓴다. */
const CHEV_L = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"></path></svg>`;
const CHEV_R = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>`;

/* 페이지 번호 줄을 그린다. 번호가 많으면 앞뒤 두 칸씩만 보여준다. */
function renderPager(sel, key, cut, total){
  const box = $(sel);
  if(!box) return;
  if(total === 0 || cut.pages <= 1){
    box.innerHTML = total ? `<p class="pager-count">모두 ${total}건</p>` : "";
    return;
  }
  const st = PAGER[key], cur = st.page;
  const nums = [];
  for(let i = 1; i <= cut.pages; i++){
    if(i === 1 || i === cut.pages || Math.abs(i - cur) <= 2) nums.push(i);
    else if(nums[nums.length - 1] !== "…") nums.push("…");
  }
  box.innerHTML = `
    <p class="pager-count">${total}건 중 <b>${cut.from}–${cut.to}</b>번째</p>
    <div class="pager-btns">
      <button type="button" class="pg pg--nav" data-page="${cur - 1}" ${cur === 1 ? "disabled" : ""} aria-label="이전 페이지">${CHEV_L}</button>
      ${nums.map(n => n === "…"
        ? `<span class="pg-gap" aria-hidden="true">…</span>`
        : `<button type="button" class="pg${n === cur ? " on" : ""}" data-page="${n}"
             ${n === cur ? 'aria-current="page"' : ""} aria-label="${n}페이지">${n}</button>`).join("")}
      <button type="button" class="pg pg--nav" data-page="${cur + 1}" ${cur === cut.pages ? "disabled" : ""} aria-label="다음 페이지">${CHEV_R}</button>
    </div>`;
}

/* 페이지 단추와 '한 페이지에 N개' 고르는 칸을 한 번만 연결해 둔다. */
function bindPager(pagerSel, perSel, key, redraw, scrollTo){
  // 화면마다 '한 페이지에 몇 개'의 기본값이 다르다 (휴대폰은 더 적게).
  // 칸에 적힌 값을 그대로 따라간다 — 안 그러면 "5개"라고 써 놓고 6개가 나온다.
  const perEl = $(perSel);
  if(perEl && perEl.value !== undefined && perEl.value !== "") PAGER[key].per = Number(perEl.value);

  $(pagerSel).addEventListener("click", e => {
    const b = e.target.closest("[data-page]");
    if(!b || b.disabled) return;
    PAGER[key].page = Number(b.dataset.page);
    redraw();
    if(scrollTo) $(scrollTo).scrollIntoView({ behavior:"smooth", block:"start" });
  });
  $(perSel).addEventListener("change", e => {
    PAGER[key].per = Number(e.target.value);
    PAGER[key].page = 1;
    redraw();
  });
}

/* "새 사업이 올라왔습니다" 알림 줄.
   두 화면이 같은 칸(#newBanner)을 쓴다. 없는 화면에서는 $() 가 알아서 넘어간다. */
function renderNewBanner(){
  const box = $("#newBanner");
  if(!box || !box.classList) return;
  const rows = dataReady ? newProjects() : [];
  box.hidden = !rows.length;
  if(!rows.length) return;
  const where = isNation(currentHood) ? "전국에" : `${esc(hoodShort(currentHood))}에`;
  box.innerHTML = `
    <span class="nb-ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8Z"></path><path d="M13.7 21a2 2 0 0 1-3.4 0" stroke-linecap="round"></path></svg>
    </span>
    <span class="nb-t">${where} <b>새 사업 ${rows.length}건</b>이 올라왔습니다</span>
    <button class="btn btn--primary btn--sm btn--pill" type="button" id="btnNewGo">보기</button>
    <button class="nb-x" type="button" id="btnNewClose" aria-label="닫기">✕</button>`;
  $("#btnNewGo").addEventListener("click", () => {
    // 새 사업만 보여 주는 게 아니라, 목록으로 데려가고 NEW 딱지로 짚어 준다
    const el = document.getElementById("projects");
    if(el) el.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  $("#btnNewClose").addEventListener("click", markSeen);
}

function render(){
  const rows = visibleProjects();
  const grid = $("#projGrid");
  const cut = pageSlice(rows, PAGER.proj);
  renderPager("#projPager", "proj", cut, rows.length);

  if(!rows.length){
    const outside = PROJECTS.length;
    // 범위를 좁혀서 비었을 때만 '전국 보기' 버튼을 준다.
    // (검색어·유형 때문에 빈 것이면 범위를 넓혀도 소용없다)
    grid.innerHTML = homeScope !== "all" && outside && !query
      ? `<div class="proj-empty">
           <p>${scopeWhere(homeScope)}는 지금 공람 중인 사업이 없습니다.</p>
           <p style="margin-top:6px;font-size:var(--fs-body-s)">수집된 사업은 모두 ${outside}건입니다.
             ${homeScope === "region" ? "반경으로 넓혀 보거나, " : ""}아래 버튼으로 전국 사업을 볼 수 있어요.</p>
           <div class="proj-empty-btns">
             ${homeScope === "region" && !isNation(currentHood)
               ? `<button class="btn btn--ghost btn--sm btn--pill" type="button" id="btnShowNear">반경 ${esc(S.radiusKm)}km로 넓혀 보기</button>` : ""}
             <button class="btn btn--line btn--sm btn--pill" type="button" id="btnShowAll">전국 사업 모두 보기</button>
           </div>
         </div>`
      : `<p class="proj-empty">조건에 맞는 사업이 없습니다. 다른 유형을 눌러보세요.</p>`;
    const btn = $("#btnShowAll");
    if(btn) btn.addEventListener("click", () => setScope("all"));
    const near = $("#btnShowNear");
    if(near) near.addEventListener("click", () => setScope("near"));
    return;
  }

  // 홈 목록은 범위로 걸러 낸 목록이므로 '반경 밖' 표시가 뜻을 가진다
  grid.innerHTML = cut.rows.map(p => projCardHtml(p, { scope: homeScope })).join("");
}

/* 사업 카드 한 장.
   홈 목록과 '내가 담은 사업' 화면이 **같은 함수**를 쓴다.
   복사해 두면 한쪽만 고쳐져 두 화면이 서로 다른 것을 보여주게 된다.

   opts.closed = true  … 기한이 지난 사업 (담아 둔 것만 이렇게 들어온다)
                          흐리게 그리고, 거리·범위 밖 표시처럼 '지금 기준'인 것은 빼고,
                          지도 단추도 빼 준다 (지도에는 진행 중인 사업만 찍히기 때문).
   opts.scope         … '반경 밖' 표시를 붙일 기준 범위.
                          **범위로 걸러 낸 목록에서만 뜻이 있다.**
                          담은 사업 화면은 범위로 거르지 않으므로 넘기지 않는다 —
                          일부러 담아 둔 사업에 "반경 밖"이라고 하면
                          "왜 여기 있지?" 하게 된다 (2026-08-14에 실제로 그렇게 나왔다). */
function projCardHtml(p, opts = {}){
  const closed = !!opts.closed;
  const scope = opts.scope || null;
  const saved = isSaved(p.id);
  const dist = closed ? null : distText(p);
  return `
    <article class="proj${closed ? " proj--closed" : ""}" data-id="${esc(p.id)}">
      <button class="star${saved ? " on" : ""}" type="button" data-save="${esc(p.id)}"
        aria-pressed="${saved}" aria-label="${saved ? "담은 사업에서 빼기" : "담은 사업에 넣기"}"
        title="${saved ? "담은 사업에서 빼기" : "담은 사업에 넣기"}">
        <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"></path></svg>
      </button>
      <div class="badges">
        ${!closed && isNewProject(p) ? `<span class="badge badge--new">NEW</span>` : ``}
        <span class="badge ${p.badge} badge--dot">${esc(p.typeLabel)}</span>
        ${locTagHtml(p)}
        ${p.dday !== null
          ? `<span class="badge ${p.dday <= 3 ? "badge--live" : "badge--dday"}">D-${p.dday}</span>`
          : `<span class="badge badge--line">${esc(p.stage)}</span>`}
        ${p.viewClosed && !closed ? `<span class="badge badge--line">공람 종료 · 의견 접수 중</span>` : ``}${scope ? outsideBadge(p, scope) : ""}
      </div>
      <p class="ttl">${esc(p.name)}</p>
      <p class="desc">공람기간 ${esc(p.period)}${p.opinionEnd ? `<br><b class="op-end">의견 마감 ${esc(p.opinionEnd)}</b>` : ""}</p>
      <div class="rows">
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"></path><circle cx="12" cy="10" r="2.4"></circle></svg><span>${esc(p.where)}${dist ? " · 우리 집에서 " + esc(dist) : ""}</span></div>
        <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"></path><path d="M15 3v4h4"></path></svg><span>${esc(p.org)} · ${esc(p.stage)}</span></div>
      </div>
      <div class="foot">
        ${p.dday !== null ? `<button class="btn btn--primary btn--sm btn--pill" type="button" data-opinion="${esc(p.id)}">의견 제출</button>` : ``}
        <button class="btn btn--line btn--sm btn--pill" type="button" data-detail="${esc(p.id)}">자세히 보기</button>
        ${!closed && p.lat != null ? `<button class="btn btn--ghost btn--sm btn--pill" type="button" data-onmap="${esc(p.id)}">지도에서 보기</button>` : ``}
      </div>
    </article>`;
}

/* 카드/목록/상세 어디서든 같은 버튼이 같게 동작하도록 한 곳에서 처리한다. */
function bindProjectActions(rootSel, opts = {}){
  $(rootSel).addEventListener("click", e => {
    // 별표(담기)는 어느 화면에서 눌러도 같게 동작한다.
    const sv = e.target.closest("[data-save]");
    if(sv){ toggleSaved(sv.dataset.save); return; }
    const o = e.target.closest("[data-opinion]");
    if(o){
      if(opts.closeModal) closeModal($(opts.closeModal));
      openOpinion(o.dataset.opinion);
      return;
    }
    const d = e.target.closest("[data-detail]");
    if(d){ openDetail(d.dataset.detail); return; }
    // 마감일을 캘린더 파일로 받기 (구글 캘린더는 그냥 링크라 여기서 처리할 것이 없다)
    const c = e.target.closest("[data-cal-ics]");
    if(c){
      const p = findProject(c.dataset.calIcs);
      if(p) downloadIcs(`알리미-의견마감-${p.id}.ics`, [p]);
      return;
    }
    const m = e.target.closest("[data-onmap]");
    if(m){
      if(opts.closeModal) closeModal($(opts.closeModal));
      openMapScreen(m.dataset.onmap);
      return;
    }
    const s = e.target.closest("[data-eiass]");
    if(s){
      const p = findProject(s.dataset.eiass);
      if(p) openEiassSource(p);
    }
  });
}
bindProjectActions("#projGrid");

/* 주민 설명회 안내 목록
   "언제·어디서 열리고, 의견은 어디로 내면 되는지"를 앞에 내놓는다.

   정렬은 **공람 마감 임박 순**이다. 지난 설명회를 뒤로 보내지 않는다 —
   36건 중 17건이 이미 지난 설명회라, 뒤로 보내면 마감이 하루 남은 사업이
   목록 맨 아래로 내려간다. 설명회가 끝났어도 공람 기간 안이면 의견은 낼 수 있다.
   지난 것은 "지남" 표시를 붙이고 흐리게 해서 구분한다. */
function renderOpenList(){
  // 앞으로 열리는 설명회(가까운 순) → 일시를 알 수 없는 것 → 이미 지난 것
  const rank = b => b.next ? 0 : (b.past ? 2 : 1);
  const rows = scopedProjects().filter(p => p.dday !== null)
    .map(p => ({ p, brief: briefInfo(p) }))
    .sort((a, b) => rank(a.brief) - rank(b.brief)
      || ((a.brief.dday ?? 9999) - (b.brief.dday ?? 9999))
      || (a.p.dday - b.p.dday));
  const box = $("#openList");
  const note = $("#openListNote");
  note.textContent =
    homeScope === "region" ? `${hoodLabel(currentHood, false)} 안 기준`
    : homeScope === "near" ? (HOME.label ? `${HOME.label} 반경 ${S.radiusKm}km 기준` : "")
    : "전국 기준";

  const cut = pageSlice(rows, PAGER.open);
  renderPager("#openPager", "open", cut, rows.length);

  if(!rows.length){
    box.innerHTML = `<p class="proj-empty" style="border-radius:var(--r-md)">${scopeWhere(homeScope)} 의견을 낼 수 있는 사업이 없습니다.</p>`;
    return;
  }
  box.innerHTML = cut.rows.map(({ p, brief }) => `
    <div class="row-item${brief.past ? " row-item--past" : ""}">
      ${briefPillHtml(brief)}
      <div class="row-body">
        <p class="t">${esc(p.name)}</p>
        ${briefRowsHtml(p, brief)}
      </div>
      <div class="row-btns">
        <button class="btn btn--primary btn--sm btn--pill" type="button" data-opinion="${esc(p.id)}">의견 제출</button>
        <button class="btn btn--line btn--sm btn--pill" type="button" data-detail="${esc(p.id)}">자세히 보기</button>
      </div>
    </div>`).join("");
}

/* 왼쪽 알약 — 다음 설명회까지 남은 날. 날짜를 모르면 그렇게 적는다. */
function briefPillHtml(b){
  if(b.dday === null){
    // "타법에 의한 생략" 은 일정이 미정인 게 아니라 설명회를 아예 안 여는 경우다
    const label = b.past ? "지남" : (/생략/.test(b.text || "") ? "생략" : "미정");
    return `<span class="dpill done">${label}</span>`;
  }
  return `<span class="dpill ${b.dday <= 3 ? "urgent" : ""}">${b.dday === 0 ? "오늘" : "D-" + b.dday}</span>`;
}

/* 원문에 날짜가 아니라 사유가 적혀 있는 경우 — 뜻만 덧붙이고 원문은 그대로 둔다. */
const BRIEF_PLAIN = {
  "미정": "아직 정해지지 않았습니다",
  "타법에 의한 생략": "다른 법에 따라 설명회를 열지 않습니다"
};

function briefRowsHtml(p, b){
  const rows = [];
  const place = v => v ? ` <span class="brief-at">${esc(v)}</span>` : "";

  if(!b.text){
    rows.push(["설명회", `<span class="brief-none">원문에 안내가 없습니다</span>`]);
  }else if(BRIEF_PLAIN[b.text]){
    rows.push(["설명회", `${esc(b.text)} <span class="brief-none">— ${esc(BRIEF_PLAIN[b.text])}</span>`]);
  }else if(b.next){
    rows.push(["다음 설명회", `${esc(b.next.when)}${place(b.next.place)}`]);
    if(!b.next.place && b.place) rows.push(["장소", esc(b.place)]);
    if(b.upcoming > 1) rows.push(["그 밖에", `앞으로 ${b.upcoming - 1}회 더 있습니다`]);
  }else{
    rows.push(["설명회", `${esc(b.text)}${b.past ? ` <span class="brief-past">지남</span>` : ""}`]);
    if(b.place && b.place !== b.text) rows.push(["장소", esc(b.place)]);
  }
  const dept = deptFull(p);
  if(dept) rows.push(["의견 받는 곳", esc(dept)]);

  return `<dl class="brief">${rows.map(([k, v]) =>
    `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}
bindProjectActions("#openList");
bindPager("#projPager", "#projPerPage", "proj", render, "#projects");
bindPager("#openPager", "#openPerPage", "open", renderOpenList, "#participate");

/* 사업 상세 모달 */
/* 마감일을 캘린더에 넣는 칸. 기기마다 편한 길이 달라 **두 가지를 다** 준다. */
function calSectionHtml(p){
  const day = calDeadline(p);
  if(!day || p.dday === null) return "";     // 이미 기한이 지났으면 넣을 것이 없다
  const g = googleCalUrl(p);
  return `
    <div class="cal-box">
      <p class="cal-t">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M4 11h16"></path></svg>
        마감일을 캘린더에 넣어 두기
      </p>
      <p class="cal-h">${esc(day)}(의견 제출 마감)로 넣습니다. 사흘 전과 당일 아침에 폰이 알려 줍니다.</p>
      <div class="cal-btns">
        <button class="btn btn--primary btn--sm btn--pill" type="button" data-cal-ics="${esc(p.id)}">캘린더 파일 받기</button>
        ${g ? `<a class="btn btn--line btn--sm btn--pill" href="${esc(g)}" target="_blank" rel="noopener">구글 캘린더에 넣기 ↗</a>` : ""}
      </div>
      <p class="cal-h cal-h--sub">아이폰은 <b>캘린더 파일</b>, 갤럭시는 <b>구글 캘린더</b>가 편합니다.</p>
    </div>`;
}

function openDetail(id){
  // 담아 둔 사업은 기한이 지났을 수 있으므로 CLOSED_PROJECTS 까지 찾는다.
  const p = findProject(id);
  if(!p) return;
  $("#m-detail-t").textContent = p.name;
  $("#detailBody").innerHTML = `
    <div class="contact-card" style="margin-bottom:4px">
      <div class="contact-row"><span class="k">유형</span><span class="v">${esc(p.typeLabel)}</span></div>
      <div class="contact-row"><span class="k">위치</span><span class="v">${esc(p.where)}</span></div>
      <div class="contact-row"><span class="k">기관</span><span class="v">${esc(p.org)}</span></div>
      <div class="contact-row"><span class="k">공람기간</span><span class="v">${esc(p.period)}</span></div>
      ${p.opinionEnd ? `<div class="contact-row"><span class="k">의견 마감</span><span class="v">${esc(p.opinionEnd)}${p.dday !== null ? ` (D-${p.dday})` : ""}</span></div>` : ""}
    </div>
    ${tabsHtml([participationSection(p), segmentsSection(p), eiaSection(p)])}
    <p style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
      ${p.dday !== null ? `<button class="btn btn--primary btn--sm" type="button" data-opinion="${esc(p.id)}">의견 제출</button>` : ""}
      <button class="btn btn--line btn--sm" type="button" data-save="${esc(p.id)}">
        <span class="save-t">${isSaved(p.id) ? "담은 사업에서 빼기" : "이 사업 담아 두기"}</span>
      </button>
      ${p.open && p.lat != null ? `<button class="btn btn--line btn--sm" type="button" data-onmap="${esc(p.id)}">지도에서 보기</button>` : ""}
      ${p.sourceBizCd ? `<button class="btn btn--line btn--sm" type="button" data-eiass="${esc(p.id)}">EIASS 원문 페이지 열기 ↗</button>` : ""}
    </p>
    ${calSectionHtml(p)}`;
  openModal("m-detail");
}
bindProjectActions("#detailBody", { closeModal:"#m-detail" });

/* ============================================================
   내가 담은 사업 (화면 5)

   주민이 별표로 담아 둔 사업만 모아 본다.
   저장되는 것은 사업 번호뿐이고, 내용은 매번 data/projects.json 에서 다시 읽는다.

   ★ 기한이 지난 사업도 지우지 않는다.
     일부러 담아 둔 것이 어느 날 말없이 사라지면 담은 사람은 고장으로 여긴다.
     대신 아래쪽에 흐리게 따로 모으고 '기한이 지난 사업'이라고 밝힌다.
     환경영향분석은 여기서도 예외가 없다 — eiaSection() 이 공람 기간으로 잠근다.
   ============================================================ */

/* 담은 목록을 진행 중 / 기한 지남 / 자료 없음 세 갈래로 나눈다. */
function savedBuckets(){
  const open = [], closed = [];
  let missing = 0;
  SAVED_IDS.forEach(id => {
    const p = findProject(id);
    if(!p) { missing++; return; }          // EIASS 목록에서 아예 내려간 사업
    (p.open ? open : closed).push(p);
  });
  // 진행 중은 마감이 급한 것부터. 지켜보려고 담은 목록이라 이게 가장 쓸모 있다.
  open.sort((a, b) => (a.dday ?? 9999) - (b.dday ?? 9999));
  // 지난 것은 최근에 끝난 것부터
  closed.sort((a, b) => String(b.opinionEnd || "").localeCompare(String(a.opinionEnd || "")));
  return { open, closed, missing };
}

function renderSaved(){
  const { open, closed, missing } = savedBuckets();
  const grid = $("#savedGrid");

  $("#savedHead").textContent = SAVED_IDS.length
    ? `담아 둔 사업 ${open.length + closed.length}건`
    : "아직 담아 둔 사업이 없습니다";

  // 이 목록이 기기에 묶여 있다는 것은 반드시 알려야 한다.
  // 모르면 폰에서 담고 PC에서 열었을 때 "사라졌다"고 생각한다.
  $("#savedNote").innerHTML = SAVED_IDS.length
    ? `사업 카드의 <b>별표</b>를 눌러 담은 목록입니다.
       <b>이 목록은 지금 쓰고 있는 기기(브라우저)에만 저장됩니다</b> — 다른 기기에서는 보이지 않고,
       브라우저 기록을 지우면 함께 지워집니다.${missing ? `<br>자료가 더 이상 제공되지 않는 사업 ${missing}건은 표시하지 않았습니다.` : ""}`
    : "";

  // 담은 사업의 마감일을 **한 번에** 캘린더에 넣는 칸.
  // 여기가 가장 쓸모 있는 자리다 — 담아 둔 이유가 '마감을 놓치지 않는 것'이기 때문이다.
  //
  // ★ 휴대폰에만 둔다. 알림을 주는 것은 **폰 캘린더**라, 파일을 PC 로 받아 봐야
  //   정작 알림이 울려야 할 기기에는 안 들어간다. PC 에서는 위의 '구독' 하나로 충분하다.
  const calBox = $("#savedCal");
  if(calBox && calBox.classList && document.body.classList.contains("m")){
    const withDay = open.filter(p => calDeadline(p));
    calBox.hidden = !withDay.length;
    if(withDay.length){
      calBox.innerHTML = `
        <p class="cal-t">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M4 11h16"></path></svg>
          담은 사업 ${withDay.length}건의 마감일을 캘린더에 넣기
        </p>
        <p class="cal-h">사흘 전과 당일 아침에 폰이 알려 줍니다. 서비스가 알림을 보내는 것이 아니라
          <b>폰 캘린더가 알려 주는 것</b>이라, 이 화면을 안 열어도 됩니다.</p>
        <div class="cal-btns">
          <button class="btn btn--primary btn--sm btn--pill" type="button" id="btnSavedIcs">캘린더 파일 받기 (${withDay.length}건)</button>
        </div>
        <p class="cal-h cal-h--sub">아이폰은 받은 파일을 열면 바로 들어갑니다.
          갤럭시는 사업을 하나씩 열어 <b>구글 캘린더에 넣기</b>를 쓰는 편이 빠릅니다.</p>`;
      $("#btnSavedIcs").addEventListener("click", () => {
        downloadIcs("알리미-담은사업-마감일.ics", withDay);
      });
    }
  }else if(calBox && calBox.classList){
    calBox.hidden = true;   // PC — 위의 '구독'만 남긴다
  }

  // 큰 제목이 이미 "아직 담아 둔 사업이 없습니다"라고 말하고 있으므로
  // 여기서 같은 문장을 되풀이하지 않는다. 상자는 **어떻게 담는지**만 알려 준다.
  grid.innerHTML = open.length
    ? open.map(p => projCardHtml(p)).join("")
    : `<div class="proj-empty">
         ${closed.length ? `<p>의견을 낼 수 있는 사업은 없고, 기한이 지난 사업만 담겨 있습니다.</p>` : ""}
         <p${closed.length ? ` style="margin-top:6px;font-size:var(--fs-body-s)"` : ""}>
           사업 카드 오른쪽 위의 <b>별표(☆)</b>를 누르면 여기에 모입니다.
           마감일을 놓치지 않고 지켜보고 싶은 사업을 담아 두세요.</p>
         <div class="proj-empty-btns">
           <button class="btn btn--primary btn--sm btn--pill" type="button" id="btnSavedGoHome">사업 목록 보러 가기</button>
         </div>
       </div>`;
  const go = $("#btnSavedGoHome");
  if(go) go.addEventListener("click", () => {
    show("#scr-home");
    $("#projects").scrollIntoView({ behavior:"smooth", block:"start" });
  });

  $("#savedClosedWrap").hidden = !closed.length;
  $("#savedClosedGrid").innerHTML = closed.map(p => projCardHtml(p, { closed:true })).join("");
}
bindProjectActions("#savedGrid");
bindProjectActions("#savedClosedGrid");

/* 담기 상태가 바뀌면 화면 곳곳의 별표와 머리쪽 숫자를 함께 맞춘다.
   목록을 통째로 다시 그리지 않는 이유는 보고 있던 자리를 잃지 않기 위해서다. */
function syncSavedUi(){
  $$("[data-save]").forEach(b => {
    const on = isSaved(b.dataset.save);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    const label = on ? "담은 사업에서 빼기" : "담은 사업에 넣기";
    b.setAttribute("aria-label", label);
    b.setAttribute("title", label);
    const t = b.querySelector(".save-t");
    if(t) t.textContent = on ? "담은 사업에서 빼기" : "이 사업 담아 두기";
  });

  // 담은 개수는 헤더 메뉴와 목록 줄 두 곳에 같이 나온다 (헤더는 좁은 창에서 숨기 때문)
  const cnt = $("#savedCount");
  cnt.textContent = SAVED_IDS.length;
  cnt.hidden = !SAVED_IDS.length;
  $("#savedCount2").textContent = SAVED_IDS.length;

  // 담은 사업 화면을 보고 있는 중이면 목록도 다시 그린다 (별표를 빼면 그 자리에서 빠져야 한다)
  if($("#scr-saved").classList.contains("on")) renderSaved();
}

$("#btn-saved-back").addEventListener("click", () => show("#scr-home"));

$("#btn-saved-clear-closed").addEventListener("click", () => {
  const { closed } = savedBuckets();
  if(!closed.length) return;
  if(!confirm(`기한이 지난 사업 ${closed.length}건을 담은 목록에서 비울까요?`)) return;
  // 자료에서 사라진 번호도 이참에 함께 정리한다
  SAVED_IDS = SAVED_IDS.filter(id => {
    const p = findProject(id);
    return p && p.open;
  });
  lsSet(LSSAVED, SAVED_IDS);
  syncSavedUi();
  renderSaved();
});

$$("[data-filter]").forEach(c => c.addEventListener("click", () => {
  $$("[data-filter]").forEach(x => x.classList.remove("on"));
  c.classList.add("on");
  filter = c.dataset.filter;
  resetPages();
  render();
}));
$("#sortBtn").addEventListener("click", () => {
  sortBy = sortBy === "dist" ? "dday" : "dist";
  $("#sortLabel").textContent = sortBy === "dist" ? "가까운 순" : "마감 임박 순";
  resetPages();
  render();
});
function runSearch(){
  query = $("#q").value.trim();
  resetPages();
  render();
  $("#projects").scrollIntoView({ behavior:"smooth", block:"start" });
}
/* 좁은 화면에서는 검색칸 안내 문구가 잘려 보인다. 폭에 맞춰 짧은 문구로 바꾼다.
   (CSS로는 placeholder 글자를 바꿀 수 없어서 여기서 처리한다) */
const Q_HINT_WIDE = "사업명 / 사업유형으로 우리 동네 안에서 찾기";
const Q_HINT_NARROW = "사업명·유형으로 찾기";
function fitSearchHint(){
  $("#q").placeholder = innerWidth <= 560 ? Q_HINT_NARROW : Q_HINT_WIDE;
}
addEventListener("resize", fitSearchHint, { passive:true });
fitSearchHint();

$("#btn-search").addEventListener("click", runSearch);
$("#q").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); runSearch(); } });
$$("[data-kw]").forEach(b => b.addEventListener("click", () => { $("#q").value = b.dataset.kw; runSearch(); }));

/* ============================================================
   지도 — 공통
   ============================================================ */
/* ============================================================
   배경지도 종류 — 일반 / 위성

   **기본은 일반지도다.** 주민은 지명·도로명 '글자'로 위치를 알아본다.
   위성만 켜면 글자가 없어 "여기가 어디지"가 되므로, 위성은 반드시
   Hybrid(지명·도로 겹치기)와 **두 장 세트**로 올린다.

   그런데도 위성을 두는 이유는 일반지도가 못 하는 것을 하기 때문이다 —
   **"지금 저기가 어떤 땅인가"**(논밭인지 산인지 이미 개발된 곳인지).
   개발사업 알리미에서는 그것이 장식이 아니라 정보다.

   실측(2026-08-16, 타일 한 장): 일반 4~38KB / 위성 13~41KB + Hybrid 42~83KB.
   위성 쪽이 3배 넘게 무거워서 **기본으로 켜 둘 물건은 아니다.**
   VWorld 는 Base·Satellite·Hybrid·midnight 만 준다 (gray 는 안 됨). 모두 줌 6~19.
   ============================================================ */
/* ★ 지도는 **언제나 일반지도로 시작한다.** 고른 값을 기억하지 않는다.
   한 번 위성으로 바꾼 사람이 다음에 들어왔을 때도 위성으로 열리면,
   주민은 그것이 이 서비스의 기본 화면인 줄 안다. 위성은 지명 글자가 없어서
   "여기가 어디지"가 되므로 **첫 화면으로는 맞지 않다.**
   (담당자용 route_editor.html 은 예외로 기억한다 — 거기서는 기준점을 잡느라 위성을 계속 쓴다) */
let mapLayerKind = "base";

function vworldTileUrl(kind){
  const layer = kind === "sat" ? "Satellite" : "Base";
  const ext = kind === "sat" ? "jpeg" : "png";   // 위성만 jpeg 다. 헷갈리기 쉽다
  return `https://api.vworld.kr/req/wmts/1.0.0/${S.vworldKey}/${layer}/{z}/{y}/{x}.${ext}`;
}
function vworldHybridUrl(){
  return `https://api.vworld.kr/req/wmts/1.0.0/${S.vworldKey}/Hybrid/{z}/{y}/{x}.png`;
}
function isSat(){ return mapLayerKind === "sat"; }

/* 지도 색은 자바스크립트에서 정하지만 **값은 tokens.css 에서 읽어 온다.**
   여기에 hex 를 새로 적으면 디자인 토큰이 두 벌이 된다. */
function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* 위성 위에서는 선 색을 바꿔야 한다.
   초록 점선 동네 경계가 **초록 산 위에서 그냥 사라진다.** 색 문제라 CSS 로는 못 막는다. */
function boundStyle(){
  return isSat()
    ? { color:"#ffffff", weight:2.6, dashArray:"6 4", opacity:1,
        fillColor:"#ffffff", fillOpacity:.06, interactive:false }
    : boundStyleNormal();
}
function radiusStyle(){
  // 위성에서도 옅게 가지 않는다 (안개처럼 보인다). 같은 파랑 계열의 **채도 높은** 색을 쓴다.
  return isSat()
    ? { color:cssVar("--accent"), weight:2.4, dashArray:"6 5",
        fillColor:cssVar("--accent"), fillOpacity:.05 }
    : { color:cssVar("--p50"), weight:1.4, dashArray:"5 5",
        fillColor:cssVar("--p50"), fillOpacity:.05 };
}
/* 사업 마커는 **핀(물방울) 모양**이다.
   원·마름모로 그렸을 때는 지도에 '칠해진 것'처럼 보여서, 특히 위성 위에서 묻혔다.
   핀은 뾰족한 끝이 자리를 가리키고 그림자로 떠 있어 **지도에 꽂힌 물건**으로 읽힌다.
   구글·네이버·카카오·애플이 모두 이렇게 하는 이유다.

   예외 두 가지:
   · 우리 집 — 핀이 아니라 **동그란 점**이다. 지도 앱들이 '현재 위치'를 그렇게 그린다.
     사업(핀)과 내 자리(점)를 모양으로 갈라 두면 헷갈리지 않는다.
   · dot — 미니 지도용 작은 점. 그 지도는 아주 작아서 핀을 넣으면 서로 겹친다. */
function markerIcon(type, on, dot){
  if(dot || type === "home"){
    const size = dot ? 8 : 15;
    return L.divIcon({
      className: "",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<div class="mk mk--${type}${on ? " mk--on" : ""}${dot ? " mk--dot" : ""}"></div>`
    });
  }
  const w = on ? 30 : 25, h = on ? 41 : 34;
  return L.divIcon({
    className: "",
    iconSize: [w, h],
    iconAnchor: [w / 2, h],        // 뾰족한 끝이 실제 위치다 (가운데가 아니다)
    html: `<div class="pin pin--${type}${on ? " pin--on" : ""}">
      <svg viewBox="0 0 24 34" width="${w}" height="${h}" aria-hidden="true">
        <path class="pin-body" d="M12 1.2c-6 0-10.8 4.8-10.8 10.8 0 7.7 9.3 19 10.2 20.1.3.4.9.4 1.2 0
          .9-1.1 10.2-12.4 10.2-20.1C22.8 6 18 1.2 12 1.2Z"/>
        <circle class="pin-eye" cx="12" cy="11.8" r="4"/>
      </svg></div>`
  });
}

/* Leaflet 마커는 키보드로 고를 수 있는 단추가 되는데 이름이 없으면
   화면을 못 보는 사람에게 "단추"라고만 읽힌다. 사업명을 붙여 준다. */
function nameMarker(marker, label){
  const el = marker.getElement();
  if(el) el.setAttribute("aria-label", label);
  return marker;
}

/* 마커 모양을 바꾸면 Leaflet 이 요소를 새로 만들기 때문에 이름을 다시 붙여야 한다. */
function setMarkerState(marker, p, on){
  marker.setIcon(markerIcon(p.type, on));
  nameMarker(marker, `${p.typeLabel} · ${p.name}`);
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
let gisCircleCasing = null;   // 위성일 때 반경 원 밑에 까는 어두운 테두리
let selectedId = null;

function gisProjects(){
  const rows = PROJECTS.filter(p => p.lat != null).filter(scopeTest(mapScope));
  return rows.sort((a, b) => (a.nearDist ?? 1e9) - (b.nearDist ?? 1e9));
}

function ensureGisMap(){
  if(gisMap || typeof L === "undefined") return gisMap;
  // Leaflet 은 id 로 요소를 직접 찾으므로, 없으면 여기서 멈춘다 (죽지 않게)
  const box = document.getElementById("gisMap");
  if(!box) return null;
  box.innerHTML = "";
  // VWorld 배경지도(WMTS)는 줌 6~19만 지원한다. 그보다 낮으면 타일 대신
  // 오류 응답이 와서 지도가 빈 채로 보인다. minZoom 을 걸어 fitBounds 가
  // 절대 그 아래로 내려가지 않게 막는다 (2026-08-06 전국 미니지도에서 겪음).
  gisMap = L.map("gisMap", { zoomControl:true, attributionControl:true, minZoom:6 });
  applyMapLayer();
  gisMap.setView([HOME.lat, HOME.lon], 12);
  return gisMap;
}

/* 배경지도를 지금 고른 종류로 갈아 끼운다.
   위성은 Hybrid(지명·도로)를 **위에 한 장 더** 올린다 — 없으면 글자가 하나도 없다. */
let gisBaseLayer = null, gisLabelLayer = null;
function applyMapLayer(){
  if(!gisMap) return;
  if(gisBaseLayer){ gisMap.removeLayer(gisBaseLayer); gisBaseLayer = null; }
  if(gisLabelLayer){ gisMap.removeLayer(gisLabelLayer); gisLabelLayer = null; }
  gisBaseLayer = L.tileLayer(vworldTileUrl(mapLayerKind),
    { minZoom:6, maxZoom:19, attribution:"ⓒ VWorld" }).addTo(gisMap);
  if(isSat()){
    gisLabelLayer = L.tileLayer(vworldHybridUrl(), { minZoom:6, maxZoom:19 }).addTo(gisMap);
  }
  const box = document.getElementById("gisMap");
  if(box) box.classList.toggle("gis-map--sat", isSat());
  const btn = $("#btnMapLayer");
  if(btn){
    btn.textContent = isSat() ? "일반지도" : "위성지도";
    btn.setAttribute("aria-label", isSat() ? "일반지도로 바꾸기" : "위성지도로 바꾸기");
    btn.setAttribute("aria-pressed", String(isSat()));
  }
}

function toggleMapLayer(){
  // 이번 방문에만 바뀐다. 저장하지 않는다 (위 주석 참고)
  mapLayerKind = isSat() ? "base" : "sat";
  applyMapLayer();
  // 선 색이 배경에 따라 달라지므로 이미 그려 둔 것을 다시 그린다
  renderGisMarkers(false);
  drawRoutes();
}

/* ============================================================
   사업 노선(도형)
   우선순위: 관리자가 직접 그린 것 > 수집한 하천 도형
   ============================================================ */
const LSROUTES = "wdn.routes";

/* 직접 지정한 노선.
   data/routes.json (모두에게 보이는 것) 을 먼저 깔고,
   그 위에 이 브라우저에서 작업 중인 것(localStorage)을 덮어쓴다. */
let fileRoutes = {};
let localRoutes = lsGet(LSROUTES, {});
let manualRoutes = Object.assign({}, localRoutes);

async function loadRoutes(){
  try{
    const res = await fetch(S.routePath, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    fileRoutes = json.routes || {};
  }catch(e){
    fileRoutes = {};   // 파일이 없는 게 정상이다 (아직 아무도 노선을 지정하지 않은 상태)
  }
  manualRoutes = Object.assign({}, fileRoutes, localRoutes);
  if(gisMap){ drawRoutes(); renderGisDetail(); }
}

function routeOf(p){
  const manual = manualRoutes[String(p.id)];
  if(manual) return { geoms:[manual], source:"manual" };
  if(p.routeGeom && p.routeGeom.length) return { geoms:p.routeGeom, source:p.routeSource || "auto" };
  return null;
}

/* GeoJSON 은 [경도,위도] 순서, Leaflet 은 [위도,경도] 순서라 뒤집어 준다. */
function toLatLngs(coords){
  if(!coords || !coords.length) return [];
  if(typeof coords[0][0] === "number") return coords.map(c => [c[1], c[0]]);
  return coords.map(toLatLngs);
}

let routeLayers = [];

function drawRoutes(){
  if(!gisMap) return;
  routeLayers.forEach(l => gisMap.removeLayer(l));
  routeLayers = [];

  const rows = gisProjects();
  rows.forEach(p => {
    const r = routeOf(p);
    if(!r) return;
    const on = String(p.id) === String(selectedId);
    r.geoms.forEach(g => {
      const latlngs = toLatLngs(g.coordinates);
      const style = {
        color: on ? cssVar("--eco") : cssVar("--teal"),
        weight: on ? 4 : 2.5,
        opacity: on ? 0.95 : 0.6
      };
      // 위성 위에서는 초록·청록 선이 숲·물에 그대로 묻힌다.
      //
      // ★ 여기서도 한 번 잘못 갔다 — 선을 **옅은 색(--p10)** 으로 바꿨더니
      //   위성 사진 위에서 안개처럼 보였다. 지도 서비스들이 하는 방식은 반대다:
      //   **짙은 테두리 + 채도 높은 선** (구글 경로 = 선명한 파랑 + 짙은 파랑 테두리).
      //   옅게가 아니라 **선명하게** 가야 한다.
      if(isSat()){
        const casing = L.polyline(latlngs, {
          color:cssVar("--p90"), weight:style.weight + 4, opacity:.9, interactive:false
        }).addTo(gisMap);
        routeLayers.push(casing);
        // 고른 것과 안 고른 것은 **같은 파랑에서 굵기·진하기로** 가른다.
        // 빨강은 환경영향평가 핀이 쓰므로 노선에 쓰면 헷갈린다.
        style.color = cssVar("--accent");
        style.weight = on ? 5 : 3;
        style.opacity = on ? 1 : .8;
      }
      const layer = (g.type || "").includes("Polygon")
        ? L.polygon(latlngs, Object.assign({ fillOpacity:on ? 0.25 : 0.12 }, style))
        : L.polyline(latlngs, style);
      // Leaflet 툴팁은 HTML 로 그린다 — 자료에서 온 글자는 esc() 로 감싼다
      layer.bindTooltip(`${esc(p.name)}${g.name ? " · " + esc(g.name) : ""}`, { sticky:true });
      layer.on("click", () => selectProject(p.id, false));
      layer.addTo(gisMap);
      routeLayers.push(layer);
    });
  });
}

/* ============================================================
   동네 경계 그리기
   반경 원은 동그라미일 뿐이지만, 경계선은 "여기까지가 우리 동네"를 그대로 보여준다.
   ============================================================ */
/* 값을 미리 굳히지 않고 **부를 때 읽는다.** 맨 위에서 const 로 굳히면
   tokens.css 가 아직 적용되기 전이면 빈 값이 박힌 채로 남는다. */
function boundStyleNormal(){
  return {
    color:cssVar("--eco"), weight:2.2, dashArray:"6 4", opacity:.95,
    fillColor:cssVar("--eco"), fillOpacity:.07, interactive:false
  };
}
let boundLayer = null, miniBoundLayer = null;

/* 반경 원을 그릴 것인가 — **지금 고른 범위가 '반경'일 때만 그린다.**

   원은 "지금 무엇으로 거르고 있는지"를 보여주는 표시다. 그래서 범위에 따라간다:
     반경(near)  → 그린다. 5km 가 어디까지인지 눈으로 봐야 한다
     동네 안·전국 → 안 그린다. 그때는 원이 거르는 기준이 아닌데, 큰 점선 원이
                    화면을 덮어 정작 동네 경계가 작은 얼룩처럼 보인다(주안동에서 겪음)

   ※ 한때 '경계가 있으면 무조건 숨김'으로 만들었다가 되돌렸다 —
     반경을 직접 골라도 원이 안 나와서 5km 가 얼마인지 알 수 없었다. */
function showRadiusCircle(scope){
  return !isNation(currentHood) && scope === "near";
}

function drawBoundary(){
  if(gisMap){
    if(boundLayer){ gisMap.removeLayer(boundLayer); boundLayer = null; }
    if(HOOD_BOUNDARY){
      // 위성일 때는 흰 점선으로 바꾼다 (초록 선이 초록 산 위에서 사라진다)
      boundLayer = L.geoJSON(HOOD_BOUNDARY.geom, { style:boundStyle() }).addTo(gisMap);
      if(!isSat()) boundLayer.bringToBack();   // 위성에서는 뒤로 보내면 위성 타일에 묻힌다
    }
  }
  if(miniMap){
    if(miniBoundLayer){ miniMap.removeLayer(miniBoundLayer); miniBoundLayer = null; }
    if(HOOD_BOUNDARY){
      miniBoundLayer = L.geoJSON(HOOD_BOUNDARY.geom,
        { style:Object.assign({}, boundStyleNormal(), { weight:1.8 }) }).addTo(miniMap);
    }
  }
}

function renderGisMarkers(fit = true){
  if(!gisMap) return;
  gisMarkers.forEach(m => gisMap.removeLayer(m));
  gisMarkers = new Map();
  if(gisHomeMarker){ gisMap.removeLayer(gisHomeMarker); gisHomeMarker = null; }
  if(gisCircle){ gisMap.removeLayer(gisCircle); gisCircle = null; }
  if(gisCircleCasing){ gisMap.removeLayer(gisCircleCasing); gisCircleCasing = null; }

  // 동네를 안 정했으면(전국) '우리 집'도 반경 원도 그리지 않는다.
  // 설정 기본 좌표를 우리 집인 양 찍으면 엉뚱한 동네에 깃발이 꽂힌다.
  if(!isNation(currentHood)){
    gisHomeMarker = L.marker([HOME.lat, HOME.lon], { icon:markerIcon("home"), zIndexOffset:1000 })
      .addTo(gisMap).bindTooltip(esc(HOME.label || "우리 집"));
    nameMarker(gisHomeMarker, `우리 집 · ${HOME.label || "기준 위치"}`);
    if(showRadiusCircle(mapScope)){
      // 위성에서는 밝은 점선만으로는 밝은 땅(도시·갯벌)에서 흐려진다(대비 2.5).
      // 어두운 테두리를 한 겹 밑에 깔아 어느 배경에서든 한쪽이 보이게 한다.
      if(isSat()){
        gisCircleCasing = L.circle([HOME.lat, HOME.lon], {
          radius: S.radiusKm * 1000, color:cssVar("--p90"), weight:4,
          opacity:.75, fill:false, interactive:false
        }).addTo(gisMap);
      }
      gisCircle = L.circle([HOME.lat, HOME.lon],
        Object.assign({ radius: S.radiusKm * 1000 }, radiusStyle())).addTo(gisMap);
    }
  }

  drawBoundary();
  drawRoutes();

  const rows = gisProjects();
  rows.forEach(p => {
    const m = L.marker([p.lat, p.lon], { icon:markerIcon(p.type, p.id === selectedId) })
      .addTo(gisMap)
      .bindTooltip(esc(p.name), { direction:"top" });
    nameMarker(m, `${p.typeLabel} · ${p.name}`);
    m.on("click", () => selectProject(p.id, false));
    gisMarkers.set(String(p.id), m);
  });

  if(fit) fitGisView(rows);
}

/* 지도를 어디에 맞출지.

   ★ **사업 마커까지 다 담으려 하면 안 된다.**
     노선이 우리 동네를 스치는 사업은 대표 주소가 수십 km 떨어져 있을 수 있다.
     그 마커까지 담으면 축척이 확 벌어져서 **우리 집이 화면 구석으로 밀린다.**
     (실제로 두 번 겪었다 — 인천 경서동에서 파주 주소 마커 때문에 동네가 구석에 몰렸고,
      검단구 원당동에서도 우리 집이 왼쪽 아래에 치우쳐 찍혔다.)

   그래서 **지금 보고 있는 범위 그 자체**에 맞춘다:
     동네 안 → 경계에            반경 → 우리 집 ± 반경        전국 → 사업 전체 */
function fitGisView(rows){
  const nation = isNation(currentHood);
  const home = [HOME.lat, HOME.lon];

  if(!nation && mapScope === "region" && boundLayer){
    const b = boundLayer.getBounds();
    b.extend(home);
    gisMap.fitBounds(b, { padding:[40, 40] });
    return;
  }
  if(!nation && mapScope === "near"){
    // 우리 집이 한가운데 오도록 반경만큼만 잡는다. 경계가 있으면 그것까지 담는다.
    const b = L.latLng(HOME.lat, HOME.lon).toBounds(S.radiusKm * 2000);
    if(boundLayer) b.extend(boundLayer.getBounds());
    gisMap.fitBounds(b, { padding:[30, 30] });
    return;
  }
  // 전국을 보는 중 — 사업들이 다 들어오게. 동네를 정했으면 우리 집도 함께.
  const pts = rows.map(p => [p.lat, p.lon]);
  if(!nation) pts.unshift(home);
  if(pts.length > 1) gisMap.fitBounds(pts, { padding:[50, 50] });
  else if(pts.length === 1) gisMap.setView(pts[0], 13);
  else gisMap.setView(KOREA_CENTER, 7);
}

function gisItemHtml(p){
  return `
    <button class="gis-item${p.id === selectedId ? " on" : ""}" type="button" data-gis="${esc(p.id)}">
      <span class="gis-item-tags">
        <span class="badge ${p.badge} badge--dot">${esc(p.typeLabel)}</span>
        ${locTagHtml(p)}
      </span>
      <span class="t">${esc(p.name)}</span>
      <span class="m">${distText(p) ? esc(distText(p)) : "거리 모름"}${p.dday !== null ? ` · D-${p.dday}` : ""}</span>
    </button>`;
}

/* 왼쪽 목록 — '우리 동네'와 '그 밖의 지역'을 나눠 보여준다.
   나누는 기준은 지금 고른 범위를 따른다.
   전국을 보는 중이면 동네가 정해져 있는지에 따라 구역/반경 중 알맞은 쪽으로 나눈다. */
function localTest(){
  if(isNation(currentHood)) return null;
  if(mapScope !== "all") return scopeTest(mapScope);
  return (hoodDong(currentHood) || hoodSgg(currentHood)) ? inHood : isNearby;
}

function renderGisList(){
  const rows = gisProjects();
  const box = $("#gisList");
  const test = localTest();

  if(!test){   // 전국을 보고 있어 나눌 기준이 없다
    box.innerHTML = `<p class="gis-list-head">전국 · ${rows.length}건</p>`
      + (rows.length ? rows.map(gisItemHtml).join("")
        : `<p class="gis-empty">지도에 표시할 사업이 없습니다.</p>`);
    return;
  }

  const near = rows.filter(test);
  const far = rows.filter(p => !test(p));
  const localName = (mapScope === "near" || (mapScope === "all" && test === isNearby))
    ? `${esc(HOME.label || "내 동네")} 반경 ${esc(S.radiusKm)}km`
    : `${esc(hoodLabel(currentHood, false))} 안`;

  let html = `<p class="gis-list-head">${localName} · ${near.length}건</p>`;
  html += near.length
    ? near.map(gisItemHtml).join("")
    : `<p class="gis-empty">${localName} 에는 공람 중인 사업이 없습니다.${
        far.length ? "<br>아래 '그 밖의 지역'에서 확인해 보세요." : ""}</p>`;

  if(far.length){
    html += `<p class="gis-list-head gis-list-head--out">그 밖의 지역 · ${far.length}건</p>`;
    html += far.map(gisItemHtml).join("");
  }else if(mapScope !== "all"){
    html += `<p class="gis-empty">위쪽 <b>전국</b>을 누르면 다른 지역 사업도 보입니다.</p>`;
  }
  box.innerHTML = html;
}
$("#gisList").addEventListener("click", e => {
  const b = e.target.closest("[data-gis]");
  if(b) selectProject(b.dataset.gis, true);
});

/* 왼쪽 패널을 목록 화면 / 상세 화면 중 하나로 바꾼다.
   #scr-map 에 붙는 on-detail 표시는 **휴대폰에서만** 뜻이 있다.
   (좁은 화면에서는 지도와 사업 내용을 한 화면에 같이 두면 둘 다 못 쓴다.
    넓은 화면에서는 이 표시가 붙어도 아무 일도 일어나지 않는다 — CSS가
    @media (max-width:560px) 안에서만 반응하기 때문이다) */
function showGisPane(which){
  $("#gisList").hidden = which !== "list";
  $("#gisDetail").hidden = which !== "detail";
  $("#scr-map").classList.toggle("on-detail", which === "detail");
  $(".gis-side-body").scrollTop = 0;
}

const ROUTE_SOURCE_TEXT = {
  manual: "관리자가 지도에서 직접 그린 노선입니다.",
  "vworld-river": "요약문에 적힌 하천 이름으로 국가 하천 자료(VWorld)에서 찾은 실제 하천 모양입니다. 사업 구간만 잘라낸 것이 아니라 하천 전체가 표시됩니다."
};

function renderGisDetail(){
  const box = $("#gisDetail");
  const p = PROJECTS.find(x => String(x.id) === String(selectedId));
  if(!p){ box.innerHTML = ""; return; }
  const r = routeOf(p);
  box.innerHTML = `
    <div class="gis-detail-nav">
      <button class="gis-detail-back" type="button" id="btn-gis-back-list">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>
        목록으로
      </button>
      <!-- 휴대폰에서는 상세를 보는 동안 지도가 감춰지므로 되돌아갈 길을 준다 -->
      <button class="btn btn--line btn--sm btn--pill gis-to-map" type="button" id="btn-gis-to-map">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5Z"></path><path d="M9 4v13M15 6.5v13"></path></svg>
        지도 보기
      </button>
    </div>
    <p class="gis-detail-tags">
      <span class="badge ${p.badge} badge--dot">${esc(p.typeLabel)}</span>
      ${locTagHtml(p)}
      ${p.dday !== null ? `<span class="badge ${p.dday <= 3 ? "badge--live" : "badge--dday"}">D-${p.dday}</span>` : ""}
      ${outsideBadge(p, mapScope)}
    </p>
    <p class="ttl">${esc(p.name)}</p>
    <div class="kv"><span class="k">위치</span><span class="v">${esc(p.where)}</span></div>
    <div class="kv"><span class="k">거리</span><span class="v">${distText(p) ? "우리 집에서 " + esc(distText(p)) : "모름"}</span></div>
    ${p.bizType ? `<div class="kv"><span class="k">사업구분</span><span class="v">${esc(p.bizType)}</span></div>` : ""}
    <div class="kv"><span class="k">기관</span><span class="v">${esc(p.org)}</span></div>
    ${r ? `<div class="kv"><span class="k">노선</span><span class="v">${esc(ROUTE_SOURCE_TEXT[r.source] || "지도에 표시된 노선입니다.")}</span></div>` : ""}
    ${p.dday !== null ? `
      <button class="btn btn--primary btn--sm btn--block" type="button"
              data-opinion="${esc(p.id)}" style="margin-top:16px">의견 제출하기</button>` : ""}
    <!-- 지도를 보다 발견한 사업도 그 자리에서 담을 수 있게 한다 -->
    <button class="btn btn--line btn--sm btn--block" type="button"
            data-save="${esc(p.id)}" style="margin-top:8px">
      <span class="save-t">${isSaved(p.id) ? "담은 사업에서 빼기" : "이 사업 담아 두기"}</span>
    </button>
    ${tabsHtml([participationSection(p), segmentsSection(p), eiaSection(p)])}
    ${p.sourceBizCd ? `
      <button class="eiass-link" type="button" data-eiass="${esc(p.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>
        EIASS 원문 페이지 열기
      </button>` : ""}`;
  $("#btn-gis-back-list").addEventListener("click", backToGisList);
  // '지도 보기'는 고른 사업을 그대로 둔 채 지도만 다시 보여준다.
  $("#btn-gis-to-map").addEventListener("click", () => {
    showGisPane("list");
    if(gisMap) setTimeout(() => gisMap.invalidateSize(), 60);
  });
}
bindProjectActions("#gisDetail");

/* 상세에서 목록으로 되돌아간다. 고른 사업이 없어지므로 강조와
   '노선 직접 그리기' 버튼도 함께 끈다. */
function backToGisList(){
  selectedId = null;
  gisMarkers.forEach((m, key) => {
    const q = PROJECTS.find(x => String(x.id) === key);
    if(q) setMarkerState(m, q, false);
  });
  drawRoutes();
  renderGisList();
  renderGisDetail();
  showGisPane("list");
  exitRouteEdit();
}

function selectProject(id, moveMap){
  selectedId = String(id);
  // 마커 강조를 위해 아이콘만 갈아끼운다
  gisMarkers.forEach((m, key) => {
    const p = PROJECTS.find(x => String(x.id) === key);
    if(p) setMarkerState(m, p, key === selectedId);
  });
  const p = PROJECTS.find(x => String(x.id) === selectedId);
  if(p && gisMap && moveMap && p.lat != null){
    gisMap.setView([p.lat, p.lon], Math.max(gisMap.getZoom(), 13), { animate:true });
  }
  drawRoutes();
  renderGisList();
  renderGisDetail();
  showGisPane("detail");
  // 관리자가 그리기 모드로 들어온 경우에만, 사업을 고르는 즉시 그리기가 시작된다.
  if(routeArmed) enterRouteEdit();
}

function openMapScreen(focusId){
  show("#scr-map");
  mapHood.set(currentHood);      // 왼쪽 주소 칸을 지금 보고 있는 동네로 맞춘다

  // '지도에서 보기'로 들어온 사업이 지금 범위 밖이면 지도에 아예 안 뜬다.
  // 그런 경우에는 범위를 전국으로 넓혀 준다.
  if(focusId){
    const target = PROJECTS.find(x => String(x.id) === String(focusId));
    if(target && !scopeTest(mapScope)(target)){
      mapScope = "all";
      renderScope();
    }
  }

  if(S.vworldKey){
    ensureGisMap();
    renderGisMarkers(!focusId);
  }else{
    // 키가 없으면 지도 자리에 안내만 띄운다. 왼쪽 목록·상세는 그대로 쓸 수 있다.
    $("#gisMap").innerHTML = mapGuideHtml(
      "VWorld 인증키가 아직 등록되지 않았습니다",
      "vworld.kr에서 인증키를 발급받아 관리자 설정에 등록하면 지도가 표시됩니다."
    );
  }

  renderGisList();
  if(focusId){
    selectProject(focusId, true);
  }else{
    backToGisList();
  }
  setTimeout(() => { if(gisMap) gisMap.invalidateSize(); }, 60);
}

$("#btn-openmap").addEventListener("click", () => openMapScreen());
$("#btn-map-back").addEventListener("click", () => {
  setRouteArmed(false);   // 지도를 떠나면 그리기 모드도 함께 끝난다
  show("#scr-home");
  renderMiniMap();
});
$$("[data-mapscope]").forEach(b => b.addEventListener("click", () => {
  mapScope = b.dataset.mapscope;
  selectedId = null;
  renderScope();
  renderGisMarkers(true);
  backToGisList();
}));

/* ============================================================
   노선 직접 그리기 (관리자)
   자동으로 노선을 못 찾은 사업은 여기서 지도를 눌러 직접 그려 넣는다.
   저장한 노선은 이 브라우저(localStorage)에 남고,
   "JSON 복사"로 받아 data/routes.json 에 넣어 두면 모두가 볼 수 있다.
   ============================================================ */
let routeEdit = { on:false, pts:[], layers:[], target:null };

/* 관리자 화면에서 '지도에서 노선 그리기'로 들어왔는지.
   이 값이 true 일 때만 사업을 고르면 그리기가 시작된다.
   (주민 화면에는 그리기 관련 단추가 아예 나오지 않는다) */
let routeArmed = false;

function setRouteArmed(on){
  routeArmed = on;
  const note = $("#gisArmed");
  if(note) note.hidden = !on;
  if(!on) exitRouteEdit();
}

/* 그리는 중인 선과 점을 다시 그린다. */
function redrawEdit(){
  routeEdit.layers.forEach(l => gisMap.removeLayer(l));
  routeEdit.layers = [];
  if(routeEdit.pts.length >= 2){
    routeEdit.layers.push(L.polyline(routeEdit.pts, {
      color:cssVar("--live"), weight:4, opacity:.9, dashArray:"6 4"
    }).addTo(gisMap));
  }
  routeEdit.pts.forEach(pt => {
    routeEdit.layers.push(L.circleMarker(pt, {
      radius:4, color:cssVar("--live"), fillColor:"#fff", fillOpacity:1, weight:2
    }).addTo(gisMap));
  });
  $("#drawMsg").textContent = `점 ${routeEdit.pts.length}개`;
}

function onMapClickDraw(e){
  if(!routeEdit.on) return;
  routeEdit.pts.push([e.latlng.lat, e.latlng.lng]);
  redrawEdit();
}

function enterRouteEdit(){
  const p = PROJECTS.find(x => String(x.id) === String(selectedId));
  if(!p){ alert("먼저 목록이나 지도에서 사업을 선택하세요."); return; }
  if(!gisMap) return;
  routeEdit.on = true;
  routeEdit.target = p;
  const saved = manualRoutes[String(p.id)];
  routeEdit.pts = saved ? toLatLngs(saved.coordinates) : [];
  $("#drawTarget").textContent = p.name;
  $("#gisDraw").hidden = false;
  $("#gisMap").classList.add("gis-map--draw");
  gisMap.on("click", onMapClickDraw);
  redrawEdit();
}

function exitRouteEdit(){
  if(!routeEdit.on) return;
  routeEdit.on = false;
  if(gisMap){
    gisMap.off("click", onMapClickDraw);
    routeEdit.layers.forEach(l => gisMap.removeLayer(l));
    $("#gisMap").classList.remove("gis-map--draw");
  }
  routeEdit.layers = [];
  $("#gisDraw").hidden = true;
  routeEdit.pts = [];
  routeEdit.target = null;
}

function manualGeoJson(){
  // 화면은 [위도,경도]로 다루지만 저장은 GeoJSON 규칙(경도,위도)에 맞춘다.
  return {
    type: "LineString",
    coordinates: routeEdit.pts.map(([lat, lon]) => [+lon.toFixed(5), +lat.toFixed(5)])
  };
}

/* 관리자 화면 → 지도 화면(그리기 모드). 비밀번호를 푼 사람만 이 단추를 볼 수 있다. */
$("#btn-admin-route").addEventListener("click", () => {
  openMapScreen();
  setRouteArmed(true);
});
/* '닫기'는 이 사업 그리기만 멈춘다. 다른 사업을 고르면 다시 그릴 수 있다. */
$("#btn-draw-cancel").addEventListener("click", exitRouteEdit);
$("#btn-draw-undo").addEventListener("click", () => { routeEdit.pts.pop(); redrawEdit(); });
$("#btn-draw-clear").addEventListener("click", () => { routeEdit.pts = []; redrawEdit(); });

$("#btn-draw-save").addEventListener("click", () => {
  if(!routeEdit.target) return;
  const id = String(routeEdit.target.id);
  if(routeEdit.pts.length < 2){
    // 점이 2개 미만이면 지정을 지운 것으로 본다.
    delete localRoutes[id];
    delete manualRoutes[id];
  }else{
    localRoutes[id] = manualGeoJson();
    manualRoutes[id] = localRoutes[id];
  }
  const ok = lsSet(LSROUTES, localRoutes);
  $("#drawMsg").textContent = ok
    ? "저장했습니다. 모두에게 보이게 하려면 'JSON 복사' 후 data/routes.json 에 넣으세요."
    : "이 브라우저에는 저장할 수 없어 이번만 적용됩니다.";
  exitRouteEdit();
  renderGisMarkers(false);
  renderGisDetail();
});

$("#btn-draw-copy").addEventListener("click", async () => {
  const payload = JSON.stringify({ routes:Object.assign({}, fileRoutes, localRoutes) }, null, 1);
  try{
    await navigator.clipboard.writeText(payload);
    $("#drawMsg").textContent = "복사했습니다. data/routes.json 에 붙여넣으세요.";
  }catch(e){
    $("#drawMsg").textContent = "복사가 막혔습니다. 개발자도구 콘솔에 출력했습니다.";
    console.log(payload);
  }
});

/* 배경지도 바꾸기 (일반 ↔ 위성). 두 화면이 같은 id 를 쓴다. */
$("#btnMapLayer").addEventListener("click", toggleMapLayer);

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
  // Leaflet 이 id 로 직접 찾으므로 진짜 요소인지 확인한다
  const canvas = document.getElementById("miniMapCanvas");
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
    // minZoom:6 — VWorld 배경지도가 그 아래 줌은 오류를 돌려준다 (위 ensureGisMap 참고).
    // 작은 미리보기 지도는 전국 42건을 억지로 다 담으려다 줌 5까지 내려가서
    // 실제로 겪었다 — 마커는 제 위치에 잘 찍히는데 바탕지도만 빈 채로 보였다.
    miniMap = L.map("miniMapCanvas", {
      zoomControl:false, dragging:false, scrollWheelZoom:false, doubleClickZoom:false,
      boxZoom:false, keyboard:false, attributionControl:false, tap:false, minZoom:6
    });
    L.tileLayer(vworldTileUrl(), { minZoom:6, maxZoom:19 }).addTo(miniMap);
    miniMap.setView([HOME.lat, HOME.lon], 13);   // 레이어를 올리기 전에 기준 시점을 먼저 정한다
  }
  miniMap.invalidateSize();

  miniLayers.forEach(l => miniMap.removeLayer(l));
  miniLayers = [];

  // 미리보기 지도라 마커를 키보드로 고를 수 없게 한다.
  // (이 지도 전체가 '크게 보기' 단추라서, 안에 또 단추가 있으면 헷갈린다)
  const nation = isNation(currentHood);
  if(!nation){
    miniLayers.push(L.marker([HOME.lat, HOME.lon],
      { icon:markerIcon("home"), keyboard:false }).addTo(miniMap));
    // 홈 화면 미니 지도는 홈 화면의 범위를 따라간다 (showRadiusCircle 설명 참고)
    if(showRadiusCircle(homeScope)){
      miniLayers.push(L.circle([HOME.lat, HOME.lon], {
        radius: S.radiusKm * 1000, color:cssVar("--p50"), weight:1.4,
        dashArray:"5 5", fillColor:cssVar("--p50"), fillOpacity:.06
      }).addTo(miniMap));
    }
  }

  // 동네 경계는 다른 표시보다 아래에 깔린다.
  drawBoundary();

  // 동네를 안 정했으면 전국 사업을 다 찍고, 정했으면 그 범위의 사업만 찍는다.
  // (동네를 정했는데 전국을 보는 중이면, 작은 지도에는 가까운 것만 — 다 찍으면 안 보인다)
  const shown = nation ? PROJECTS
    : (homeScope === "all" ? nearbyProjects() : scopedProjects());
  const pts = [];
  shown.filter(p => p.lat != null).forEach(p => {
    // 미니 지도는 **항상 작은 점**이다. 사업 마커가 핀(25×34)으로 바뀐 뒤로는
    // 여기에 핀을 넣으면 카드만 한 지도를 핀 몇 개가 덮어 버린다.
    miniLayers.push(L.marker([p.lat, p.lon],
      { icon:markerIcon(p.type, false, true), keyboard:false }).addTo(miniMap));
    pts.push([p.lat, p.lon]);
  });

  // 축척 — ① 동네를 안 정했으면 사업들이 다 들어오게(= 전국)
  //        ② 경계가 있으면 경계에  ③ 없으면 반경 원에 맞춘다.
  // (지도 없이 계산되는 toBounds 를 써서 초기화 순서에 상관없이 안전하게)
  if(nation){
    if(pts.length > 1) miniMap.fitBounds(pts, { padding:[10, 10] });
    else miniMap.setView(KOREA_CENTER, 6);
  }else if(miniBoundLayer){
    miniMap.fitBounds(miniBoundLayer.getBounds(), { padding:[6, 6] });
  }else{
    miniMap.fitBounds(L.latLng(HOME.lat, HOME.lon).toBounds(S.radiusKm * 2000), { padding:[6, 6] });
  }
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
  // 비워 두면 '전국 / 전체 / 전체'로 둔다 (화면 안내문과 같게).
  S.defHood        = { sido:$("#a-d-sido").value.trim() || ALL_SIDO,
                       sgg: $("#a-d-sgg").value.trim()  || ANY,
                       dong:$("#a-d-dong").value.trim() || ANY };
  S.adminPw        = $("#a-pw").value || DEFAULTS.adminPw;
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

/* 첫 방문 기록에도 '지금 화면'을 적어 둔다.
   이게 없으면 뒤로가기로 첫 화면까지 돌아오지 못하고 사이트 밖으로 나가 버린다. */
rememberScreen("#scr-onboard", false);

applySettings();
loadRegions();
loadRoutes();
loadProjects();
