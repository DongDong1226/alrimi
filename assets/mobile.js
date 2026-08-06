/* ============================================================
   휴대폰 화면(m.html)에만 있는 동작

   ★ 여기에는 **판단하는 코드를 두지 않는다.**
     어떤 사업을 보여줄지, 기간이 지났는지, AI 해석을 보여도 되는지는
     전부 assets/app.js 가 정한다. 이 파일은 오직 배치만 다룬다 —
     아래쪽 탭 막대, 올라오는 시트, 범례 접기.
     규칙이 두 곳에 생기면 화면마다 다른 답을 내놓게 된다.

   app.js 가 먼저 읽혀야 한다 (show·openMapScreen·openModal 을 여기서 부른다).
   ============================================================ */
(function(){
  "use strict";

  const q = s => document.querySelector(s);
  const qa = s => Array.from(document.querySelectorAll(s));

  /* ---------- 아래쪽 탭 막대 ----------
     첫 화면(동네 설정)에서는 감춘다 — 아직 볼 것이 없다. */
  const tabs = q("#mTabs");

  function syncTabs(){
    const onboard = q("#scr-onboard").classList.contains("on");
    tabs.hidden = onboard;
    const mapOn = q("#scr-map").classList.contains("on");
    qa("[data-tab]").forEach(b => {
      const on = (b.dataset.tab === "map") ? mapOn
        : (b.dataset.tab === "home" && !mapOn && !onboard);
      b.classList.toggle("on", on);
    });
  }

  qa("[data-tab]").forEach(b => b.addEventListener("click", () => {
    const kind = b.dataset.tab;
    if(kind === "map"){ openMapScreen(); syncTabs(); return; }
    if(kind === "hood"){ openModal("m-hood"); return; }
    if(kind === "guide"){ openModal("m-guide"); return; }

    // 홈·설명회는 같은 화면의 다른 자리로 간다
    if(!q("#scr-home").classList.contains("on")) show("#scr-home");
    syncTabs();
    if(kind === "brief"){
      q("#participate").scrollIntoView({ behavior:"smooth", block:"start" });
    }else{
      scrollTo({ top:0, behavior:"smooth" });
    }
  }));

  /* 화면이 바뀌면 탭 표시도 따라간다.
     app.js 가 클래스를 갈아 끼우므로 그것을 지켜본다
     (app.js 에 손을 대지 않고 붙이는 가장 안전한 방법이다). */
  const watcher = new MutationObserver(syncTabs);
  qa(".screen").forEach(s => watcher.observe(s, { attributes:true, attributeFilter:["class"] }));
  syncTabs();

  /* ---------- 지도 화면: 아래에서 올라오는 시트 ----------
     지도를 크게 보고 싶을 때와 목록을 훑고 싶을 때가 다르다.
     손잡이를 눌러 세 단계로 바꾼다. */
  const STEPS = ["peek", "half", "full"];
  const sheet = q(".m-sheet");
  const scrMap = q("#scr-map");
  let step = 1;   // 처음에는 반쯤

  function applySheet(){
    STEPS.forEach((s, i) => scrMap.classList.toggle("sheet-" + s, i === step));
    const grip = q("#btnSheet");
    grip.setAttribute("aria-label",
      step === 2 ? "목록 작게 보기" : "목록 크게 보기");
    // 지도 크기가 바뀌었으니 Leaflet 에 알려 준다
    setTimeout(() => { if(typeof gisMap !== "undefined" && gisMap) gisMap.invalidateSize(); }, 220);
  }
  q("#btnSheet").addEventListener("click", () => {
    step = (step + 1) % STEPS.length;
    applySheet();
  });
  applySheet();

  /* 사업을 고르면(상세) 시트를 끝까지 올린다 — 읽을 것이 많다.
     app.js 가 #scr-map 에 on-detail 을 붙이는 것을 지켜본다. */
  new MutationObserver(() => {
    if(scrMap.classList.contains("on-detail") && step !== 2){ step = 2; applySheet(); }
  }).observe(scrMap, { attributes:true, attributeFilter:["class"] });

  /* ---------- 주소 바꾸기 칸 접기 ----------
     늘 펴 두면 목록 자리를 먹는다. 필요할 때만 편다. */
  q("#btn-map-addrbar").addEventListener("click", () => {
    const box = q("#mAddr");
    box.hidden = !box.hidden;
    if(!box.hidden && step === 0){ step = 1; applySheet(); }
  });

  /* ---------- 범례 접기 ----------
     항목이 여섯 개라 펴 두면 작은 지도의 4분의 1을 가린다. */
  q("#btnLegend").addEventListener("click", () => {
    const lg = q("#mLegend");
    lg.hidden = !lg.hidden;
    q("#btnLegend").classList.toggle("on", !lg.hidden);
  });

  /* ---------- 넓은 화면으로 열렸을 때 ----------
     휴대폰 화면을 PC 에서 열면 지나치게 큼직하다. 안내만 하고 강제로 보내지는 않는다
     (일부러 이 주소를 연 사람도 있다). */
  if(innerWidth >= 900 && !sessionStorage.getItem("wdn.mHint")){
    sessionStorage.setItem("wdn.mHint", "1");
    const bar = document.createElement("div");
    bar.className = "m-widehint";
    bar.innerHTML = `이 화면은 휴대폰용입니다. <a href="index.html?pc=1">넓은 화면(PC)으로 보기</a>`;
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 8000);
  }
})();
