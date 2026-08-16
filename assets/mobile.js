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
    // 담은 사업 화면에는 해당하는 탭이 없다. 그때 '홈'에 불이 들어오면
    // 지금 홈에 있는 것처럼 보여 헷갈린다.
    const savedEl = q("#scr-saved");
    const savedOn = !!savedEl && savedEl.classList.contains("on");
    qa("[data-tab]").forEach(b => {
      const k = b.dataset.tab;
      const on = k === "map"   ? mapOn
        : k === "saved" ? savedOn
        : k === "home"  ? (!mapOn && !onboard && !savedOn)
        : false;
      b.classList.toggle("on", on);
    });
  }

  qa("[data-tab]").forEach(b => b.addEventListener("click", () => {
    const kind = b.dataset.tab;
    if(kind === "map"){ openMapScreen(); syncTabs(); return; }
    if(kind === "hood"){ openModal("m-hood"); return; }
    if(kind === "guide"){ openModal("m-guide"); return; }
    // 관심목록 — app.js 가 두 화면 공용으로 처리한다 (머리말 별표와 같은 길)
    if(kind === "saved"){
      const star = q('[data-nav="saved"]');
      if(star) star.click();
      syncTabs();
      return;
    }

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
     지도 화면에 처음 들어오면 **지도만** 보여준다(closed). 목록은
     아래 가운데의 "목록 보기" 배지를 눌러야 올라온다. 한 번 열리면
     손잡이로 peek/half/full 세 단계를 오간다. */
  const STEPS = ["closed", "peek", "half", "full"];
  const sheet = q(".m-sheet");
  const scrMap = q("#scr-map");
  const badge = q("#btnListBadge");
  let step = 0;   // 처음에는 지도만

  function applySheet(){
    STEPS.forEach((s, i) => scrMap.classList.toggle("sheet-" + s, i === step));
    const grip = q("#btnSheet");
    grip.setAttribute("aria-label",
      step === STEPS.length - 1 ? "목록 작게 보기" : "목록 크게 보기");
    badge.hidden = step !== 0;   // 목록이 접혀 있을 때만 배지를 보여준다
    // 지도 크기가 바뀌었으니 Leaflet 에 알려 준다
    setTimeout(() => { if(typeof gisMap !== "undefined" && gisMap) gisMap.invalidateSize(); }, 220);
  }
  q("#btnSheet").addEventListener("click", () => {
    step = (step + 1) % STEPS.length;
    applySheet();
  });
  /* '지도 보기' — 한 번에 지도만 보는 상태로 내려간다.
     상세를 보고 있었으면 목록으로도 되돌려 준다 (상세가 열린 채 닫히면
     다시 열었을 때 아까 그 상세가 그대로 있어 지도로 돌아온 느낌이 안 난다). */
  q("#btnSheetClose").addEventListener("click", () => {
    if(typeof backToGisList === "function" && scrMap.classList.contains("on-detail")){
      backToGisList();
    }
    step = 0;
    applySheet();
  });
  badge.addEventListener("click", () => {
    step = 1;   // peek 부터 — 지도가 안 보일 만큼 확 덮지는 않는다
    applySheet();
  });
  applySheet();

  /* 지도 화면에 새로 들어올 때마다(다른 화면에서 넘어올 때마다) 지도만 먼저 보여준다.
     단, 특정 사업을 짚고 들어온 경우(on-detail)는 아래에서 바로 끝까지 올린다. */
  let mapWasOn = false;
  new MutationObserver(() => {
    const isOn = scrMap.classList.contains("on");
    if(isOn && !mapWasOn && !scrMap.classList.contains("on-detail") && step !== 0){
      step = 0;
      applySheet();
    }
    mapWasOn = isOn;
  }).observe(scrMap, { attributes:true, attributeFilter:["class"] });

  /* 사업을 고르면(상세) 시트를 끝까지 올린다 — 읽을 것이 많다.
     app.js 가 #scr-map 에 on-detail 을 붙이는 것을 지켜본다. */
  new MutationObserver(() => {
    if(scrMap.classList.contains("on-detail") && step !== STEPS.length - 1){
      step = STEPS.length - 1;
      applySheet();
    }
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

  /* ---------- 숫자 카드 3개 — 지금 몇 번째를 보고 있는지 점으로 ----------
     드래그해서 옆으로 보는 건 좋지만 카드가 넓어 "3개가 있다"는 게 잘 안 보인다.
     스크롤 위치를 카드 폭으로 나눠 가장 가까운 카드에 점을 켠다.
     (수치·문구는 건드리지 않는다 — 오직 스크롤 위치만 본다) */
  const mStats = q("#mStats");
  const dots = qa("#mStatsDots span");
  if(mStats && dots.length){
    let ticking = false;
    const updateDots = () => {
      ticking = false;
      const card = mStats.querySelector(".m-stat");
      if(!card) return;
      const step = card.getBoundingClientRect().width + 10;   // 카드 폭 + gap(10px)
      const idx = Math.min(dots.length - 1, Math.round(mStats.scrollLeft / step));
      dots.forEach((d, i) => d.classList.toggle("on", i === idx));
    };
    mStats.addEventListener("scroll", () => {
      if(ticking) return;
      ticking = true;
      requestAnimationFrame(updateDots);
    }, { passive:true });
  }

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
