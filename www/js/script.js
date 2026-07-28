/* =========================================================
   AI 디지털 도우미 - script.js
   ---------------------------------------------------------
   구성
   1. 전역 상태 (appState) + localStorage 저장/불러오기
   3. 음성 안내 (TTS)
   4. 화면 전환 (goTo) + 진행바(progress)
   5. 홈 대시보드 (오늘 할 일 / 다가오는 일정 / 최근 기록)
   6. 일정 알림 설정 모달
   7. 문서/문자 튜토리얼 및 실사용 플로우 (복사/붙여넣기 시뮬레이션)
   9. 자동 실행 버튼 (전화/홈페이지/지도)
   10. 긴급 도움 FAB + Bottom Sheet
   11. 보호자 공유 (문자/카카오톡/복사)
   12. 설정 (글자 크기 / 음성 속도 / 보호자 정보)
   13. 공통 유틸(토스트, 리플, 날짜 포맷 등)
   ========================================================= */

/* ---------------------------------------------------------
   1. 전역 상태 + localStorage
   --------------------------------------------------------- */
const STORAGE_KEY = 'ai_helper_state_v1';

const appState = {
  history: [],                                   // 최근 분석/대화 기록 (최대 10개)
  schedule: [],                                   // { id, text, source, date, time, done, createdAt }
  settings: { fontScale: 1, voiceRate: 1, voiceEnabled: true, language: 'ko' }, // 접근성 설정
  guardian: { name: '', phone: '', autoNotify: false },
  profile: { name: '', gender: '', age: 50, region: '' }, // 맞춤 안내용(선택 사항): AI 분석 요청에 참고 정보로만 함께 전달됨
  onboardingDone: false // 인사→프로필→튜토리얼을 한 번이라도 끝냈는지. true면 다음 실행부터 홈에서 시작한다
};

let voices = [];
let pendingReminder = { text: '', source: '' };
let idCounter = 1;

function genId(){ return 'item-' + (idCounter++) + '-' + Date.now(); }

/** 상태를 localStorage에 저장 (일정/기록/설정/보호자 정보 자동 저장) */
function saveState(){
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      history: appState.history,
      schedule: appState.schedule,
      settings: appState.settings,
      guardian: appState.guardian,
      profile: appState.profile,
      onboardingDone: appState.onboardingDone
    }));
  } catch (err) {
    console.warn('저장 실패:', err);
  }
}

/** localStorage에서 상태 복원 */
function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.history) appState.history = saved.history;
    if (saved.schedule) appState.schedule = saved.schedule;
    if (saved.settings) appState.settings = Object.assign(appState.settings, saved.settings);
    if (saved.guardian) appState.guardian = Object.assign(appState.guardian, saved.guardian);
    if (saved.profile) appState.profile = Object.assign(appState.profile, saved.profile);
    if (saved.onboardingDone) appState.onboardingDone = true;
  } catch (err) {
    console.warn('불러오기 실패:', err);
  }
}

/* ---------------------------------------------------------
   3. 음성 안내 (TTS)
   --------------------------------------------------------- */
function loadVoices(){ voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function toggleVoice(){
  const toggle = document.getElementById('voiceEnabledToggle');
  appState.settings.voiceEnabled = toggle.checked;
  if (!toggle.checked && window.speechSynthesis) speechSynthesis.cancel();
  saveState();
}

/** 번역된 문구(온보딩/튜토리얼)를 읽어줄 때만 언어별 TTS lang을 쓰고, 그 외(AI 분석 결과 등 항상 한국어인 문구)는 기본값(한국어)을 유지한다 */
const TTS_LANG_MAP = { ko: 'ko-KR', zh: 'zh-CN', vi: 'vi-VN', th: 'th-TH', uz: 'uz-UZ' };
function currentTtsLang(){ return TTS_LANG_MAP[appState.settings.language] || 'ko-KR'; }

function speak(text, lang){
  const liveRegion = document.getElementById('liveRegion');
  if (!appState.settings.voiceEnabled || !window.speechSynthesis || !text) {
    if (text && liveRegion) liveRegion.textContent = text;
    return;
  }
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang || 'ko-KR';
  utter.rate = appState.settings.voiceRate;
  const langPrefix = utter.lang.split('-')[0];
  const matchVoice = voices.find(v => v.lang && v.lang.startsWith(langPrefix));
  if (matchVoice) utter.voice = matchVoice;
  speechSynthesis.speak(utter);
  if (liveRegion) liveRegion.textContent = text;
}

/** 현재 화면의 안내 음성을 다시 읽기 */
/** data-voice-i18n이 있는 화면(온보딩)은 현재 언어로 번역된 안내 문구를, 없으면 data-voice의 한국어 원문을 읽어준다 */
function screenVoiceText(screenEl){
  const key = screenEl.getAttribute('data-voice-i18n');
  return key ? t(key) : screenEl.getAttribute('data-voice');
}
/** data-voice-i18n이 있는 화면만 번역된 언어로 읽고, 나머지 화면은 항상 한국어로 읽는다(대부분의 data-voice가 여전히 한국어 원문이므로) */
function screenVoiceLang(screenEl){
  return screenEl.hasAttribute('data-voice-i18n') ? currentTtsLang() : 'ko-KR';
}

function replayCurrentVoice(){
  const active = document.querySelector('.screen.active');
  if (active) speak(screenVoiceText(active), screenVoiceLang(active));
}

/** 음성 읽기 멈추기 */
function stopVoice(){
  if (window.speechSynthesis) speechSynthesis.cancel();
}

/* ---------------------------------------------------------
   4. 화면 전환 + 진행바
   --------------------------------------------------------- */
/* 안내(온보딩) 화면 동안에는 긴급 도움 FAB을 숨긴다 */
const onboardScreens = new Set(['screen-greet', 'screen-profile', 'screen-tutorial-ai-notice']);

/* 하단 네비게이션 바를 노출할 최상위 화면. 여기 없는 화면(촬영·로딩·결과 등 흐름 중간)에서는 숨겨서
   "네비바가 보이면 출발점, 안 보이면 진행 중"이라는 규칙을 만든다. */
const TAB_SCREENS = new Set(['screen-home', 'screen-info', 'screen-history', 'screen-settings']);

/** 네비바의 활성 탭 표시를 현재 화면에 맞춘다 */
function syncBottomNav(id){
  document.querySelectorAll('#bottomNav [data-tab]').forEach(btn => {
    const on = btn.dataset.tab === id;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

let activeScreenEl = document.querySelector('.screen.active');

function goTo(id){
  if (activeScreenEl) activeScreenEl.classList.remove('active');
  const target = document.getElementById(id);
  target.classList.add('active');
  target.scrollTop = 0; // 화면은 각자 스크롤 위치를 기억하므로, 새로 들어올 때는 항상 맨 위에서 시작한다(코치마크가 특정 위치로 스크롤하는 건 이후 별도로 실행됨)
  activeScreenEl = target;
  // 코치마크가 이 화면에서 직접 안내 음성을 읽어줄 예정이면, 화면 기본 안내와 겹쳐 읽혀 잘리는 걸 막기 위해 기본 음성은 건너뛴다
  if (!coachWillNarrate(id)) speak(screenVoiceText(target), screenVoiceLang(target));
  document.body.classList.toggle('in-onboarding', onboardScreens.has(id));

  // 네비바는 최상위 탭 화면에서만 보인다.
  // 코치마크 진행 중에도 숨기지 않는다 — 투어의 기록·설정·마무리 단계가 네비바 버튼을 직접 가리키기 때문이다.
  // 코치마크 오버레이(z-index 500)가 네비바(70)보다 위에 있어 스포트라이트는 정상 동작한다.
  document.body.classList.toggle('has-bottom-nav', TAB_SCREENS.has(id));
  syncBottomNav(id);

  // 홈에 도달했다는 건 온보딩(인사→프로필→튜토리얼)을 어떤 경로로든 빠져나왔다는 뜻이다.
  // 건너뛰기·튜토리얼 완주 등 경로가 여러 개라 각각에 표시를 다는 대신 도착 지점에서 한 번만 기록한다.
  if (id === 'screen-home' && !appState.onboardingDone) {
    appState.onboardingDone = true;
    saveState();
  }

  if (id === 'screen-home') renderHomeDashboard();
  if (id === 'screen-info') renderInfoTab();
  if (id === 'screen-settings') syncSettingsUI();
  if (id === 'screen-profile') syncProfileUI();
  if (id === 'screen-history') renderHistory();
  if (id === 'screen-welfare-nearby') loadWelfareNearby();
  if (id === 'screen-loading-doc') startLoadingProgress('progressFillLoadDoc');
  if (id === 'screen-result-doc') { renderDocResult(); setDocView('easy'); applyDocPreview(); }
  if (id === 'screen-loading-text') startLoadingProgress('progressFillLoadText');
  if (id === 'screen-result-text') {
    renderSmsResult();
    const note = document.getElementById('guardianNoteText');
    if (note) note.textContent = appState.guardian.name ? '' : '보호자를 등록하면 위험 문자를 바로 알려드릴 수 있어요.';
  }

  coachOnNavigate(id);
}

/** "튜토리얼을 건너뛸까요?" 확인 시트.
 *  브라우저 기본 confirm()은 앱과 생김새가 달라 어르신에게 낯설고, 진행 중이던 음성 안내도 끊긴다.
 *  그래서 다른 확인 창들과 같은 바텀시트로 통일했다. 건너뛰기를 눌렀을 때 할 일은 호출한 쪽이 넘겨준다. */
let pendingSkipAction = null;

function openSkipConfirm(onConfirm){
  pendingSkipAction = onConfirm;
  document.getElementById('skipConfirmBackdrop').style.display = 'block';
  document.getElementById('skipConfirmSheet').style.display = 'block';
  speak(t('skipConfirm.title'));
}

function closeSkipConfirm(){
  pendingSkipAction = null;
  document.getElementById('skipConfirmBackdrop').style.display = 'none';
  document.getElementById('skipConfirmSheet').style.display = 'none';
}

function acceptSkipConfirm(){
  const action = pendingSkipAction;
  closeSkipConfirm(); // pendingSkipAction을 비운 뒤 실행해야 화면 전환 중 중복 실행되지 않는다
  if (action) action();
}

/** 첫 화면의 "건너뛰기": 실수로 누르는 경우가 많아 같은 문구로 한 번 더 확인한다 */
function confirmSkipTutorial(){
  openSkipConfirm(() => goTo('screen-home'));
}

/** AI 분석 대기 화면의 진행바: 실제로 언제 끝날지 모르니 90%까지만 천천히 채워두고,
 *  analyzeDocument()/analyzeSmsText()가 실제로 응답을 받으면 finishAllProgress()가 100%로 마무리한다 */
function startLoadingProgress(fillId){
  const fill = document.getElementById(fillId);
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetHeight; // 강제 리플로우: requestAnimationFrame은 백그라운드 탭/일시적 렌더링 지연에서 안 불릴 수 있어, 리플로우로 transition을 안전하게 재시작한다
  fill.style.transition = 'width 6s linear';
  fill.style.width = '90%';
}
function finishAllProgress(){
  ['progressFillLoadDoc', 'progressFillLoadText'].forEach(id => {
    const fill = document.getElementById(id);
    if (!fill) return;
    fill.style.transition = 'width 0.3s ease';
    fill.style.width = '100%';
  });
}

/* ---------------------------------------------------------
   5. 홈 대시보드 (오늘 할 일 / 다가오는 일정 / 최근 기록)
   --------------------------------------------------------- */
function formatYMD(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayStr(){ return formatYMD(new Date()); }
function tomorrowStr(){
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return formatYMD(d);
}
function formatDateLabel(dateStr){
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일`;
}
function formatNow(){
  const d = new Date();
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function renderHomeDashboard(){
  renderTodayTasks();
  renderUpcomingSchedule();
}

/** 정보 탭: 홈에 있던 읽을거리를 이쪽으로 옮겼다.
 *  두 카드 모두 조건에 안 맞아 숨겨지면(지역 미입력 등) 빈 화면이 되므로 안내 문구를 대신 띄운다. */
async function renderInfoTab(){
  renderPublicInfoCard();
  await renderRegionInfoCard();
  const publicCard = document.getElementById('publicInfoCard');
  const regionCard = document.getElementById('regionInfoCard');
  const empty = document.getElementById('infoEmptyState');
  if (!empty) return;
  const anyVisible = (publicCard && publicCard.style.display !== 'none') ||
                     (regionCard && regionCard.style.display !== 'none');
  empty.style.display = anyVisible ? 'none' : 'block';
}

/** 지역 맞춤 정보(경기데이터드림 경로당 현황 실데이터). 프로필의 지역이 경기도 시/군과 매칭될 때만 표시하고,
 *  매칭 안 되면(경기도 밖 등) 지어내지 않고 카드를 숨긴다. */
let regionInfoCache = {};
/** 프로필의 "사시는 지역" 텍스트로 경로당 현황(경기데이터드림 공공데이터)을 조회. 홈 카드와 주변 복지센터 화면이 공용으로 쓴다 */
async function fetchRegionInfo(region){
  if (!region || !AI_WORKER_URL) return { matched: false };
  if (!(region in regionInfoCache)) {
    try {
      const res = await fetch(AI_WORKER_URL + '/region-info?region=' + encodeURIComponent(region));
      regionInfoCache[region] = res.ok ? await res.json() : { matched: false };
    } catch (err) {
      regionInfoCache[region] = { matched: false };
    }
  }
  return regionInfoCache[region];
}

function regionCenterRowHtml(c){
  return `
    <div class="row" onclick="openWelfareRouteSheet('${escapeHtml(c.name).replace(/'/g, "\\'")}', null, null, '${escapeHtml(c.address || c.name).replace(/'/g, "\\'")}')" role="button" tabindex="0">
      <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-pin"></use></svg></div>
      <div class="text"><div class="t1">${escapeHtml(c.name)}</div><div class="t2">${escapeHtml(c.address || '')}</div></div>
      ${c.phone ? `<a href="tel:${escapeHtml(c.phone)}" onclick="event.stopPropagation()" style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:var(--accent-soft);color:var(--accent-strong);display:flex;align-items:center;justify-content:center;" aria-label="전화하기"><svg style="width:16px;height:16px;" viewBox="0 0 24 24"><use href="#ic-phone"></use></svg></a>` : ''}
    </div>
  `;
}

async function renderRegionInfoCard(){
  const card = document.getElementById('regionInfoCard');
  if (!card) return;
  const region = (appState.profile.region || '').trim();
  const data = await fetchRegionInfo(region);
  if (!data || !data.matched || !data.centers || data.centers.length === 0) { card.style.display = 'none'; return; }

  document.getElementById('regionInfoTitle').innerHTML =
    `<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-pin"></use></svg>${escapeHtml(data.city)} 근처 경로당`;
  document.getElementById('regionInfoList').innerHTML = data.centers.map(regionCenterRowHtml).join('');
  card.style.display = 'block';
}

/** 위경도를 경기데이터드림 시/군 이름으로 역지오코딩(Nominatim, API 키 불필요) */
async function reverseGeocodeRegion(lat, lon){
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
    const data = await res.json();
    const addr = data.address || {};
    return [addr.state, addr.city || addr.county, addr.borough || addr.suburb || addr.city_district].filter(Boolean).join(' ');
  } catch (err) {
    return '';
  }
}

/** 주변 복지센터 화면의 경로당(D1) 섹션: 저장된 내 지역이 있으면 그걸 쓰고, 없으면 방금 받은 GPS 위치를 역지오코딩해 지역을 알아내 보여준다(경기도 시/군이 매칭될 때만) */
async function renderWelfareGyeonggiSection(){
  const wrap = document.getElementById('welfareGyeonggiSection');
  if (!wrap) return;
  let region = (appState.profile.region || '').trim();
  if (!region && welfareUserLat != null && welfareUserLon != null) {
    region = await reverseGeocodeRegion(welfareUserLat, welfareUserLon);
  }
  const data = await fetchRegionInfo(region);
  if (!data || !data.matched || !data.centers || data.centers.length === 0) { wrap.style.display = 'none'; return; }

  document.getElementById('welfareGyeonggiTitle').innerHTML =
    `<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-pin"></use></svg>${escapeHtml(data.city)} 경로당(등록 정보)`;
  document.getElementById('welfareGyeonggiList').innerHTML = data.centers.map(regionCenterRowHtml).join('');
  wrap.style.display = 'block';
}

/** 다른 지역 경로당 직접 검색: 자유 텍스트를 그대로 region-info API에 넘겨 시/군 매칭 */
async function searchWelfareByRegion(){
  const region = document.getElementById('welfareRegionSearchInput').value.trim();
  const statusEl = document.getElementById('welfareRegionSearchStatus');
  const listEl = document.getElementById('welfareRegionSearchList');
  listEl.innerHTML = '';

  if (!region) { statusEl.textContent = '지역 이름을 입력해주세요.'; return; }
  statusEl.textContent = '경로당을 찾고 있어요...';

  const data = await fetchRegionInfo(region);
  if (!data || !data.matched || !data.centers || data.centers.length === 0) {
    statusEl.textContent = `"${region}"에서는 등록된 경로당 정보를 찾지 못했어요. 경기도 지역만 안내해드려요.`;
    return;
  }
  statusEl.textContent = `${data.city} 경로당 ${data.centers.length}곳을 찾았어요.`;
  listEl.innerHTML = data.centers.map(regionCenterRowHtml).join('');
}

/* ---------------------------------------------------------
   주변 복지센터 항목 클릭 시 길찾기 방법 선택(버스/도보). 좌표가 없으면(D1 경로당은 주소만 있음)
   기존 geocodePlace()로 주소를 좌표로 바꿔서 사용한다.
   --------------------------------------------------------- */
let welfareRouteTarget = null;
let welfareUserLat = null;
let welfareUserLon = null;

function openWelfareRouteSheet(name, lat, lon, address){
  welfareRouteTarget = { name, lat, lon, address: address || name };
  document.getElementById('welfareRouteTitle').textContent = name;
  document.getElementById('welfareRouteBackdrop').style.display = 'block';
  document.getElementById('welfareRouteSheet').style.display = 'block';
}
function closeWelfareRouteSheet(){
  document.getElementById('welfareRouteBackdrop').style.display = 'none';
  document.getElementById('welfareRouteSheet').style.display = 'none';
}

async function openWelfareRoute(mode){
  if (!welfareRouteTarget) return;
  if (welfareUserLat == null) { showGlobalToast('내 위치 정보가 없어요. 다시 찾기를 먼저 눌러주세요.'); return; }

  let { name, lat, lon, address } = welfareRouteTarget;
  if (lat == null || lon == null) {
    showGlobalToast('위치를 찾는 중이에요...');
    const point = await geocodePlace(address);
    if (!point) {
      // ponytail: 경로당의 옛 지번 주소는 Nominatim이 못 찾는 경우가 많아, 대신 이름으로 지도 검색을 열어준다
      openMap(name);
      closeWelfareRouteSheet();
      return;
    }
    lat = point.lat; lon = point.lon;
  }

  const from = `${welfareUserLon},${welfareUserLat},${encodeURIComponent('내 위치')}`;
  const to = `${lon},${lat},${encodeURIComponent(name)}`;
  window.open(`https://map.naver.com/p/directions/${from}/${to}/-/${mode}`, '_blank');
  closeWelfareRouteSheet();
}

/** 오늘 해야 할 일: 날짜가 오늘이거나 날짜가 없는(항상 표시) 미완료/완료 항목 */
function renderTodayTasks(){
  const el = document.getElementById('todayTaskList');
  const today = todayStr();
  const items = appState.schedule.filter(s => !s.date || s.date === today);
  if (items.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:10px 0;">${escapeHtml(t('home.noTasksToday'))}</div>`;
    return;
  }
  el.innerHTML = items.map(s => `
    <label class="dashboard-item${s.done ? ' done' : ''}">
      <input type="checkbox" ${s.done ? 'checked' : ''} onchange="toggleTaskDone('${s.id}')">
      <span>${escapeHtml(s.text)}</span>
    </label>
    ${s.location && !s.done ? `
    <div class="task-map-wrap">
      <div class="task-map-label"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-pin"></use></svg>${escapeHtml(s.location)}까지 가는 길</div>
      <div class="task-map" id="taskMap-${s.id}"></div>
    </div>` : ''}
  `).join('');

  items.filter(s => s.location && !s.done).forEach(s => renderScheduleMap('taskMap-' + s.id, s.location));
}

/* ---------------------------------------------------------
   6-1. 일정 길찾기 지도 (Leaflet + OpenStreetMap Nominatim, API 키 불필요)
   위치 이름을 실제 좌표로 찾을 수 있을 때만 지도를 보여주고,
   찾지 못하면 지도를 숨겨 잘못된 위치를 보여주지 않는다.
   --------------------------------------------------------- */
const geocodeCache = {};

async function geocodePlace(query){
  if (geocodeCache[query] !== undefined) return geocodeCache[query];
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query));
    const data = await res.json();
    const result = (data && data[0]) ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) } : null;
    geocodeCache[query] = result;
    return result;
  } catch (err) {
    geocodeCache[query] = null;
    return null;
  }
}

/** 네이티브 앱(APK)에서만 Geolocation 플러그인이 존재. 웹/PWA에서는 null. (카메라와 동일한 패턴)
 *  안드로이드 WebView는 navigator.geolocation을 제대로 지원하지 않아, 네이티브 앱에서는 반드시 이 플러그인을 거쳐야 위치 권한 요청이 동작한다. */
function getGeolocationPlugin(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) || null;
}

/** 위치 확인 공용: 네이티브 플러그인이 있으면 그걸로, 없으면(웹/PWA) 웹 표준 navigator.geolocation으로 현재 위치를 얻는다 */
function getCurrentPosition(){
  const Geo = getGeolocationPlugin();
  if (Geo) return Geo.getCurrentPosition();
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('geolocation unsupported')); return; }
    navigator.geolocation.getCurrentPosition(resolve, reject);
  });
}

/** 프로필의 "사시는 지역"을 기기 위치로 자동 입력. 역지오코딩은 Nominatim을 사용(API 키 불필요) */
async function useCurrentLocationForRegion(){
  if (!getGeolocationPlugin() && !navigator.geolocation) { showGlobalToast('이 기기에서는 위치 확인을 지원하지 않아요.'); return; }
  showGlobalToast('위치를 확인하는 중이에요...');
  try {
    const pos = await getCurrentPosition();
    const { latitude, longitude } = pos.coords;
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
    const data = await res.json();
    const addr = data.address || {};
    // ponytail: 시/도-시/군-구 조합을 느슨하게 추정. 정확한 행정구역 API가 아니므로 사용자가 직접 다듬을 수 있게 입력칸에 채워만 둠
    const region = [addr.state, addr.city || addr.county, addr.borough || addr.suburb || addr.city_district]
      .filter(Boolean).join(' ');
    if (!region) { showGlobalToast('주소를 찾지 못했어요. 직접 입력해주세요.'); return; }
    setValueIfChanged(document.getElementById('profileRegion'), region);
    setValueIfChanged(document.getElementById('profileRegionSettings'), region);
    setProfileField('region', region);
    showGlobalToast('현재 위치로 입력했어요.');
  } catch (err) {
    showGlobalToast('위치 권한이 필요해요. 직접 입력해주세요.');
  }
}

async function renderScheduleMap(containerId, query){
  const el = document.getElementById(containerId);
  if (!el || typeof L === 'undefined') return;
  const point = await geocodePlace(query);
  const wrap = el.closest('.task-map-wrap');
  if (!point) { if (wrap) wrap.style.display = 'none'; return; }

  const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([point.lat, point.lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  L.marker([point.lat, point.lon]).addTo(map).bindPopup(escapeHtml(query));
  el.dataset.ready = '1';
}

/* ---------------------------------------------------------
   6-2. 주변 복지센터 알아보기 (실제 GPS 위치 + OpenStreetMap Overpass API, API 키 불필요)
   지어낸 시설 정보를 보여주지 않기 위해, 실시간 조회 결과만 표시하고 찾지 못하면 그대로 안내한다.
   --------------------------------------------------------- */
/** 공개 Overpass 서버는 부하가 있으면 JSON 대신 오류 XML을 돌려줄 때가 있어 한 번 재시도한다 */
async function fetchOverpass(query){
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: query });
      if (!res.ok) throw new Error('overpass status ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
}

async function loadWelfareNearby(){
  const statusEl = document.getElementById('welfareNearbyStatus');
  const listEl = document.getElementById('welfareNearbyList');
  const mapEl = document.getElementById('welfareNearbyMap');
  listEl.innerHTML = '';
  document.getElementById('welfareSeniorList').innerHTML = '';
  mapEl.style.display = 'none';

  if (!getGeolocationPlugin() && !navigator.geolocation) { statusEl.textContent = '이 기기에서는 위치 확인을 지원하지 않아요.'; return; }
  statusEl.textContent = '내 위치를 확인하고 있어요...';

  let pos;
  try {
    pos = await getCurrentPosition();
  } catch (err) {
    statusEl.textContent = '위치 권한이 필요해요. 기기 설정에서 위치 권한을 허용해주세요.';
    return;
  }

  const { latitude, longitude } = pos.coords;
  welfareUserLat = latitude;
  welfareUserLon = longitude;
  statusEl.textContent = '주변 시설을 찾고 있어요...';
  renderWelfareGyeonggiSection();

  try {
    const query = `[out:json][timeout:20];(node["amenity"="social_facility"](around:10000,${latitude},${longitude});node["amenity"="community_centre"](around:10000,${latitude},${longitude});node["office"="government"]["government"="administrative"](around:10000,${latitude},${longitude}););out center 15;`;
    const data = await fetchOverpass(query);
    const places = (data.elements || [])
      .filter(el => el.tags && el.tags.name)
      .map(el => ({
        name: el.tags.name,
        address: el.tags['addr:full'] || [el.tags['addr:road'] || el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' '),
        phone: el.tags.phone || el.tags['contact:phone'] || '',
        lat: el.lat, lon: el.lon
      }))
      .slice(0, 10);

    if (places.length === 0) { statusEl.textContent = '주변에서 시설을 찾지 못했어요. 관할 주민센터에 문의해주세요.'; return; }

    // 이름에 경로당/노인정/노인회관이 들어간 곳은 경로당 목록으로, 나머지는 복지센터 목록으로 나눠서 보여준다
    const isSeniorCenter = p => /경로당|노인정|노인회관/.test(p.name);
    const seniorPlaces = places.filter(isSeniorCenter);
    const welfarePlaces = places.filter(p => !isSeniorCenter(p));

    statusEl.textContent = `내 위치 주변 ${places.length}곳을 찾았어요.`;
    document.getElementById('welfareSeniorList').innerHTML = seniorPlaces.map(overpassRowHtml).join('');
    listEl.innerHTML = welfarePlaces.map(overpassRowHtml).join('');

    renderWelfareMap(mapEl, latitude, longitude, places);
  } catch (err) {
    statusEl.textContent = '주변 시설 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.';
  }
}

function overpassRowHtml(p){
  return `
    <div class="row" onclick="openWelfareRouteSheet('${escapeHtml(p.name).replace(/'/g, "\\'")}', ${p.lat}, ${p.lon})" role="button" tabindex="0">
      <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-pin"></use></svg></div>
      <div class="text"><div class="t1">${escapeHtml(p.name)}</div><div class="t2">${escapeHtml(p.address || '주소 정보 없음')}</div></div>
      ${p.phone ? `<a href="tel:${escapeHtml(p.phone)}" onclick="event.stopPropagation()" style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:var(--accent-soft);color:var(--accent-strong);display:flex;align-items:center;justify-content:center;" aria-label="전화하기"><svg style="width:16px;height:16px;" viewBox="0 0 24 24"><use href="#ic-phone"></use></svg></a>` : ''}
    </div>
  `;
}

let welfareMapInstance = null;

/** "다시 찾기"로 여러 번 호출돼도 Leaflet이 같은 컨테이너에서 "Map container is already initialized" 오류를 내지 않도록, 재호출 시 이전 지도 인스턴스를 먼저 제거한다 */
function renderWelfareMap(el, lat, lon, places){
  if (typeof L === 'undefined') return;
  el.style.display = 'block';
  if (welfareMapInstance) { welfareMapInstance.remove(); welfareMapInstance = null; }
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: false }).setView([lat, lon], 14);
  welfareMapInstance = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  L.circleMarker([lat, lon], { radius: 7, color: '#2454e6', fillColor: '#2454e6', fillOpacity: 1 }).addTo(map).bindPopup('내 위치');
  places.forEach(p => { if (p.lat && p.lon) L.marker([p.lat, p.lon]).addTo(map).bindPopup(escapeHtml(p.name)); });
}

/** 다가오는 일정: 날짜가 지정된 항목을 오늘/내일/그 이후로 그룹핑 */
function renderUpcomingSchedule(){
  const wrap = document.getElementById('upcomingSchedule');
  const dated = appState.schedule.filter(s => s.date);
  if (dated.length === 0) { wrap.style.display = 'none'; return; }

  const today = todayStr();
  const tomorrow = tomorrowStr();
  const groups = { today: [], tomorrow: [], later: [] };
  dated.forEach(s => {
    if (s.date === today) groups.today.push(s);
    else if (s.date === tomorrow) groups.tomorrow.push(s);
    else if (s.date > today) groups.later.push(s);
  });

  const renderGroup = (list) => {
    if (list.length === 0) return '<div class="empty-hint">일정이 없습니다.</div>';
    return list.map(s => `
      <div class="schedule-item${s.done ? ' done' : ''}">
        <span>${s.done ? '✅' : '📅'}</span>
        <div>
          <div>${escapeHtml(s.text)}</div>
          <div style="font-size:12px;font-weight:500;color:var(--ink-faint);margin-top:2px;">${formatDateLabel(s.date)}${s.time ? ' · ' + s.time : ''} · ${escapeHtml(s.source)}</div>
        </div>
      </div>
    `).join('');
  };

  document.getElementById('scheduleTodayList').innerHTML = renderGroup(groups.today);
  document.getElementById('scheduleTomorrowList').innerHTML = renderGroup(groups.tomorrow);
  document.getElementById('scheduleLaterList').innerHTML = renderGroup(groups.later);
  wrap.style.display = 'flex';
}

function toggleTaskDone(id){
  const item = appState.schedule.find(s => s.id === id);
  if (!item) return;
  item.done = !item.done;
  saveState();
  renderTodayTasks();
  renderUpcomingSchedule();
  if (document.getElementById('screen-history').classList.contains('active')) renderHistory();
}

/** 최근 기록(최대 10개) 추가 */
function addHistory(title, result){
  const exists = appState.history.some(h => h.title === title);
  if (exists) { saveState(); return; }
  appState.history.unshift({ title, result, time: formatNow() });
  if (appState.history.length > 10) appState.history.length = 10;
  saveState();
  // 홈의 최근 기록 카드는 기록 탭으로 옮겨졌다(renderHistory가 전체 목록을 그린다).
}

function renderHistory(){
  const hList = document.getElementById('historyList');
  const sList = document.getElementById('scheduleList');
  if (appState.history.length === 0) {
    hList.innerHTML = '<div class="empty-state">아직 분석한 기록이 없습니다.<br>문서 찍기나 문자 보기를 이용해보세요.</div>';
  } else {
    hList.innerHTML = appState.history.map(h =>
      `<div class="history-item"><div class="hi-title">${escapeHtml(h.title)}</div><div class="hi-meta">${escapeHtml(h.result)} · ${escapeHtml(h.time)}</div></div>`
    ).join('');
  }
  if (appState.schedule.length === 0) {
    sList.innerHTML = '<div class="empty-state">체크한 일정이 없습니다.<br>문서 분석 후 체크박스를 선택하면 여기에 표시됩니다.</div>';
  } else {
    sList.innerHTML = appState.schedule.map(s => `
      <div class="schedule-item${s.done ? ' done' : ''}">
        <span>${s.done ? '✅' : '📅'}</span>
        <div>
          <div>${escapeHtml(s.text)}</div>
          <div style="font-size:13px;font-weight:500;color:var(--ink-faint);margin-top:2px;">${s.date ? formatDateLabel(s.date) + (s.time ? ' · ' + s.time : '') + ' · ' : ''}${escapeHtml(s.source)} · ${escapeHtml(s.createdAt)}</div>
        </div>
      </div>
    `).join('');
  }
}

function openHistory(){
  renderHistory();
  goTo('screen-history');
}

/* ---------------------------------------------------------
   6. 일정(체크리스트/알림) 관리
   --------------------------------------------------------- */

/** 체크박스로 추가되는 일정 (날짜 없음, 항상 "오늘 할 일"에 노출). location을 주면 오늘 할 일 목록에 길찾기 지도가 함께 표시된다. */
function addSchedule(text, source, location){
  if (appState.schedule.some(s => s.text === text)) { saveState(); return; }
  appState.schedule.push({ id: genId(), text, source, location: location || null, date: null, time: null, done: false, createdAt: formatNow() });
  saveState();
  renderTodayTasks();
  renderUpcomingSchedule();
}

function syncScheduleFromCheckbox(input){
  const text = input.dataset.schedule;
  if (input.checked) {
    addSchedule(text, input.dataset.source, input.dataset.location);
  } else {
    appState.schedule = appState.schedule.filter(s => s.text !== text);
    saveState();
    renderTodayTasks();
    renderUpcomingSchedule();
  }
}

/** 체크박스에 change 리스너를 한 번만 붙임 (정적/동적으로 그려지는 체크리스트 공용) */
function bindScheduleCheckbox(input){
  if (input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('change', () => syncScheduleFromCheckbox(input));
}

/** 알림 설정(날짜/시간) 모달 열기 */
function openReminderModal(text, source, location){
  pendingReminder = { text, source, location: location || null };
  document.getElementById('reminderTargetText').textContent = text;
  const existing = appState.schedule.find(s => s.text === text);
  document.getElementById('reminderDate').value = (existing && existing.date) || todayStr();
  document.getElementById('reminderTime').value = (existing && existing.time) || '09:00';
  document.getElementById('reminderBackdrop').style.display = 'block';
  document.getElementById('reminderSheet').style.display = 'block';
  speak('날짜와 시간을 선택하고 저장 버튼을 눌러주세요.');
}

function closeReminderModal(){
  document.getElementById('reminderBackdrop').style.display = 'none';
  document.getElementById('reminderSheet').style.display = 'none';
}

function saveReminder(){
  const date = document.getElementById('reminderDate').value;
  const time = document.getElementById('reminderTime').value;
  if (!date) { showGlobalToast('날짜를 선택해주세요.'); return; }

  let entry = appState.schedule.find(s => s.text === pendingReminder.text);
  if (entry) {
    entry.date = date; entry.time = time; entry.source = pendingReminder.source;
    if (pendingReminder.location) entry.location = pendingReminder.location;
  } else {
    appState.schedule.push({
      id: genId(), text: pendingReminder.text, source: pendingReminder.source,
      location: pendingReminder.location || null,
      date, time, done: false, createdAt: formatNow()
    });
  }
  saveState();
  closeReminderModal();
  showGlobalToast('알림이 저장되었습니다.');
  speak('알림이 저장되었습니다.');
  renderTodayTasks();
  renderUpcomingSchedule();
}

/* ---------------------------------------------------------
   7. 실사용 플로우 (실제 카메라/문자 복사·붙여넣기)
   --------------------------------------------------------- */
function finishDocResult(){
  const badge = lastDocAnalysis ? (statusBadgeMap[lastDocAnalysis.status] || statusBadgeMap.normal) : statusBadgeMap.normal;
  const headline = lastDocAnalysis ? (lastDocAnalysis.headline || '문서 분석') : '건강검진 안내';
  addHistory('📄 ' + headline, badge.text);
  lastCapturedPhoto = null;
  lastDocAnalysis = null;
  goTo('screen-home');
}

function finishSmsResult(){
  if (lastSmsAnalysis) {
    const badge = statusBadgeMap[lastSmsAnalysis.status] || statusBadgeMap.normal;
    addHistory('💬 ' + (lastSmsAnalysis.headline || '문자 분석'), badge.text);
    if (lastSmsAnalysis.status === 'danger' && appState.guardian.autoNotify && appState.guardian.name) {
      addHistory('🔔 보호자 알림 발송 (자동)', '⚪ 완료');
    }
  }
  pendingSmsText = '';
  lastSmsAnalysis = null;
  goTo('screen-home');
}

/* ---------------------------------------------------------
   7-0. 코치마크 튜토리얼: 가짜 미리보기 화면 대신, 실제 화면 위에 스포트라이트 + 말풍선을 띄워
   사용자가 진짜 버튼을 직접 눌러보며 실제 플로우(문서 촬영, 문자 복사→붙여넣기)를 체험하게 한다.
   각 단계는 { screen, target(실제 화면 안의 CSS 선택자), title, desc, voice, advance? } 로 구성되고,
   화면 전환은 goTo()가 실제로 호출될 때만 다음 단계로 넘어간다(가짜 onclick으로 흉내내지 않음).
   ponytail: AI 분석 결과(체크리스트/최종 판별 화면)는 크레딧 등 이유로 실패할 수 있어 튜토리얼 진행을
   막지 않도록, 촬영 버튼과 문자 확인 버튼은 클릭 즉시(advance:'click') 다음 단계로 넘어간다 —
   분석이 실제로 성공하면 그 결과 화면은 평소처럼 정상 동작하되, 코치 강조만 건너뛴다.
   --------------------------------------------------------- */
/** title/desc/voice는 더 이상 문구를 직접 담지 않고, key(coach.<key>.title/desc/voice)로 t()를 통해 언어 설정에 맞는 문구를 가져온다.
 *  cat은 왼쪽 카테고리 사이드바에서 어느 카테고리를 강조할지 표시하는 데 쓰인다. */
const fullCoachSteps = [
  { screen: 'screen-home', target: '#screen-home .feature-card[onclick*="screen-doc-choice"]', cat: 'doc', key: 'doc1' },
  { screen: 'screen-doc-choice', target: '#screen-doc-choice .feature-card[onclick*="screen-doc-capture"]', cat: 'doc', key: 'doc2' },
  { screen: 'screen-doc-capture', target: '#screen-doc-capture .camera-shutter', cat: 'doc', key: 'doc3', advance: 'click' },
  { screen: 'screen-home', target: '#screen-home .feature-card[onclick*="screen-sms-phone"]', cat: 'sms', key: 'sms1' },
  { screen: 'screen-sms-phone', target: '#screen-sms-phone .app-icon.msg', cat: 'sms', key: 'sms2' },
  { screen: 'screen-tutorial-sms-mock', target: '#screen-tutorial-sms-mock .compose-box', cat: 'sms', key: 'sms3' },
  { screen: 'screen-sms-switch', target: '#screen-sms-switch .primary-btn', cat: 'sms', key: 'sms4' },
  { screen: 'screen-sms-paste', target: '#smsPasteInput', cat: 'sms', key: 'sms5', advance: 'input' },
  { screen: 'screen-sms-paste', target: '#screen-sms-paste .primary-btn', cat: 'sms', key: 'sms6' },
  { screen: 'screen-sms-filled', target: '#screen-sms-filled .primary-btn', cat: 'sms', key: 'sms7' },
  { screen: 'screen-home', target: '#bottomNav [data-tab="screen-history"]', cat: 'history', key: 'history1' },
  { screen: 'screen-history', target: '#screen-history .nav-btn', cat: 'history', key: 'history2' },
  { screen: 'screen-info', target: '#publicInfoList .row:first-child', cat: 'info', key: 'info1' },
  { screen: 'screen-info-pension', target: '#screen-info-pension .primary-btn', cat: 'info', key: 'info2' },
  { screen: 'screen-home', target: '#screen-home .feature-card[onclick*="screen-welfare-nearby"]', cat: 'welfare', key: 'welfare1' },
  { screen: 'screen-welfare-nearby', target: '#screen-welfare-nearby .secondary-btn[onclick*="screen-home"]', cat: 'welfare', key: 'welfare2' },
  { screen: 'screen-home', target: '#screen-home .topbar [data-replay]', cat: 'voice', key: 'voice1', advance: 'click' },
  { screen: 'screen-home', target: '#emergencyFab', cat: 'emergency', key: 'emergency1', skippable: true },
  { screen: 'screen-home', target: '#bottomNav [data-tab="screen-settings"]', cat: 'settings', key: 'settingsIntro' },
  { screen: 'screen-settings', target: '#fontScaleGroup', cat: 'settings', key: 'fontsize', skippable: true },
  { screen: 'screen-settings', target: '#voiceRateGroup', cat: 'settings', key: 'rate', skippable: true },
  { screen: 'screen-settings', target: '#guardianName', cat: 'settings', key: 'guardian', skippable: true },
  { screen: 'screen-settings', target: '#screen-settings .settings-link-row[onclick*="screen-help"]', cat: 'settings', key: 'helplink' },
  { screen: 'screen-help', target: '#screen-help .nav-btn', cat: 'settings', key: 'helpback' },
  { screen: 'screen-settings', target: '#screen-settings .topbar .nav-btn', cat: 'settings', key: 'finish', advance: 'click' }
];

/** "사용 방법 안내"의 각 항목별 "체험해보기": 전체 투어(fullCoachSteps)에서 해당 구간만 골라 재사용한다.
 *  아래 slice/인덱스는 fullCoachSteps의 순서에 의존하므로, 그 배열의 항목을 지우거나 순서를 바꾸지 말 것. */
const docMiniCoachSteps = fullCoachSteps.slice(0, 3);
const smsMiniCoachSteps = fullCoachSteps.slice(3, 10);
const historyMiniCoachSteps = fullCoachSteps.slice(10, 12);
const publicInfoMiniCoachSteps = fullCoachSteps.slice(12, 14);
const welfareMiniCoachSteps = fullCoachSteps.slice(14, 16);
const voiceMiniCoachSteps = [fullCoachSteps[16]];
const emergencyMiniCoachSteps = [fullCoachSteps[17]];
const settingsLanguageMiniStep = { screen: 'screen-settings', target: '#languageGroup', cat: 'settings', key: 'language', skippable: true };
const settingsMiniCoachSteps = [fullCoachSteps[19], fullCoachSteps[20], fullCoachSteps[21], settingsLanguageMiniStep, fullCoachSteps[24]];

/** 첫 실행 안내: 앱의 핵심인 문서 촬영·문자 확인만 다루고 마지막에 "나머지는 여기서 볼 수 있어요"로 마무리한다.
 *  예전에는 8개 분류 25단계를 첫 실행에 한 번에 보여줬는데, 처음 쓰는 어르신에게는 부담이 컸다.
 *  빠진 기능(기록·정보·복지·음성·긴급·설정)은 설정 → 사용 방법 안내의 항목별 "체험해보기"로 언제든 볼 수 있다. */
const firstRunHelpStep = {
  screen: 'screen-home',
  target: '#bottomNav',
  cat: 'help', key: 'moreHelp', skippable: true
};
const firstRunCoachSteps = [...fullCoachSteps.slice(0, 10), firstRunHelpStep];

let coachSteps = firstRunCoachSteps;
let coachIndex = -1;
let coachActive = false;

/** steps를 생략하면 첫 실행 안내(firstRunCoachSteps), 넘기면 "사용 방법 안내"의 항목별 미니 투어를 시작한다 */
function startCoachmark(steps){
  coachSteps = steps || firstRunCoachSteps;
  coachActive = true;
  coachIndex = 0;
  goTo(coachSteps[0].screen); // goTo가 coachOnNavigate를 호출해 1단계를 띄워줌
}

/** 코치마크 오버레이(스포트라이트+말풍선+왼쪽 카테고리 사이드바)를 한꺼번에 켜고 끈다.
 *  사이드바가 보이는 동안은 body.coach-sidebar-active가 붙어 실제 화면 콘텐츠를 오른쪽으로 밀어준다. */
function setCoachOverlayVisible(visible){
  const overlay = document.getElementById('coachOverlay');
  if (overlay) overlay.style.display = visible ? 'block' : 'none';
  document.body.classList.toggle('coach-sidebar-active', visible);
}

function stopCoachmark(silent){
  coachActive = false;
  coachIndex = -1;
  clearCoachAdvanceListener();
  setCoachOverlayVisible(false);
  if (activeScreenEl) document.body.classList.toggle('in-onboarding', onboardScreens.has(activeScreenEl.id));
  if (!silent) {
    speak('안내가 끝났습니다. 이제 실제로 사용해보세요.');
    showGlobalToast('튜토리얼이 끝났습니다.');
  }
}

/** 진행 중인 코치마크의 "튜토리얼 건너뛰기": 첫 화면 건너뛰기와 같은 문구로 한 번 더 확인 */
function confirmSkipCoachmark(){
  openSkipConfirm(() => { stopCoachmark(true); goTo('screen-home'); });
}

/** goTo()가 호출될 때마다 실행됨: 코치마크가 기다리던 다음 화면이면 다음 단계를 보여주고,
 *  같은 화면으로 되돌아온 것이면 같은 단계를 다시 보여주고, 그 외(다른 곳을 눌러본 경우)에는 오버레이만 숨긴다.
 *  마지막 단계의 화면을 벗어나면 튜토리얼을 종료한다. */
/** 이 화면에 들어가면 코치마크가 곧바로 안내 음성을 읽어줄지 미리 판단(goTo의 기본 음성과 겹쳐 잘리는 것을 막기 위함) */
function coachWillNarrate(id){
  if (!coachActive) return false;
  const step = coachSteps[coachIndex];
  if (!step) return false;
  const nextStep = coachSteps[coachIndex + 1];
  return id === step.screen || (nextStep && id === nextStep.screen);
}

function coachOnNavigate(id){
  if (!coachActive) return;
  const step = coachSteps[coachIndex];
  if (!step) return;
  const nextStep = coachSteps[coachIndex + 1];
  // 현재 단계와 다음 단계가 같은 화면일 수 있으므로(예: 설정 화면 안에서 이어지는 단계들), "지금 단계가 기다리는 화면"인지 먼저 확인해야
  // 이제 막 시작한 단계를 건너뛰지 않는다. 다른 화면으로 실제로 넘어갔을 때만 다음 단계로 진행한다.
  if (id === step.screen) {
    setTimeout(showCoachStep, 200);
  } else if (nextStep && id === nextStep.screen) {
    coachIndex++;
    setTimeout(showCoachStep, 200);
  } else if (!nextStep) {
    // advance 없이 마지막 단계를 벗어난 경우(예: 미니 투어에서 재사용한 단계의 원래 다음 단계가 없음): 더 기다릴 단계가 없으므로 투어를 종료한다
    stopCoachmark();
  } else {
    // ponytail: 분석 중/결과 화면처럼 성공·실패로 갈라지는 중간 화면은 그냥 지나쳐 보내고(오버레이만 숨김),
    // 다음 단계가 기다리는 화면(예: 홈)으로 실제로 돌아왔을 때 위 분기에서 자연스럽게 이어받는다
    setCoachOverlayVisible(false);
  }
}

/** 다음 단계로 넘어갈 때 기다리고 있던 이전 단계의 advance 리스너가 뒤늦게 중복으로 발동하지 않도록 정리해둔다 */
let coachAdvanceEl = null;
let coachAdvanceType = null;
let coachAdvanceHandler = null;
function clearCoachAdvanceListener(){
  if (coachAdvanceEl && coachAdvanceType && coachAdvanceHandler) {
    coachAdvanceEl.removeEventListener(coachAdvanceType, coachAdvanceHandler);
  }
  coachAdvanceEl = null; coachAdvanceType = null; coachAdvanceHandler = null;
}

function showCoachStep(){
  const step = coachSteps[coachIndex];
  clearCoachAdvanceListener();
  if (!step) { stopCoachmark(); return; }
  if (!activeScreenEl || activeScreenEl.id !== step.screen) { setCoachOverlayVisible(false); return; }

  const el = document.querySelector(step.target);
  if (!el) { setCoachOverlayVisible(false); return; }

  // 화면이 길어 대상 버튼이 화면 아래에 있으면 구멍이 뷰포트 밖에 생겨 화면 전체가 어둡게 보이므로, 강조하기 전에 보이는 위치로 스크롤한다
  el.scrollIntoView({ block: 'center' });
  positionCoachStep(el, step);
  setCoachOverlayVisible(true);
  speak(t('coach.' + step.key + '.voice'), currentTtsLang());
  // 모바일에서 직전 단계가 입력창이었다면 키보드가 늦게 닫히며 레이아웃이 뒤늦게 안정될 수 있어 한 번 더 보정한다
  setTimeout(() => { if (activeScreenEl && activeScreenEl.id === step.screen) positionCoachStep(el, step); }, 350);

  if (step.advance) {
    const handler = () => {
      // 입력창/버튼에 포커스가 남아있으면 모바일 키보드가 열린 채로 다음 단계 위치를 계산해 스포트라이트가 어긋나므로, 미리 포커스를 해제해 키보드를 닫는다
      if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      clearCoachAdvanceListener();
      coachIndex++;
      setTimeout(showCoachStep, 450);
    };
    el.addEventListener(step.advance, handler, { once: true });
    coachAdvanceEl = el; coachAdvanceType = step.advance; coachAdvanceHandler = handler;
  }
}

/** 선택 사항인 단계(글자 크기·음성 속도·보호자 정보 등)에서 값을 바꾸지 않고도 다음으로 넘어갈 수 있게 해주는 버튼 */
function advanceCoachStep(){
  if (!coachActive) return;
  clearCoachAdvanceListener();
  if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  coachIndex++;
  setTimeout(showCoachStep, 200);
}

/** 코치마크가 켜져 있는 동안 화면 크기/뷰포트가 바뀌면(회전, 모바일 키보드 열림·닫힘 등) 스포트라이트 위치를 다시 계산한다 */
function repositionCurrentCoachStep(){
  if (!coachActive) return;
  const overlay = document.getElementById('coachOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  const step = coachSteps[coachIndex];
  if (!step) return;
  const el = document.querySelector(step.target);
  if (el) positionCoachStep(el, step);
}
window.addEventListener('resize', repositionCurrentCoachStep);
// 모바일 브라우저는 가상 키보드가 열리고 닫힐 때 window의 resize 대신 visualViewport의 resize만 발생시키는 경우가 많다
if (window.visualViewport) window.visualViewport.addEventListener('resize', repositionCurrentCoachStep);

function positionCoachStep(el, step){
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const hole = document.getElementById('coachHole');
  hole.style.top = (rect.top - pad) + 'px';
  hole.style.left = (rect.left - pad) + 'px';
  hole.style.width = (rect.width + pad * 2) + 'px';
  hole.style.height = (rect.height + pad * 2) + 'px';

  document.getElementById('coachTipStep').textContent = `${coachIndex + 1} / ${coachSteps.length}`;
  document.getElementById('coachTipTitle').textContent = t('coach.' + step.key + '.title');
  document.getElementById('coachTipDesc').textContent = t('coach.' + step.key + '.desc');
  // 값을 안 바꾸거나 입력을 건너뛰어도 다음 단계로 넘어갈 수 있도록, 선택 사항인 단계에만 "다음으로" 버튼을 보여준다
  document.getElementById('coachTipNext').style.display = step.skippable ? 'block' : 'none';

  const tip = document.getElementById('coachTip');
  const spaceBelow = window.innerHeight - rect.bottom;
  const putBelow = spaceBelow > 180 || rect.top < 180;
  tip.style.top = putBelow ? (rect.bottom + pad + 10) + 'px' : '';
  tip.style.bottom = putBelow ? '' : (window.innerHeight - rect.top + pad + 10) + 'px';
  tip.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - 300)) + 'px';

  updateCoachSidebar(step.cat);
}

/** 왼쪽 카테고리 진행률 사이드바: 8개 카테고리 중 지금 단계가 속한 카테고리를 강조하고,
 *  전체 투어(fullCoachSteps)에서 이미 지나온 카테고리는 완료 표시를 해준다 */
function updateCoachSidebar(activeCat){
  const sidebar = document.getElementById('coachSidebar');
  if (!sidebar) return;
  const isFullTour = coachSteps === firstRunCoachSteps;
  const currentStep = coachSteps[coachIndex];
  const passedCats = new Set();
  if (isFullTour) {
    for (let i = 0; i < coachIndex; i++) passedCats.add(coachSteps[i].cat);
  }
  // 사이드바 항목은 지금 투어에 실제로 들어있는 분류만 순서대로 그린다.
  // HTML에 분류를 고정해두면 투어 구성을 바꿀 때마다 빈 칸이 남으므로 여기서 만든다.
  const cats = [];
  coachSteps.forEach(s => { if (!cats.includes(s.cat)) cats.push(s.cat); });
  const catsKey = cats.join(',');
  if (sidebar.dataset.cats !== catsKey) {
    sidebar.dataset.cats = catsKey;
    sidebar.innerHTML = cats.map(c => `<div class="coach-sidebar-item" data-cat="${escapeHtml(c)}"></div>`).join('');
  }
  cats.forEach(cat => {
    const item = sidebar.querySelector(`[data-cat="${cat}"]`);
    if (!item) return;
    item.textContent = t('coach.cat.' + cat);
    item.classList.toggle('active', cat === activeCat);
    item.classList.toggle('done', isFullTour && passedCats.has(cat) && cat !== activeCat);
  });
  // 항목별 미니 투어(예: 문서만 체험해보기)에서는 전체 진행 상황이 의미가 없으므로 사이드바를 숨긴다
  sidebar.style.display = isFullTour ? 'flex' : 'none';
  document.body.classList.toggle('coach-sidebar-shown', isFullTour);
}

/* ---------------------------------------------------------
   7-1. 실제 카메라 / 갤러리 연동 (Capacitor)
   --------------------------------------------------------- */
const AI_WORKER_URL = 'https://ondam-ai.kke88084.workers.dev';

let lastCapturedPhoto = null;
let lastDocAnalysis = null;
let docPreviewDefaultHTML = '';

/** 네이티브 앱(APK)에서만 Camera 플러그인이 존재. 웹/PWA에서는 null. */
function getCameraPlugin(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera) || null;
}

/** 네이티브 앱이 아닐 때(iOS Safari, PWA 등) 쓰는 웹 표준 사진 선택. capture를 주면 카메라를 바로 열고, 안 주면 갤러리(사진 보관함)를 연다. */
function pickWebPhoto(captureMode){
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (captureMode) input.capture = captureMode;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** 카메라/갤러리 공용: 네이티브 플러그인이 있으면 그걸로, 없으면 웹 표준 파일 선택으로 사진을 얻는다 */
async function pickPhoto(useCamera, webCaptureMode){
  const Camera = getCameraPlugin();
  if (Camera) {
    try {
      if (useCamera) {
        const result = await Camera.takePhoto({ quality: 80 });
        lastCapturedPhoto = result.webPath;
      } else {
        const { results } = await Camera.chooseFromGallery({ quality: 80 });
        if (!results || !results.length) return;
        lastCapturedPhoto = results[0].webPath;
      }
    } catch (err) {
      return; // 사용자가 촬영/선택을 취소한 경우 등: 화면 유지
    }
  } else {
    const dataUrl = await pickWebPhoto(webCaptureMode);
    if (!dataUrl) return;
    lastCapturedPhoto = dataUrl;
  }
  goTo('screen-loading-doc');
  if (AI_WORKER_URL) analyzeDocument(lastCapturedPhoto);
}
function capturePhoto(){ return pickPhoto(true, 'environment'); }
function pickFromGallery(){ return pickPhoto(false, null); }

/** 실제로 찍거나 고른 사진이 있으면 결과 화면에 보여주고, 없으면(연습 등) 기본 예시로 되돌림 */
function applyDocPreview(){
  const el = document.getElementById('docPreviewContent');
  if (lastCapturedPhoto) {
    el.innerHTML = `<img src="${lastCapturedPhoto}" style="width:100%;display:block;">`;
  } else if (docPreviewDefaultHTML) {
    el.innerHTML = docPreviewDefaultHTML;
  }
}

/* ---------------------------------------------------------
   7-2. AI 문서 분석 (Cloudflare Worker /analyze-doc 연동)
   --------------------------------------------------------- */
const statusBadgeMap = {
  danger: { cls: 'badge-red', text: '🔴 위험', cardClass: 'danger', seal: 'ic-alert', eyebrow: '위험 · 응답하지 마세요' },
  info:   { cls: 'badge-gray', text: '⚪ 정보', cardClass: 'info', seal: 'ic-info', eyebrow: '정보 · 참고만 하세요' },
  normal: { cls: 'badge-green', text: '🟢 정상', cardClass: 'success', seal: 'ic-check', eyebrow: '정상 · 조치가 필요해요' }
};

/** 결과 화면(원형 배지 + 큰 타이틀 히어로)에 상태를 반영하는 공통 로직 */
function applyResultHero(card, data){
  const status = statusBadgeMap[data.status] ? data.status : 'normal';
  const info = statusBadgeMap[status];
  card.classList.remove('danger', 'info', 'success');
  card.classList.add(info.cardClass);
  card.querySelector('.seal use').setAttribute('href', '#' + info.seal);
  card.querySelector('.badge').textContent = info.eyebrow;
  card.querySelector('.headline').textContent = data.headline || '';
  const subtext = card.querySelector('.subtext');
  if (subtext) subtext.textContent = data.summary || '';
  const dangerPill = card.querySelector('.danger-pill');
  if (dangerPill) dangerPill.style.display = status === 'danger' ? 'inline-flex' : 'none';
}

function dataUrlToBase64(dataUrl){
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  return match ? { mediaType: match[1], base64: match[2] } : null;
}

/** AI 분석 자체가 실패했을 때(서버 오류, API 크레딧 부족 등) 공통 화면으로 보내고, "다시 시도" 버튼이 원래 화면으로 돌아가도록 기억해둔다 */
let aiErrorRetryScreen = 'screen-home';
function goToAiError(retryScreen, isOffline){
  aiErrorRetryScreen = retryScreen;
  finishAllProgress();
  if (coachActive) { goTo('screen-tutorial-ai-notice'); return; }

  document.getElementById('aiErrorTitle').textContent = isOffline
    ? '인터넷 연결을 확인해주세요.'
    : '지금은 분석이 어려워요.';
  document.getElementById('aiErrorDesc').textContent = isOffline
    ? '와이파이나 데이터가 꺼져있는 것 같아요. 연결을 확인한 후 다시 시도해주세요.'
    : '잠시 후 다시 시도해주세요.';
  goTo('screen-ai-error');
}

/** 같은 사진/문자로 재시도 가능하면 처음부터 다시 고르게 하지 않고 바로 재분석한다 */
function retryAiError(){
  if (aiErrorRetryScreen === 'screen-doc-choice' && lastCapturedPhoto) {
    goTo('screen-loading-doc');
    analyzeDocument(lastCapturedPhoto);
    return;
  }
  if (aiErrorRetryScreen === 'screen-sms-paste' && pendingSmsText) {
    goTo('screen-loading-text');
    analyzeSmsText(pendingSmsText);
    return;
  }
  goTo(aiErrorRetryScreen);
}

async function analyzeDocument(dataUrl){
  const parsed = dataUrlToBase64(dataUrl);
  if (!parsed) { goTo('screen-doc-error'); return; }
  if (!navigator.onLine) { goToAiError('screen-doc-choice', true); return; }

  try {
    const res = await fetch(AI_WORKER_URL + '/analyze-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: parsed.base64, mediaType: parsed.mediaType, profile: appState.profile })
    });
    const data = await res.json();
    if (!res.ok || data.error) { goToAiError('screen-doc-choice'); return; }
    lastDocAnalysis = data;
    finishAllProgress();
    goTo('screen-result-doc');
  } catch (err) {
    goToAiError('screen-doc-choice', !navigator.onLine);
  }
}

/** AI 분석 결과(headline/summary/checklist/status)를 결과 화면에 반영. AI가 만든 텍스트이므로 항상 textContent로만 채워 넣는다(HTML 삽입 금지). */
function renderDocResult(){
  const data = lastDocAnalysis;
  if (!data) return;

  // 화면 진입 시(goTo)의 기본 음성 안내는 이 함수가 실행되기 전에 읽히므로, 실제 분석 결과를
  // data-voice에 반영해두고 여기서 다시 읽어준다("다시 듣기" 버튼도 이 속성을 그대로 사용함)
  const voiceText = [data.headline, data.summary].filter(Boolean).join('. ');
  document.getElementById('screen-result-doc').setAttribute('data-voice', voiceText);
  speak(voiceText);

  applyResultHero(document.querySelector('#screen-result-doc .result-card'), data);

  document.querySelector('#docEasyView p').textContent = data.summary || '';

  // ponytail: API가 사진 속 원문 텍스트를 따로 반환하지 않음. 위 "사진 보기"로 대체. 백엔드가 원문 OCR도 반환하게 되면 여기 채우기
  document.querySelector('#docOriginalView p').textContent = '원문 텍스트는 위 사진을 참고해주세요.';

  const checklistEl = document.querySelector('#screen-result-doc .checklist');
  checklistEl.innerHTML = '';
  const checklist = data.checklist || [];
  if (checklist.length === 0) {
    checklistEl.innerHTML = '<div class="empty-hint">특별히 하실 일은 없어요.</div>';
  } else {
    checklist.forEach(item => {
      const row = document.createElement('div');
      row.className = 'checklist-row';

      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'schedule-check';
      checkbox.dataset.schedule = item;
      checkbox.dataset.source = '문서 분석';
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(' ' + item));

      const btn = document.createElement('button');
      btn.className = 'reminder-btn';
      btn.innerHTML = '<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-bell"></use></svg>알림 설정';
      btn.addEventListener('click', () => openReminderModal(item, '문서 분석'));

      row.appendChild(label);
      row.appendChild(btn);
      checklistEl.appendChild(row);
      bindScheduleCheckbox(checkbox);
    });
  }

  // AI가 문서에서 실제로 찾은 전화번호/홈페이지/방문 장소가 있을 때만 해당 버튼을 보여준다(지어내지 않음)
  const autoActions = document.getElementById('docAutoActions');
  const phoneBtn = document.getElementById('docActionPhone');
  const webBtn = document.getElementById('docActionWebsite');
  const mapBtn = document.getElementById('docActionMap');
  let anyAction = false;

  if (data.phone) { phoneBtn.href = 'tel:' + data.phone; phoneBtn.style.display = 'flex'; anyAction = true; }
  else phoneBtn.style.display = 'none';

  if (data.website) { webBtn.onclick = () => window.open(data.website, '_blank'); webBtn.style.display = 'flex'; anyAction = true; }
  else webBtn.style.display = 'none';

  if (data.mapQuery) { mapBtn.onclick = () => openMap(data.mapQuery); mapBtn.style.display = 'flex'; anyAction = true; }
  else mapBtn.style.display = 'none';

  autoActions.style.display = anyAction ? 'grid' : 'none';
}

/** 공유 버튼(문자/카카오톡/복사)이 사용할 현재 분석 결과 텍스트 */
function currentDocShareText(){
  if (!lastDocAnalysis) return '';
  return `${lastDocAnalysis.headline}: ${lastDocAnalysis.summary}`;
}

/* ---------------------------------------------------------
   7-3. 실제 문자(SMS) 분석 — 실제 문자 앱에서 복사해온 내용을 분석
   --------------------------------------------------------- */
let pendingSmsText = '';
let lastSmsAnalysis = null;

/** 실제 문자 앱을 열면서, 돌아왔을 때 안내할 화면으로 같이 넘어가둠 */
/** Android 네이티브 앱에서는 MessagingLauncher 플러그인으로 문자 앱(대화 목록)을 바로 열고,
 *  플러그인이 없는 환경(웹/iOS)에서는 sms: 스킴으로 대체한다(이 경우 작성 화면이 뜨는 건 플랫폼 제약) */
function openRealSmsApp(){
  goTo('screen-sms-switch');
  const launcher = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MessagingLauncher;
  if (launcher) {
    launcher.openMessagingApp().catch(() => { window.location.href = 'sms:'; });
  } else {
    window.location.href = 'sms:';
  }
}

/** 튜토리얼 중에는 실제 문자 앱으로 나가지 않고, 앱 안의 연습 화면(screen-tutorial-sms-mock)을 대신 보여준다 */
function handleSmsAppOpen(){
  if (coachActive) { goTo('screen-tutorial-sms-mock'); return; }
  openRealSmsApp();
}

/** 실제 폰의 "길게 눌러 복사" 동작을 흉내: 1초 이상 누르고 있어야 복사하기 버튼이 뜬다(짧게 떼면 아무 일도 없음) */
let tutorialHoldTimer = null;
function tutorialHoldStart(){
  clearTimeout(tutorialHoldTimer);
  tutorialHoldTimer = setTimeout(() => {
    document.getElementById('tutorialCopyPopup').style.display = 'block';
    expandCoachHoleForPopup();
  }, 1000);
}
function tutorialHoldCancel(){
  clearTimeout(tutorialHoldTimer);
}

/** "복사하기" 팝업이 문자 말풍선 위쪽 어두운 영역에 걸쳐 흐릿하게 보이던 문제 — 스포트라이트 구멍을
 *  말풍선+팝업을 모두 감싸는 크기로 넓혀서 팝업도 밝은 강조 영역 안에 들어오게 한다 */
function expandCoachHoleForPopup(){
  if (!coachActive) return;
  const bubble = document.querySelector('#screen-tutorial-sms-mock .compose-box');
  const popup = document.getElementById('tutorialCopyPopup');
  if (!bubble || !popup) return;
  const b = bubble.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const pad = 8;
  const top = Math.min(b.top, p.top) - pad;
  const left = Math.min(b.left, p.left) - pad;
  const right = Math.max(b.right, p.right) + pad;
  const bottom = Math.max(b.bottom, p.bottom) + pad;
  const hole = document.getElementById('coachHole');
  hole.style.top = top + 'px';
  hole.style.left = left + 'px';
  hole.style.width = (right - left) + 'px';
  hole.style.height = (bottom - top) + 'px';
}

/** 연습 화면의 샘플 문자를 "복사"한 것처럼 실제 클립보드에 담아준다 — 이후 진짜 붙여넣기 칸에서 실제로 붙여넣기가 동작한다 */
function tutorialCopySms(){
  const text = '[국민건강보험공단] 건강검진비 환급 대상입니다. 아래 링크에서 계좌번호를 입력해주세요. bit.ly/hcheck-refund';
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
  document.getElementById('tutorialCopyPopup').style.display = 'none';
  goTo('screen-sms-switch');
}

function confirmSmsPaste(){
  const text = document.getElementById('smsPasteInput').value.trim();
  if (text.length < 10) { goTo('screen-text-error'); return; }
  pendingSmsText = text;
  document.getElementById('smsFilledPreview').textContent = text;
  goTo('screen-sms-filled');
}

function startSmsAnalysis(){
  goTo('screen-loading-text');
  analyzeSmsText(pendingSmsText);
}

async function analyzeSmsText(text){
  if (!navigator.onLine) { goToAiError('screen-sms-paste', true); return; }

  try {
    const res = await fetch(AI_WORKER_URL + '/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, profile: appState.profile })
    });
    const data = await res.json();
    if (!res.ok || data.error) { goToAiError('screen-sms-paste'); return; }
    lastSmsAnalysis = data;
    finishAllProgress();
    goTo('screen-result-text');
  } catch (err) {
    goToAiError('screen-sms-paste', !navigator.onLine);
  }
}

/** AI 분석 결과를 문자 결과 화면에 반영. AI가 만든 텍스트이므로 textContent로만 채운다(HTML 삽입 금지) */
function renderSmsResult(){
  const data = lastSmsAnalysis;
  if (!data) return;

  applyResultHero(document.querySelector('#screen-result-text .result-card'), data);
}

/* ---------------------------------------------------------
   9. 자동 실행 버튼 (지도 열기)
   --------------------------------------------------------- */
function openMap(query){
  window.open('https://map.kakao.com/?q=' + encodeURIComponent(query), '_blank');
}

/* ---------------------------------------------------------
   10. 긴급 도움 FAB + Bottom Sheet
   --------------------------------------------------------- */
function openEmergencySheet(){
  document.getElementById('emergencyBackdrop').style.display = 'block';
  document.getElementById('emergencySheet').style.display = 'block';
  speak('긴급 도움 메뉴입니다.');
}
function closeEmergencySheet(){
  document.getElementById('emergencyBackdrop').style.display = 'none';
  document.getElementById('emergencySheet').style.display = 'none';
}
function callGuardianFromSheet(){
  closeEmergencySheet();
  callGuardian();
}

/* ---------------------------------------------------------
   11. 보호자 공유 (문자 / 카카오톡 / 복사)
   --------------------------------------------------------- */
function shareViaCopy(text){
  navigator.clipboard.writeText(text)
    .then(() => showGlobalToast('복사되었습니다.'))
    .catch(() => showGlobalToast('복사에 실패했어요.'));
}

function shareViaSms(text){
  const phone = appState.guardian.phone || '';
  window.open(`sms:${phone}?body=${encodeURIComponent(text)}`);
}

function shareViaKakao(text){
  if (navigator.share) {
    navigator.share({ title: 'AI 디지털 도우미', text }).catch(() => {});
  } else {
    shareViaCopy(text);
    showGlobalToast('카카오톡 공유는 모바일 앱에서 지원돼요. 대신 내용을 복사했어요.');
  }
}

/* ---------------------------------------------------------
   12. 설정 (글자 크기 / 음성 속도 / 보호자 정보)
   --------------------------------------------------------- */
/** 설정 화면의 세그먼트 버튼 그룹(글자 크기/음성 속도)에서 현재 값에 맞는 버튼만 active로 표시 */
function syncToggleGroup(groupId, datasetKey, currentValue){
  document.querySelectorAll('#' + groupId + ' button').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset[datasetKey]) === currentValue);
  });
}

function setFontScale(value){
  appState.settings.fontScale = value;
  document.documentElement.style.setProperty('--scale', value);
  syncToggleGroup('fontScaleGroup', 'scale', value);
  saveState();
}

function setVoiceRate(value){
  appState.settings.voiceRate = value;
  syncToggleGroup('voiceRateGroup', 'rate', value);
  saveState();
  speak('이 정도 속도로 읽어드릴게요.');
}

function saveGuardian(){
  appState.guardian.name = document.getElementById('guardianName').value.trim();
  appState.guardian.phone = document.getElementById('guardianPhone').value.trim();
  appState.guardian.autoNotify = document.getElementById('autoNotifyToggle').checked;
  saveState();
}

/* ---------------------------------------------------------
   언어 설정 (경기도 거주 외국인주민 통계 기준 상위 4개국 언어).
   핵심 화면(홈/설정) 문구만 번역하고, AI 분석 결과는 정확성을 위해 항상 한국어로 유지한다.
   --------------------------------------------------------- */
const I18N = {
  ko: {
    'home.sectionTitle': '무엇을 도와드릴까요?',
    'home.docTitle': '문서 촬영',
    'home.docDesc': '문서를 찍으면 내용을 요약해 드려요',
    'home.smsTitle': '문자 내용 요약',
    'home.smsDesc': '문자 내용이 진짜인지 구분하고 요약해 드려요',
    'home.welfareTitle': '주변 복지센터·경로당 찾기',
    'home.welfareDesc': '내 위치 주변 복지센터·경로당 위치를 알려드려요',
    'home.todayTasks': '오늘 해야 할 일',
    'home.viewAll': '전체 보기',
    'home.noTasksToday': '오늘 할 일이 없습니다.',
    'home.publicInfoDefault': '알아두면 좋은 정보',
    'home.disclaimer': '본 서비스는 AI 분석 결과로 참고용이며,<br>중요 문서는 전문가와 상담하시기 바랍니다.',
    'nav.home': '홈', 'nav.info': '정보', 'nav.history': '기록', 'nav.settings': '설정',
    'info.sectionTitle': '알아두면 좋은 정보',
    'info.empty': '표시할 정보를 불러오지 못했어요.<br>설정에서 사시는 지역을 입력하시면 더 많은 정보를 볼 수 있어요.',
    'settings.title': '설정',
    'settings.fontSize': '화면 글자 크기',
    'settings.fontNormal': '보통', 'settings.fontLarge': '크게', 'settings.fontXLarge': '아주 크게',
    'settings.voiceSpeed': '음성 읽기 속도',
    'settings.rate1': '1배속', 'settings.rate15': '1.5배속', 'settings.rate2': '2배속',
    'settings.replay': '다시 읽기', 'settings.stop': '멈추기',
    'settings.voiceEnable': '음성 안내 사용하기',
    'settings.myInfo': '내 정보 (맞춤 안내용, 선택 사항)',
    'settings.nameLabel': '이름', 'settings.namePlaceholder': '예: 홍길동',
    'settings.male': '남성', 'settings.female': '여성',
    'settings.age60': '60대', 'settings.age70': '70대', 'settings.age80': '80대 이상',
    'settings.regionLabel': '사시는 지역', 'settings.regionPlaceholder': '예: 경기도 안산시 상록구',
    'settings.myInfoNote': '문서·문자를 분석할 때 이 정보를 함께 참고해서 더 알맞게 설명해드려요. 다른 곳에 공유되지 않습니다.',
    'settings.guardian': '보호자 정보',
    'settings.guardianNameLabel': '보호자 이름', 'settings.guardianNamePlaceholder': '예: 김민수 (아들)',
    'settings.guardianPhoneLabel': '보호자 전화번호', 'settings.guardianPhonePlaceholder': '예: 010-1234-5678',
    'settings.autoNotify': '🔴 위험 문자 발견 시 자동으로 알림 보내기',
    'settings.guardianNote': '모든 설정은 이 기기에 자동 저장되어, 앱을 새로고침해도 유지됩니다.',
    'settings.language': '언어 설정',
    'settings.languageNote': '경기도 거주 외국인주민 중 비중이 높은 4개 언어를 지원합니다(중국·베트남·태국·우즈베키스탄, 공공통계 기준 상위 국적). 화면 핵심 문구만 번역되며, AI 분석 결과는 정확성을 위해 한국어로 제공됩니다.',
    'settings.support': '고객 지원',
    'settings.supportHelp': '사용 방법 안내',
    'settings.supportOnboarding': '화면 안내(첫 실행 안내) 다시 보기',
    'settings.supportCenter': '고객센터 연결',
    'onboard.replay': '다시 듣기', 'onboard.skip': '건너뛰기',
    'onboard.greet.title': '안녕하세요.<br>AI 디지털 도우미입니다.',
    'onboard.greet.desc': '문서를 쉽게 이해하고<br>해야 할 일을 알려드리겠습니다.',
    'onboard.greet.start': '시작하기',
    'onboard.greet.voice': '안녕하세요. AI 디지털 도우미입니다. 실제 화면을 보여드리며 사용 방법을 간단히 안내해드릴게요.',
    'onboard.profile.title': '몇 가지만<br>알려주시겠어요?',
    'onboard.profile.desc': '입력하신 정보는 이 기기와 안전한 서버에만 저장되고,<br>더 알맞은 설명을 드리는 데만 사용돼요.<br>원하지 않으면 건너뛰어도 됩니다.',
    'onboard.profile.genderLabel': '성별', 'onboard.profile.ageLabel': '연령대',
    'onboard.profile.age50': '50대 이하', 'onboard.profile.age60': '60대', 'onboard.profile.age70': '70대', 'onboard.profile.age80': '80대 이상',
    'skipConfirm.title': '튜토리얼을 건너뛸까요?', 'skipConfirm.keep': '계속 보기',
    'onboard.profile.useLocation': '내 현재 위치 입력하기',
    'onboard.profile.regionNote': '시/군/구까지 자세히 적어주시면 더 알맞은 정보를 드릴 수 있어요.',
    'onboard.profile.next': '다음',
    'onboard.profile.voice': '이름과 성별, 연령대, 사시는 지역을 알려주시면 더 맞춤형으로 도와드릴 수 있어요. 원하지 않으면 건너뛰어도 됩니다.',
    'onboard.notice.title': '지금은 분석이 어려워요.',
    'onboard.notice.desc': '지금은 체험판(튜토리얼)이라<br>실제 분석은 제공되지 않을 수 있어요.<br>궁금한 점은 관리자에게 문의하세요.',
    'onboard.notice.next': '다음으로 계속하기',
    'onboard.notice.voice': '지금은 분석이 어려워요. 체험판이라 실제 분석은 제공되지 않을 수 있어요. 궁금한 점은 관리자에게 문의하세요.',
    'coach.cat.doc': '문서', 'coach.cat.sms': '문자', 'coach.cat.history': '기록', 'coach.cat.info': '정보',
    'coach.cat.welfare': '복지', 'coach.cat.voice': '음성', 'coach.cat.emergency': '긴급', 'coach.cat.settings': '설정',
    'coach.cat.help': '안내',
    'coach.moreHelp.title': '여기서 다른 기능도 볼 수 있어요', 'coach.moreHelp.desc': '아래 정보·기록·설정을 눌러 보세요.', 'coach.moreHelp.voice': '아래쪽 메뉴에서 다른 기능도 볼 수 있어요.',
    'coach.next': '다음으로 넘어가기', 'coach.skipTutorial': '튜토리얼 건너뛰기',
    'coach.doc1.title': '문서를 촬영해보세요', 'coach.doc1.desc': '이 카드를 누르면 문서를 찍어 AI에게 분석을 맡길 수 있어요.', 'coach.doc1.voice': '문서 촬영 카드를 눌러보세요.',
    'coach.doc2.title': '직접 촬영해볼게요', 'coach.doc2.desc': '카메라로 문서를 찍어보세요.', 'coach.doc2.voice': '직접 촬영하기를 눌러보세요.',
    'coach.doc3.title': '촬영 버튼을 눌러주세요', 'coach.doc3.desc': '문서가 화면 가운데 오도록 맞추고 눌러주세요.', 'coach.doc3.voice': '촬영 버튼을 눌러주세요.',
    'coach.sms1.title': '문자도 확인해보세요', 'coach.sms1.desc': '받은 문자가 안전한지도 확인할 수 있어요.', 'coach.sms1.voice': '문자 내용 요약 카드를 눌러보세요.',
    'coach.sms2.title': '문자 앱을 눌러보세요', 'coach.sms2.desc': '문자 앱을 열어볼게요.', 'coach.sms2.voice': '문자 앱을 눌러보세요.',
    'coach.sms3.title': '문자를 길게 눌러 복사해보세요', 'coach.sms3.desc': '실제로는 확인하고 싶은 문자를 길게 눌러 복사하면 돼요.', 'coach.sms3.voice': '문자를 길게 눌러 복사해보세요.',
    'coach.sms4.title': '다시 이 앱으로 돌아와주세요', 'coach.sms4.desc': '복사했다면 이 버튼을 눌러 앱으로 돌아오세요.', 'coach.sms4.voice': '앱 열기 버튼을 눌러주세요.',
    'coach.sms5.title': '길게 눌러 붙여넣어보세요', 'coach.sms5.desc': '이 칸을 길게 눌러 붙여넣기를 선택하세요. 화면을 빠르게 두 번 톡톡 두드리면 더 쉽게 붙여넣을 수 있어요.', 'coach.sms5.voice': '붙여넣기 칸을 눌러보세요. 빠르게 두 번 두드리면 더 쉽게 붙여넣을 수 있어요.',
    'coach.sms6.title': '확인을 눌러주세요', 'coach.sms6.desc': '붙여넣기가 끝나면 확인을 눌러주세요.', 'coach.sms6.voice': '확인 버튼을 눌러주세요.',
    'coach.sms7.title': '확인을 눌러 결과를 보세요', 'coach.sms7.desc': '이 버튼을 누르면 AI가 문자를 확인해드려요.', 'coach.sms7.voice': '확인 버튼을 눌러 결과를 확인하세요.',
    'coach.history1.title': '최근 기록도 볼 수 있어요', 'coach.history1.desc': '지금까지 확인한 문서와 문자 기록을 모아볼 수 있어요.', 'coach.history1.voice': '최근 기록 버튼을 눌러보세요.',
    'coach.history2.title': '다시 홈으로 돌아가볼게요', 'coach.history2.desc': '← 홈으로 버튼을 누르면 언제든 돌아갈 수 있어요.', 'coach.history2.voice': '홈으로 버튼을 눌러 돌아가보세요.',
    'coach.info1.title': '알아두면 좋은 정보도 있어요', 'coach.info1.desc': '기초연금, 건강검진 같은 유용한 정보를 안내해드려요.', 'coach.info1.voice': '알아두면 좋은 정보를 눌러보세요.',
    'coach.info2.title': '다 보셨으면 홈으로 돌아가요', 'coach.info2.desc': '홈으로 돌아가기 버튼을 눌러주세요.', 'coach.info2.voice': '홈으로 돌아가기 버튼을 눌러주세요.',
    'coach.welfare1.title': '주변 복지센터·경로당도 찾아드려요', 'coach.welfare1.desc': '내 위치 주변의 복지센터와 경로당 위치를 함께 알려드려요.', 'coach.welfare1.voice': '주변 복지센터·경로당 찾기를 눌러보세요.',
    'coach.welfare2.title': '홈 화면으로 돌아가볼게요', 'coach.welfare2.desc': '홈 화면으로 돌아가기 버튼을 눌러주세요.', 'coach.welfare2.voice': '홈 화면으로 돌아가기 버튼을 눌러주세요.',
    'coach.voice1.title': '음성으로 안내받을 수도 있어요', 'coach.voice1.desc': '이 버튼을 누르면 화면 안내를 다시 들을 수 있어요.', 'coach.voice1.voice': '음성으로 안내받기 버튼을 눌러보세요.',
    'coach.emergency1.title': '긴급할 땐 이 버튼을 누르세요', 'coach.emergency1.desc': '보호자나 119·112·118로 바로 연락할 수 있어요. 눌러서 직접 확인해보시고, 다 보셨으면 다음으로 넘어가세요.', 'coach.emergency1.voice': '도움 버튼을 눌러보세요. 확인하셨으면 다음으로 눌러 넘어가세요.',
    'coach.settingsIntro.title': '설정도 살펴볼게요', 'coach.settingsIntro.desc': '글자 크기, 음성 속도, 보호자 정보를 바꿀 수 있어요.', 'coach.settingsIntro.voice': '설정 버튼을 눌러보세요.',
    'coach.fontsize.title': '글자 크기를 바꿔보세요', 'coach.fontsize.desc': '보통, 크게, 아주 크게 중에서 골라보세요. 다 고르셨으면 다음으로 넘어가세요.', 'coach.fontsize.voice': '글자 크기를 눌러보세요. 다 고르셨으면 다음으로 눌러 넘어가세요.',
    'coach.rate.title': '음성 속도도 바꿀 수 있어요', 'coach.rate.desc': '읽어주는 속도를 편한 대로 골라보세요. 다 고르셨으면 다음으로 넘어가세요.', 'coach.rate.voice': '음성 읽기 속도를 눌러보세요. 다 고르셨으면 다음으로 눌러 넘어가세요.',
    'coach.guardian.title': '보호자 정보를 등록해보세요', 'coach.guardian.desc': '위험한 문자를 발견하면 보호자에게 바로 알릴 수 있어요. 선택 사항이니 원하지 않으면 다음으로 넘어가도 돼요.', 'coach.guardian.voice': '보호자 이름을 입력해보세요. 원하지 않으면 다음으로 눌러 넘어가도 됩니다.',
    'coach.helplink.title': '사용 방법 안내도 있어요', 'coach.helplink.desc': '헷갈릴 때 언제든 다시 볼 수 있어요.', 'coach.helplink.voice': '사용 방법 안내를 눌러보세요.',
    'coach.helpback.title': '뒤로 가서 마무리할게요', 'coach.helpback.desc': '← 뒤로 버튼을 눌러주세요.', 'coach.helpback.voice': '뒤로 버튼을 눌러주세요.',
    'coach.finish.title': '이제 홈으로 돌아가면 끝이에요', 'coach.finish.desc': '← 홈으로 버튼을 눌러 안내를 마쳐요.', 'coach.finish.voice': '홈으로 버튼을 눌러 안내를 마쳐요.',
    'coach.language.title': '언어도 바꿀 수 있어요', 'coach.language.desc': '중국어·베트남어·태국어·우즈베크어 중에서 골라보세요. 다 고르셨으면 다음으로 넘어가세요.', 'coach.language.voice': '언어 설정을 눌러보세요. 다 고르셨으면 다음으로 눌러 넘어가세요.'
  },
  zh: {
    'home.sectionTitle': '需要什么帮助？',
    'home.docTitle': '拍摄文件',
    'home.docDesc': '拍摄文件后为您总结内容',
    'home.smsTitle': '短信内容摘要',
    'home.smsDesc': '判断短信真伪并为您总结',
    'home.welfareTitle': '附近福利中心·老人活动中心',
    'home.welfareDesc': '为您查找所在位置附近的福利中心、老人活动中心',
    'home.todayTasks': '今天要做的事',
    'home.viewAll': '查看全部',
    'home.noTasksToday': '今天没有要做的事。',
    'home.publicInfoDefault': '需要了解的信息',
    'home.disclaimer': '本服务为AI分析结果，仅供参考，<br>重要文件请咨询专业人士。',
    'nav.home': '主页', 'nav.info': '信息', 'nav.history': '记录', 'nav.settings': '设置',
    'info.sectionTitle': '需要了解的信息',
    'info.empty': '无法加载要显示的信息。<br>在设置中输入您居住的地区，可以查看更多信息。',
    'settings.title': '设置',
    'settings.fontSize': '屏幕字体大小',
    'settings.fontNormal': '普通', 'settings.fontLarge': '大', 'settings.fontXLarge': '特大',
    'settings.voiceSpeed': '语音朗读速度',
    'settings.rate1': '1倍速', 'settings.rate15': '1.5倍速', 'settings.rate2': '2倍速',
    'settings.replay': '重新播放', 'settings.stop': '停止',
    'settings.voiceEnable': '使用语音讲解',
    'settings.myInfo': '我的信息（用于个性化说明，可选）',
    'settings.nameLabel': '姓名', 'settings.namePlaceholder': '例：洪吉童',
    'settings.male': '男', 'settings.female': '女',
    'settings.age60': '60多岁', 'settings.age70': '70多岁', 'settings.age80': '80岁以上',
    'settings.regionLabel': '居住地区', 'settings.regionPlaceholder': '例：京畿道安山市常绿区',
    'settings.myInfoNote': '分析文件或短信时会参考这些信息，为您提供更合适的说明。不会分享给其他人。',
    'settings.guardian': '监护人信息',
    'settings.guardianNameLabel': '监护人姓名', 'settings.guardianNamePlaceholder': '例：金民洙（儿子）',
    'settings.guardianPhoneLabel': '监护人电话号码', 'settings.guardianPhonePlaceholder': '例：010-1234-5678',
    'settings.autoNotify': '🔴 发现危险短信时自动发送通知',
    'settings.guardianNote': '所有设置都会自动保存在此设备上，刷新应用后仍会保留。',
    'settings.language': '语言设置',
    'settings.languageNote': '支持京畿道外国居民中比例较高的4种语言（中文·越南语·泰语·乌兹别克语，依公共统计数据）。仅翻译核心画面文字，AI分析结果为确保准确性，始终以韩语提供。',
    'settings.support': '客户支持',
    'settings.supportHelp': '使用方法说明',
    'settings.supportOnboarding': '重新查看画面指南（首次使用指南）',
    'settings.supportCenter': '联系客服中心',
    'onboard.replay': '再听一次', 'onboard.skip': '跳过',
    'onboard.greet.title': '您好。<br>我是AI数字助手。',
    'onboard.greet.desc': '帮您轻松理解文件，<br>并告诉您需要做的事。',
    'onboard.greet.start': '开始',
    'onboard.greet.voice': '您好。我是AI数字助手。我会通过实际画面简单介绍使用方法。',
    'onboard.profile.title': '请告诉我<br>几项信息好吗？',
    'onboard.profile.desc': '您输入的信息只保存在本设备和安全的服务器中，<br>仅用于提供更合适的说明。<br>不想输入的话也可以跳过。',
    'onboard.profile.genderLabel': '性别', 'onboard.profile.ageLabel': '年龄段',
    'onboard.profile.age50': '50多岁及以下', 'onboard.profile.age60': '60多岁', 'onboard.profile.age70': '70多岁', 'onboard.profile.age80': '80岁以上',
    'skipConfirm.title': '要跳过教程吗？', 'skipConfirm.keep': '继续观看',
    'onboard.profile.useLocation': '输入我的当前位置',
    'onboard.profile.regionNote': '详细填写到市/郡/区，可以为您提供更合适的信息。',
    'onboard.profile.next': '下一步',
    'onboard.profile.voice': '请告诉我姓名、性别、年龄段、居住地区，我可以为您提供更贴心的帮助。不想输入的话也可以跳过。',
    'onboard.notice.title': '现在暂时无法分析。',
    'onboard.notice.desc': '现在是体验版（教程），<br>可能无法提供实际分析。<br>如有疑问请联系管理员。',
    'onboard.notice.next': '下一步继续',
    'onboard.notice.voice': '现在暂时无法分析。因为是体验版，可能无法提供实际分析。如有疑问请联系管理员。',
    'coach.cat.doc': '文件', 'coach.cat.sms': '短信', 'coach.cat.history': '记录', 'coach.cat.info': '信息',
    'coach.cat.welfare': '福利', 'coach.cat.voice': '语音', 'coach.cat.emergency': '紧急', 'coach.cat.settings': '设置',
    'coach.cat.help': '指引',
    'coach.moreHelp.title': '在这里还能看到其他功能', 'coach.moreHelp.desc': '请点击下方的信息、记录、设置。', 'coach.moreHelp.voice': '在下方菜单中还能看到其他功能。',
    'coach.next': '继续下一步', 'coach.skipTutorial': '跳过教程',
    'coach.doc1.title': '拍摄文件试试看', 'coach.doc1.desc': '点击此卡片可以拍摄文件并交给AI分析。', 'coach.doc1.voice': '请点击拍摄文件卡片。',
    'coach.doc2.title': '直接拍摄一下', 'coach.doc2.desc': '用相机拍摄文件吧。', 'coach.doc2.voice': '请点击直接拍摄。',
    'coach.doc3.title': '请按拍摄按钮', 'coach.doc3.desc': '将文件对准屏幕中央后按下按钮。', 'coach.doc3.voice': '请按拍摄按钮。',
    'coach.sms1.title': '短信也可以确认', 'coach.sms1.desc': '也可以确认收到的短信是否安全。', 'coach.sms1.voice': '请点击短信内容摘要卡片。',
    'coach.sms2.title': '请点击短信应用', 'coach.sms2.desc': '我们来打开短信应用。', 'coach.sms2.voice': '请点击短信应用。',
    'coach.sms3.title': '长按短信复制试试看', 'coach.sms3.desc': '实际使用时，长按想确认的短信即可复制。', 'coach.sms3.voice': '请长按短信进行复制。',
    'coach.sms4.title': '请再回到本应用', 'coach.sms4.desc': '复制完成后，请点击此按钮返回应用。', 'coach.sms4.voice': '请点击打开应用按钮。',
    'coach.sms5.title': '长按粘贴试试看', 'coach.sms5.desc': '长按此处后选择粘贴。快速点击两下屏幕可以更轻松地粘贴。', 'coach.sms5.voice': '请点击粘贴框。快速点击两下可以更轻松粘贴。',
    'coach.sms6.title': '请点击确认', 'coach.sms6.desc': '粘贴完成后请点击确认。', 'coach.sms6.voice': '请点击确认按钮。',
    'coach.sms7.title': '点击确认查看结果', 'coach.sms7.desc': '点击此按钮AI会为您确认短信。', 'coach.sms7.voice': '请点击确认按钮查看结果。',
    'coach.history1.title': '也可以查看最近记录', 'coach.history1.desc': '可以汇总查看至今确认过的文件和短信记录。', 'coach.history1.voice': '请点击最近记录按钮。',
    'coach.history2.title': '我们再回到首页', 'coach.history2.desc': '点击←返回首页按钮可以随时返回。', 'coach.history2.voice': '请点击返回首页按钮。',
    'coach.info1.title': '还有值得了解的信息', 'coach.info1.desc': '为您提供基础养老金、健康体检等实用信息。', 'coach.info1.voice': '请点击值得了解的信息。',
    'coach.info2.title': '看完了就回到首页吧', 'coach.info2.desc': '请点击返回首页按钮。', 'coach.info2.voice': '请点击返回首页按钮。',
    'coach.welfare1.title': '也为您查找附近的福利中心·老人活动中心', 'coach.welfare1.desc': '为您提供所在位置附近的福利中心和老人活动中心位置。', 'coach.welfare1.voice': '请点击附近福利中心·老人活动中心查询。',
    'coach.welfare2.title': '我们再回到首页', 'coach.welfare2.desc': '请点击返回首页按钮。', 'coach.welfare2.voice': '请点击返回首页按钮。',
    'coach.voice1.title': '也可以用语音获得指引', 'coach.voice1.desc': '点击此按钮可以再次听取画面指引。', 'coach.voice1.voice': '请点击语音指引按钮。',
    'coach.emergency1.title': '紧急情况请按此按钮', 'coach.emergency1.desc': '可以直接联系监护人或119·112·118。请点击直接确认，确认完毕后点击下一步。', 'coach.emergency1.voice': '请点击求助按钮。确认后请点击下一步继续。',
    'coach.settingsIntro.title': '我们也看看设置', 'coach.settingsIntro.desc': '可以更改字体大小、语音速度、监护人信息。', 'coach.settingsIntro.voice': '请点击设置按钮。',
    'coach.fontsize.title': '试试更改字体大小', 'coach.fontsize.desc': '可以在普通、大、特大中选择。选好后请点击下一步。', 'coach.fontsize.voice': '请点击字体大小。选好后请点击下一步继续。',
    'coach.rate.title': '语音速度也可以更改', 'coach.rate.desc': '请选择您喜欢的朗读速度。选好后请点击下一步。', 'coach.rate.voice': '请点击语音朗读速度。选好后请点击下一步继续。',
    'coach.guardian.title': '试试登记监护人信息', 'coach.guardian.desc': '发现危险短信时可以立即通知监护人。这是可选项，不需要的话可以直接下一步。', 'coach.guardian.voice': '请输入监护人姓名。不需要的话可以点击下一步跳过。',
    'coach.helplink.title': '还有使用方法说明', 'coach.helplink.desc': '遇到不明白的地方随时可以再查看。', 'coach.helplink.voice': '请点击使用方法说明。',
    'coach.helpback.title': '我们返回并结束吧', 'coach.helpback.desc': '请点击←返回按钮。', 'coach.helpback.voice': '请点击返回按钮。',
    'coach.finish.title': '现在回到首页就结束了', 'coach.finish.desc': '请点击←返回首页按钮结束指引。', 'coach.finish.voice': '请点击返回首页按钮结束指引。',
    'coach.language.title': '语言也可以更改', 'coach.language.desc': '请在中文·越南语·泰语·乌兹别克语中选择。选好后请点击下一步。', 'coach.language.voice': '请点击语言设置。选好后请点击下一步继续。'
  },
  vi: {
    'home.sectionTitle': 'Bạn cần giúp gì?',
    'home.docTitle': 'Chụp tài liệu',
    'home.docDesc': 'Chụp tài liệu để được tóm tắt nội dung',
    'home.smsTitle': 'Tóm tắt tin nhắn',
    'home.smsDesc': 'Kiểm tra tin nhắn thật hay giả và tóm tắt',
    'home.welfareTitle': 'Tìm trung tâm phúc lợi và nhà sinh hoạt người cao tuổi',
    'home.welfareDesc': 'Tìm trung tâm phúc lợi, nhà sinh hoạt người cao tuổi gần vị trí của bạn',
    'home.todayTasks': 'Việc cần làm hôm nay',
    'home.viewAll': 'Xem tất cả',
    'home.noTasksToday': 'Hôm nay không có việc cần làm.',
    'home.publicInfoDefault': 'Thông tin nên biết',
    'home.disclaimer': 'Dịch vụ này chỉ mang tính tham khảo (kết quả phân tích AI),<br>hãy hỏi chuyên gia với tài liệu quan trọng.',
    'nav.home': 'Trang chủ', 'nav.info': 'Thông tin', 'nav.history': 'Lịch sử', 'nav.settings': 'Cài đặt',
    'info.sectionTitle': 'Thông tin nên biết',
    'info.empty': 'Không tải được thông tin để hiển thị.<br>Nhập khu vực bạn đang sống trong Cài đặt để xem thêm thông tin.',
    'settings.title': 'Cài đặt',
    'settings.fontSize': 'Cỡ chữ màn hình',
    'settings.fontNormal': 'Vừa', 'settings.fontLarge': 'Lớn', 'settings.fontXLarge': 'Rất lớn',
    'settings.voiceSpeed': 'Tốc độ đọc giọng nói',
    'settings.rate1': 'Tốc độ 1x', 'settings.rate15': 'Tốc độ 1.5x', 'settings.rate2': 'Tốc độ 2x',
    'settings.replay': 'Nghe lại', 'settings.stop': 'Dừng lại',
    'settings.voiceEnable': 'Sử dụng hướng dẫn bằng giọng nói',
    'settings.myInfo': 'Thông tin của tôi (dùng để cá nhân hóa, không bắt buộc)',
    'settings.nameLabel': 'Tên', 'settings.namePlaceholder': 'VD: Hong Gil Dong',
    'settings.male': 'Nam', 'settings.female': 'Nữ',
    'settings.age60': 'Ngoài 60', 'settings.age70': 'Ngoài 70', 'settings.age80': 'Trên 80',
    'settings.regionLabel': 'Nơi ở', 'settings.regionPlaceholder': 'VD: Sangnok-gu, Ansan-si, Gyeonggi-do',
    'settings.myInfoNote': 'Thông tin này sẽ được tham khảo khi phân tích tài liệu/tin nhắn để giải thích phù hợp hơn. Không chia sẻ cho nơi khác.',
    'settings.guardian': 'Thông tin người giám hộ',
    'settings.guardianNameLabel': 'Tên người giám hộ', 'settings.guardianNamePlaceholder': 'VD: Kim Min Su (con trai)',
    'settings.guardianPhoneLabel': 'Số điện thoại người giám hộ', 'settings.guardianPhonePlaceholder': 'VD: 010-1234-5678',
    'settings.autoNotify': '🔴 Tự động gửi thông báo khi phát hiện tin nhắn nguy hiểm',
    'settings.guardianNote': 'Mọi cài đặt được tự động lưu trên thiết bị này, vẫn giữ nguyên dù tải lại ứng dụng.',
    'settings.language': 'Cài đặt ngôn ngữ',
    'settings.languageNote': 'Hỗ trợ 4 ngôn ngữ có tỷ lệ cư dân nước ngoài cao ở Gyeonggi (Trung·Việt·Thái·Uzbek, theo thống kê công). Chỉ dịch các cụm từ chính trên màn hình, kết quả phân tích AI luôn bằng tiếng Hàn để đảm bảo chính xác.',
    'settings.support': 'Hỗ trợ khách hàng',
    'settings.supportHelp': 'Hướng dẫn sử dụng',
    'settings.supportOnboarding': 'Xem lại hướng dẫn màn hình (hướng dẫn lần đầu)',
    'settings.supportCenter': 'Kết nối trung tâm hỗ trợ',
    'onboard.replay': 'Nghe lại', 'onboard.skip': 'Bỏ qua',
    'onboard.greet.title': 'Xin chào.<br>Tôi là trợ lý số AI.',
    'onboard.greet.desc': 'Tôi sẽ giúp bạn dễ dàng hiểu tài liệu<br>và biết việc cần làm.',
    'onboard.greet.start': 'Bắt đầu',
    'onboard.greet.voice': 'Xin chào. Tôi là trợ lý số AI. Tôi sẽ hướng dẫn cách sử dụng đơn giản qua màn hình thực tế.',
    'onboard.profile.title': 'Cho tôi biết<br>một vài thông tin nhé?',
    'onboard.profile.desc': 'Thông tin bạn nhập chỉ được lưu trên thiết bị này và máy chủ an toàn,<br>chỉ dùng để đưa ra giải thích phù hợp hơn.<br>Nếu không muốn, bạn có thể bỏ qua.',
    'onboard.profile.genderLabel': 'Giới tính', 'onboard.profile.ageLabel': 'Độ tuổi',
    'onboard.profile.age50': '50 trở xuống', 'onboard.profile.age60': '60–69', 'onboard.profile.age70': '70–79', 'onboard.profile.age80': '80 trở lên',
    'skipConfirm.title': 'Bỏ qua hướng dẫn?', 'skipConfirm.keep': 'Tiếp tục xem',
    'onboard.profile.useLocation': 'Nhập vị trí hiện tại của tôi',
    'onboard.profile.regionNote': 'Nếu ghi rõ đến quận/huyện, chúng tôi có thể cung cấp thông tin phù hợp hơn.',
    'onboard.profile.next': 'Tiếp theo',
    'onboard.profile.voice': 'Cho tôi biết tên, giới tính, độ tuổi, nơi ở để tôi giúp bạn phù hợp hơn. Nếu không muốn, bạn có thể bỏ qua.',
    'onboard.notice.title': 'Hiện tại chưa thể phân tích.',
    'onboard.notice.desc': 'Đây là bản dùng thử (hướng dẫn),<br>nên có thể chưa cung cấp phân tích thực tế.<br>Nếu có thắc mắc, hãy liên hệ quản trị viên.',
    'onboard.notice.next': 'Tiếp tục',
    'onboard.notice.voice': 'Hiện tại chưa thể phân tích. Vì đây là bản dùng thử nên có thể chưa cung cấp phân tích thực tế. Nếu có thắc mắc, hãy liên hệ quản trị viên.',
    'coach.cat.doc': 'Tài liệu', 'coach.cat.sms': 'Tin nhắn', 'coach.cat.history': 'Lịch sử', 'coach.cat.info': 'Thông tin',
    'coach.cat.welfare': 'Phúc lợi', 'coach.cat.voice': 'Giọng nói', 'coach.cat.emergency': 'Khẩn cấp', 'coach.cat.settings': 'Cài đặt',
    'coach.cat.help': 'Hướng dẫn',
    'coach.moreHelp.title': 'Bạn có thể xem các chức năng khác ở đây', 'coach.moreHelp.desc': 'Hãy nhấn vào Thông tin, Lịch sử, Cài đặt ở bên dưới.', 'coach.moreHelp.voice': 'Bạn có thể xem các chức năng khác ở menu bên dưới.',
    'coach.next': 'Chuyển sang bước tiếp theo', 'coach.skipTutorial': 'Bỏ qua hướng dẫn',
    'coach.doc1.title': 'Hãy thử chụp tài liệu', 'coach.doc1.desc': 'Nhấn vào thẻ này để chụp tài liệu và nhờ AI phân tích.', 'coach.doc1.voice': 'Hãy nhấn vào thẻ chụp tài liệu.',
    'coach.doc2.title': 'Chúng ta chụp trực tiếp nhé', 'coach.doc2.desc': 'Hãy chụp tài liệu bằng camera.', 'coach.doc2.voice': 'Hãy nhấn chụp trực tiếp.',
    'coach.doc3.title': 'Hãy nhấn nút chụp', 'coach.doc3.desc': 'Canh tài liệu vào giữa màn hình rồi nhấn nút.', 'coach.doc3.voice': 'Hãy nhấn nút chụp.',
    'coach.sms1.title': 'Cũng có thể kiểm tra tin nhắn', 'coach.sms1.desc': 'Bạn cũng có thể kiểm tra tin nhắn nhận được có an toàn không.', 'coach.sms1.voice': 'Hãy nhấn vào thẻ tóm tắt nội dung tin nhắn.',
    'coach.sms2.title': 'Hãy nhấn vào ứng dụng tin nhắn', 'coach.sms2.desc': 'Chúng ta sẽ mở ứng dụng tin nhắn.', 'coach.sms2.voice': 'Hãy nhấn vào ứng dụng tin nhắn.',
    'coach.sms3.title': 'Hãy thử nhấn giữ tin nhắn để sao chép', 'coach.sms3.desc': 'Trong thực tế, bạn nhấn giữ tin nhắn muốn kiểm tra để sao chép.', 'coach.sms3.voice': 'Hãy nhấn giữ tin nhắn để sao chép.',
    'coach.sms4.title': 'Hãy quay lại ứng dụng này', 'coach.sms4.desc': 'Sau khi sao chép, nhấn nút này để quay lại ứng dụng.', 'coach.sms4.voice': 'Hãy nhấn nút mở ứng dụng.',
    'coach.sms5.title': 'Hãy thử nhấn giữ để dán', 'coach.sms5.desc': 'Nhấn giữ ô này rồi chọn dán. Chạm nhanh hai lần vào màn hình sẽ dễ dán hơn.', 'coach.sms5.voice': 'Hãy nhấn vào ô dán. Chạm nhanh hai lần sẽ dễ dán hơn.',
    'coach.sms6.title': 'Hãy nhấn xác nhận', 'coach.sms6.desc': 'Sau khi dán xong, hãy nhấn xác nhận.', 'coach.sms6.voice': 'Hãy nhấn nút xác nhận.',
    'coach.sms7.title': 'Nhấn xác nhận để xem kết quả', 'coach.sms7.desc': 'Nhấn nút này để AI kiểm tra tin nhắn giúp bạn.', 'coach.sms7.voice': 'Hãy nhấn nút xác nhận để xem kết quả.',
    'coach.history1.title': 'Cũng có thể xem lịch sử gần đây', 'coach.history1.desc': 'Bạn có thể xem lại các tài liệu và tin nhắn đã kiểm tra.', 'coach.history1.voice': 'Hãy nhấn nút lịch sử gần đây.',
    'coach.history2.title': 'Chúng ta quay lại trang chủ nhé', 'coach.history2.desc': 'Nhấn nút ← Về trang chủ để quay lại bất cứ lúc nào.', 'coach.history2.voice': 'Hãy nhấn nút về trang chủ.',
    'coach.info1.title': 'Cũng có thông tin nên biết', 'coach.info1.desc': 'Chúng tôi cung cấp thông tin hữu ích như lương hưu cơ bản, khám sức khỏe.', 'coach.info1.voice': 'Hãy nhấn vào thông tin nên biết.',
    'coach.info2.title': 'Xem xong thì quay lại trang chủ nhé', 'coach.info2.desc': 'Hãy nhấn nút về trang chủ.', 'coach.info2.voice': 'Hãy nhấn nút về trang chủ.',
    'coach.welfare1.title': 'Cũng tìm giúp trung tâm phúc lợi·nhà sinh hoạt người cao tuổi gần đây', 'coach.welfare1.desc': 'Chúng tôi cho biết vị trí trung tâm phúc lợi và nhà sinh hoạt người cao tuổi gần vị trí của bạn.', 'coach.welfare1.voice': 'Hãy nhấn vào tìm trung tâm phúc lợi·người cao tuổi gần đây.',
    'coach.welfare2.title': 'Chúng ta quay lại trang chủ nhé', 'coach.welfare2.desc': 'Hãy nhấn nút về trang chủ.', 'coach.welfare2.voice': 'Hãy nhấn nút về trang chủ.',
    'coach.voice1.title': 'Cũng có thể nghe hướng dẫn bằng giọng nói', 'coach.voice1.desc': 'Nhấn nút này để nghe lại hướng dẫn màn hình.', 'coach.voice1.voice': 'Hãy nhấn nút nghe hướng dẫn bằng giọng nói.',
    'coach.emergency1.title': 'Khẩn cấp thì nhấn nút này', 'coach.emergency1.desc': 'Bạn có thể liên hệ ngay với người giám hộ hoặc 119·112·118. Hãy nhấn thử để kiểm tra, xem xong thì nhấn tiếp theo.', 'coach.emergency1.voice': 'Hãy nhấn nút trợ giúp. Sau khi xem xong hãy nhấn tiếp theo.',
    'coach.settingsIntro.title': 'Chúng ta xem cài đặt nhé', 'coach.settingsIntro.desc': 'Bạn có thể thay đổi cỡ chữ, tốc độ giọng nói, thông tin người giám hộ.', 'coach.settingsIntro.voice': 'Hãy nhấn nút cài đặt.',
    'coach.fontsize.title': 'Hãy thử đổi cỡ chữ', 'coach.fontsize.desc': 'Chọn giữa vừa, lớn, rất lớn. Chọn xong hãy nhấn tiếp theo.', 'coach.fontsize.voice': 'Hãy nhấn cỡ chữ. Chọn xong hãy nhấn tiếp theo.',
    'coach.rate.title': 'Cũng có thể đổi tốc độ giọng nói', 'coach.rate.desc': 'Hãy chọn tốc độ đọc phù hợp với bạn. Chọn xong hãy nhấn tiếp theo.', 'coach.rate.voice': 'Hãy nhấn tốc độ đọc giọng nói. Chọn xong hãy nhấn tiếp theo.',
    'coach.guardian.title': 'Hãy thử đăng ký thông tin người giám hộ', 'coach.guardian.desc': 'Khi phát hiện tin nhắn nguy hiểm, có thể báo ngay cho người giám hộ. Đây là mục tùy chọn, nếu không muốn có thể nhấn tiếp theo.', 'coach.guardian.voice': 'Hãy nhập tên người giám hộ. Nếu không muốn, hãy nhấn tiếp theo để bỏ qua.',
    'coach.helplink.title': 'Cũng có hướng dẫn sử dụng', 'coach.helplink.desc': 'Khi bối rối, bạn có thể xem lại bất cứ lúc nào.', 'coach.helplink.voice': 'Hãy nhấn vào hướng dẫn sử dụng.',
    'coach.helpback.title': 'Chúng ta quay lại để kết thúc nhé', 'coach.helpback.desc': 'Hãy nhấn nút ← Quay lại.', 'coach.helpback.voice': 'Hãy nhấn nút quay lại.',
    'coach.finish.title': 'Giờ quay lại trang chủ là xong', 'coach.finish.desc': 'Hãy nhấn nút ← Về trang chủ để kết thúc hướng dẫn.', 'coach.finish.voice': 'Hãy nhấn nút về trang chủ để kết thúc hướng dẫn.',
    'coach.language.title': 'Cũng có thể đổi ngôn ngữ', 'coach.language.desc': 'Hãy chọn giữa tiếng Trung·Việt·Thái·Uzbek. Chọn xong hãy nhấn tiếp theo.', 'coach.language.voice': 'Hãy nhấn cài đặt ngôn ngữ. Chọn xong hãy nhấn tiếp theo.'
  },
  th: {
    'home.sectionTitle': 'ต้องการความช่วยเหลือเรื่องอะไร?',
    'home.docTitle': 'ถ่ายภาพเอกสาร',
    'home.docDesc': 'ถ่ายภาพเอกสารแล้วเราจะสรุปเนื้อหาให้',
    'home.smsTitle': 'สรุปข้อความ',
    'home.smsDesc': 'ตรวจสอบว่าข้อความจริงหรือปลอมแล้วสรุปให้',
    'home.welfareTitle': 'ค้นหาศูนย์สวัสดิการ·ศูนย์ผู้สูงอายุใกล้เคียง',
    'home.welfareDesc': 'แจ้งตำแหน่งศูนย์สวัสดิการ·ศูนย์ผู้สูงอายุใกล้ที่อยู่ของคุณ',
    'home.todayTasks': 'สิ่งที่ต้องทำวันนี้',
    'home.viewAll': 'ดูทั้งหมด',
    'home.noTasksToday': 'วันนี้ไม่มีสิ่งที่ต้องทำ',
    'home.publicInfoDefault': 'ข้อมูลที่ควรรู้',
    'home.disclaimer': 'บริการนี้เป็นผลวิเคราะห์จาก AI เพื่อการอ้างอิงเท่านั้น<br>เอกสารสำคัญกรุณาปรึกษาผู้เชี่ยวชาญ',
    'nav.home': 'หน้าแรก', 'nav.info': 'ข้อมูล', 'nav.history': 'ประวัติ', 'nav.settings': 'ตั้งค่า',
    'info.sectionTitle': 'ข้อมูลที่ควรรู้',
    'info.empty': 'ไม่สามารถโหลดข้อมูลที่จะแสดงได้<br>กรอกพื้นที่ที่คุณอาศัยอยู่ในตั้งค่า เพื่อดูข้อมูลเพิ่มเติม',
    'settings.title': 'ตั้งค่า',
    'settings.fontSize': 'ขนาดตัวอักษรหน้าจอ',
    'settings.fontNormal': 'ปกติ', 'settings.fontLarge': 'ใหญ่', 'settings.fontXLarge': 'ใหญ่มาก',
    'settings.voiceSpeed': 'ความเร็วในการอ่านออกเสียง',
    'settings.rate1': 'ความเร็ว 1 เท่า', 'settings.rate15': 'ความเร็ว 1.5 เท่า', 'settings.rate2': 'ความเร็ว 2 เท่า',
    'settings.replay': 'ฟังอีกครั้ง', 'settings.stop': 'หยุด',
    'settings.voiceEnable': 'ใช้คำแนะนำด้วยเสียง',
    'settings.myInfo': 'ข้อมูลของฉัน (สำหรับคำแนะนำเฉพาะบุคคล ไม่บังคับ)',
    'settings.nameLabel': 'ชื่อ', 'settings.namePlaceholder': 'เช่น ฮงกิลดง',
    'settings.male': 'ชาย', 'settings.female': 'หญิง',
    'settings.age60': '60 ปีขึ้นไป', 'settings.age70': '70 ปีขึ้นไป', 'settings.age80': '80 ปีขึ้นไป',
    'settings.regionLabel': 'ที่อยู่อาศัย', 'settings.regionPlaceholder': 'เช่น ซังนก-กู อันซาน-ซี คย็องกีโด',
    'settings.myInfoNote': 'ข้อมูลนี้จะถูกใช้อ้างอิงเมื่อวิเคราะห์เอกสาร/ข้อความเพื่ออธิบายให้เหมาะสมยิ่งขึ้น ไม่แชร์ให้ที่อื่น',
    'settings.guardian': 'ข้อมูลผู้ปกครอง/ผู้ดูแล',
    'settings.guardianNameLabel': 'ชื่อผู้ดูแล', 'settings.guardianNamePlaceholder': 'เช่น คิมมินซู (ลูกชาย)',
    'settings.guardianPhoneLabel': 'เบอร์โทรผู้ดูแล', 'settings.guardianPhonePlaceholder': 'เช่น 010-1234-5678',
    'settings.autoNotify': '🔴 ส่งการแจ้งเตือนอัตโนมัติเมื่อพบข้อความอันตราย',
    'settings.guardianNote': 'การตั้งค่าทั้งหมดจะถูกบันทึกอัตโนมัติในเครื่องนี้ และคงอยู่แม้รีเฟรชแอป',
    'settings.language': 'ตั้งค่าภาษา',
    'settings.languageNote': 'รองรับ 4 ภาษาของผู้พำนักต่างชาติที่มีสัดส่วนสูงในคย็องกี (จีน·เวียดนาม·ไทย·อุซเบก ตามสถิติสาธารณะ) แปลเฉพาะข้อความหลักบนหน้าจอ ส่วนผลวิเคราะห์ AI จะเป็นภาษาเกาหลีเสมอเพื่อความถูกต้อง',
    'settings.support': 'ฝ่ายบริการลูกค้า',
    'settings.supportHelp': 'คำแนะนำการใช้งาน',
    'settings.supportOnboarding': 'ดูคำแนะนำหน้าจออีกครั้ง (คำแนะนำการใช้งานครั้งแรก)',
    'settings.supportCenter': 'ติดต่อศูนย์บริการลูกค้า',
    'onboard.replay': 'ฟังอีกครั้ง', 'onboard.skip': 'ข้าม',
    'onboard.greet.title': 'สวัสดีค่ะ.<br>ฉันคือผู้ช่วยดิจิทัล AI',
    'onboard.greet.desc': 'ช่วยให้คุณเข้าใจเอกสารได้ง่าย<br>และแจ้งสิ่งที่ต้องทำให้ทราบ',
    'onboard.greet.start': 'เริ่มต้น',
    'onboard.greet.voice': 'สวัสดีค่ะ ฉันคือผู้ช่วยดิจิทัล AI จะแนะนำวิธีใช้งานง่ายๆ ผ่านหน้าจอจริง',
    'onboard.profile.title': 'ขอข้อมูล<br>สักเล็กน้อยได้ไหมคะ?',
    'onboard.profile.desc': 'ข้อมูลที่กรอกจะถูกเก็บไว้ในเครื่องนี้และเซิร์ฟเวอร์ที่ปลอดภัยเท่านั้น<br>ใช้เพื่อให้คำอธิบายที่เหมาะสมยิ่งขึ้นเท่านั้น<br>หากไม่ต้องการก็สามารถข้ามได้',
    'onboard.profile.genderLabel': 'เพศ', 'onboard.profile.ageLabel': 'ช่วงอายุ',
    'onboard.profile.age50': '50 ปีหรือต่ำกว่า', 'onboard.profile.age60': '60–69 ปี', 'onboard.profile.age70': '70–79 ปี', 'onboard.profile.age80': '80 ปีขึ้นไป',
    'skipConfirm.title': 'ข้ามบทแนะนำหรือไม่?', 'skipConfirm.keep': 'ดูต่อ',
    'onboard.profile.useLocation': 'กรอกตำแหน่งปัจจุบันของฉัน',
    'onboard.profile.regionNote': 'หากระบุถึงระดับอำเภอ/เขต จะช่วยให้เราให้ข้อมูลที่เหมาะสมยิ่งขึ้น',
    'onboard.profile.next': 'ถัดไป',
    'onboard.profile.voice': 'บอกชื่อ เพศ ช่วงอายุ และที่อยู่อาศัยให้ฉันทราบ เพื่อช่วยเหลือคุณได้เหมาะสมยิ่งขึ้น หากไม่ต้องการก็สามารถข้ามได้',
    'onboard.notice.title': 'ตอนนี้ยังไม่สามารถวิเคราะห์ได้',
    'onboard.notice.desc': 'ตอนนี้เป็นเวอร์ชันทดลอง (บทเรียน)<br>อาจไม่มีการวิเคราะห์จริงให้<br>หากมีข้อสงสัยกรุณาติดต่อผู้ดูแลระบบ',
    'onboard.notice.next': 'ดำเนินการต่อ',
    'onboard.notice.voice': 'ตอนนี้ยังไม่สามารถวิเคราะห์ได้ เนื่องจากเป็นเวอร์ชันทดลอง อาจไม่มีการวิเคราะห์จริงให้ หากมีข้อสงสัยกรุณาติดต่อผู้ดูแลระบบ',
    'coach.cat.doc': 'เอกสาร', 'coach.cat.sms': 'ข้อความ', 'coach.cat.history': 'ประวัติ', 'coach.cat.info': 'ข้อมูล',
    'coach.cat.welfare': 'สวัสดิการ', 'coach.cat.voice': 'เสียง', 'coach.cat.emergency': 'ฉุกเฉิน', 'coach.cat.settings': 'ตั้งค่า',
    'coach.cat.help': 'คำแนะนำ',
    'coach.moreHelp.title': 'ดูฟังก์ชันอื่นได้ที่นี่', 'coach.moreHelp.desc': 'กดที่ข้อมูล ประวัติ ตั้งค่า ด้านล่างได้เลย', 'coach.moreHelp.voice': 'ดูฟังก์ชันอื่นได้จากเมนูด้านล่าง',
    'coach.next': 'ไปขั้นตอนถัดไป', 'coach.skipTutorial': 'ข้ามบทเรียน',
    'coach.doc1.title': 'ลองถ่ายภาพเอกสารดูสิ', 'coach.doc1.desc': 'กดการ์ดนี้เพื่อถ่ายภาพเอกสารและให้ AI วิเคราะห์', 'coach.doc1.voice': 'กรุณากดการ์ดถ่ายภาพเอกสาร',
    'coach.doc2.title': 'ลองถ่ายภาพเองดูนะ', 'coach.doc2.desc': 'ถ่ายภาพเอกสารด้วยกล้อง', 'coach.doc2.voice': 'กรุณากดถ่ายภาพเอง',
    'coach.doc3.title': 'กรุณากดปุ่มถ่ายภาพ', 'coach.doc3.desc': 'จัดเอกสารให้อยู่กลางจอแล้วกดปุ่ม', 'coach.doc3.voice': 'กรุณากดปุ่มถ่ายภาพ',
    'coach.sms1.title': 'ตรวจสอบข้อความได้เช่นกัน', 'coach.sms1.desc': 'สามารถตรวจสอบได้ว่าข้อความที่ได้รับปลอดภัยหรือไม่', 'coach.sms1.voice': 'กรุณากดการ์ดสรุปข้อความ',
    'coach.sms2.title': 'กรุณากดแอปข้อความ', 'coach.sms2.desc': 'เราจะเปิดแอปข้อความกัน', 'coach.sms2.voice': 'กรุณากดแอปข้อความ',
    'coach.sms3.title': 'ลองกดค้างที่ข้อความเพื่อคัดลอกดู', 'coach.sms3.desc': 'ในการใช้งานจริง กดค้างที่ข้อความที่ต้องการตรวจสอบเพื่อคัดลอก', 'coach.sms3.voice': 'กรุณากดค้างที่ข้อความเพื่อคัดลอก',
    'coach.sms4.title': 'กรุณากลับมาที่แอปนี้อีกครั้ง', 'coach.sms4.desc': 'เมื่อคัดลอกแล้ว กดปุ่มนี้เพื่อกลับมาที่แอป', 'coach.sms4.voice': 'กรุณากดปุ่มเปิดแอป',
    'coach.sms5.title': 'ลองกดค้างเพื่อวางดู', 'coach.sms5.desc': 'กดค้างที่ช่องนี้แล้วเลือกวาง แตะหน้าจอสองครั้งเร็วๆ จะวางได้ง่ายขึ้น', 'coach.sms5.voice': 'กรุณากดที่ช่องวาง แตะสองครั้งเร็วๆ จะวางได้ง่ายขึ้น',
    'coach.sms6.title': 'กรุณากดยืนยัน', 'coach.sms6.desc': 'เมื่อวางเสร็จแล้ว กรุณากดยืนยัน', 'coach.sms6.voice': 'กรุณากดปุ่มยืนยัน',
    'coach.sms7.title': 'กดยืนยันเพื่อดูผลลัพธ์', 'coach.sms7.desc': 'กดปุ่มนี้เพื่อให้ AI ตรวจสอบข้อความให้คุณ', 'coach.sms7.voice': 'กรุณากดปุ่มยืนยันเพื่อดูผลลัพธ์',
    'coach.history1.title': 'ดูประวัติล่าสุดได้เช่นกัน', 'coach.history1.desc': 'สามารถดูเอกสารและข้อความที่ตรวจสอบมาแล้วทั้งหมด', 'coach.history1.voice': 'กรุณากดปุ่มประวัติล่าสุด',
    'coach.history2.title': 'กลับไปหน้าหลักกันเถอะ', 'coach.history2.desc': 'กดปุ่ม ← กลับหน้าหลักเพื่อย้อนกลับได้ทุกเมื่อ', 'coach.history2.voice': 'กรุณากดปุ่มกลับหน้าหลัก',
    'coach.info1.title': 'มีข้อมูลที่ควรรู้ด้วย', 'coach.info1.desc': 'แนะนำข้อมูลที่เป็นประโยชน์ เช่น เงินบำนาญพื้นฐาน การตรวจสุขภาพ', 'coach.info1.voice': 'กรุณากดข้อมูลที่ควรรู้',
    'coach.info2.title': 'ดูเสร็จแล้วกลับหน้าหลักนะ', 'coach.info2.desc': 'กรุณากดปุ่มกลับหน้าหลัก', 'coach.info2.voice': 'กรุณากดปุ่มกลับหน้าหลัก',
    'coach.welfare1.title': 'หาศูนย์สวัสดิการ·ศูนย์ผู้สูงอายุใกล้เคียงให้ด้วย', 'coach.welfare1.desc': 'แจ้งตำแหน่งศูนย์สวัสดิการและศูนย์ผู้สูงอายุใกล้ตำแหน่งของคุณ', 'coach.welfare1.voice': 'กรุณากดค้นหาศูนย์สวัสดิการ·ศูนย์ผู้สูงอายุใกล้เคียง',
    'coach.welfare2.title': 'กลับไปหน้าหลักกันเถอะ', 'coach.welfare2.desc': 'กรุณากดปุ่มกลับหน้าหลัก', 'coach.welfare2.voice': 'กรุณากดปุ่มกลับหน้าหลัก',
    'coach.voice1.title': 'รับคำแนะนำด้วยเสียงได้เช่นกัน', 'coach.voice1.desc': 'กดปุ่มนี้เพื่อฟังคำแนะนำหน้าจออีกครั้ง', 'coach.voice1.voice': 'กรุณากดปุ่มรับคำแนะนำด้วยเสียง',
    'coach.emergency1.title': 'ฉุกเฉินให้กดปุ่มนี้', 'coach.emergency1.desc': 'สามารถติดต่อผู้ดูแลหรือ 119·112·118 ได้ทันที ลองกดตรวจสอบดู เสร็จแล้วกดถัดไป', 'coach.emergency1.voice': 'กรุณากดปุ่มขอความช่วยเหลือ ตรวจสอบเสร็จแล้วกรุณากดถัดไป',
    'coach.settingsIntro.title': 'ดูการตั้งค่ากันด้วย', 'coach.settingsIntro.desc': 'สามารถเปลี่ยนขนาดตัวอักษร ความเร็วเสียง ข้อมูลผู้ดูแลได้', 'coach.settingsIntro.voice': 'กรุณากดปุ่มตั้งค่า',
    'coach.fontsize.title': 'ลองเปลี่ยนขนาดตัวอักษรดู', 'coach.fontsize.desc': 'เลือกระหว่างปกติ ใหญ่ ใหญ่มาก เลือกเสร็จแล้วกดถัดไป', 'coach.fontsize.voice': 'กรุณากดขนาดตัวอักษร เลือกเสร็จแล้วกรุณากดถัดไป',
    'coach.rate.title': 'เปลี่ยนความเร็วเสียงได้เช่นกัน', 'coach.rate.desc': 'เลือกความเร็วในการอ่านที่สบายสำหรับคุณ เลือกเสร็จแล้วกดถัดไป', 'coach.rate.voice': 'กรุณากดความเร็วในการอ่านออกเสียง เลือกเสร็จแล้วกรุณากดถัดไป',
    'coach.guardian.title': 'ลองลงทะเบียนข้อมูลผู้ดูแลดู', 'coach.guardian.desc': 'เมื่อพบข้อความอันตรายสามารถแจ้งผู้ดูแลได้ทันที เป็นตัวเลือก หากไม่ต้องการกดถัดไปได้เลย', 'coach.guardian.voice': 'กรุณากรอกชื่อผู้ดูแล หากไม่ต้องการกรุณากดถัดไปเพื่อข้าม',
    'coach.helplink.title': 'มีคำแนะนำการใช้งานด้วย', 'coach.helplink.desc': 'เมื่อสับสนสามารถดูอีกครั้งได้ทุกเมื่อ', 'coach.helplink.voice': 'กรุณากดคำแนะนำการใช้งาน',
    'coach.helpback.title': 'ย้อนกลับเพื่อจบกันนะ', 'coach.helpback.desc': 'กรุณากดปุ่ม ← ย้อนกลับ', 'coach.helpback.voice': 'กรุณากดปุ่มย้อนกลับ',
    'coach.finish.title': 'ตอนนี้กลับหน้าหลักก็จบแล้ว', 'coach.finish.desc': 'กรุณากดปุ่ม ← กลับหน้าหลักเพื่อจบคำแนะนำ', 'coach.finish.voice': 'กรุณากดปุ่มกลับหน้าหลักเพื่อจบคำแนะนำ',
    'coach.language.title': 'เปลี่ยนภาษาได้เช่นกัน', 'coach.language.desc': 'เลือกระหว่างจีน·เวียดนาม·ไทย·อุซเบก เลือกเสร็จแล้วกดถัดไป', 'coach.language.voice': 'กรุณากดตั้งค่าภาษา เลือกเสร็จแล้วกรุณากดถัดไป'
  },
  uz: {
    'home.sectionTitle': 'Sizga qanday yordam kerak?',
    'home.docTitle': 'Hujjatni suratga olish',
    'home.docDesc': 'Hujjatni suratga olsangiz, mazmunini xulosalab beramiz',
    'home.smsTitle': 'SMS xulosasi',
    'home.smsDesc': "SMS xabarining haqiqiyligini tekshirib, xulosa beramiz",
    'home.welfareTitle': "Yaqin atrofdagi ijtimoiy ta'minot markazlari va keksalar markazini toping",
    'home.welfareDesc': "Joylashuvingiz yaqinidagi ijtimoiy ta'minot markazlari va keksalar markazini ko'rsatamiz",
    'home.todayTasks': 'Bugungi vazifalar',
    'home.viewAll': "Barchasini ko'rish",
    'home.noTasksToday': "Bugun bajarilishi kerak bo'lgan vazifa yo'q.",
    'home.publicInfoDefault': "Bilish foydali ma'lumotlar",
    'home.disclaimer': "Bu xizmat AI tahlili natijasi bo'lib, faqat ma'lumot uchundir.<br>Muhim hujjatlar uchun mutaxassisga murojaat qiling.",
    'nav.home': 'Bosh sahifa', 'nav.info': "Ma'lumot", 'nav.history': 'Tarix', 'nav.settings': 'Sozlamalar',
    'info.sectionTitle': "Bilish foydali ma'lumotlar",
    'info.empty': "Ko'rsatiladigan ma'lumotni yuklab bo'lmadi.<br>Sozlamalarda yashash hududingizni kiritsangiz, ko'proq ma'lumot ko'rasiz.",
    'settings.title': 'Sozlamalar',
    'settings.fontSize': "Ekran shrift o'lchami",
    'settings.fontNormal': "Oddiy", 'settings.fontLarge': 'Katta', 'settings.fontXLarge': "Juda katta",
    'settings.voiceSpeed': "Ovozli o'qish tezligi",
    'settings.rate1': '1x tezlik', 'settings.rate15': '1.5x tezlik', 'settings.rate2': '2x tezlik',
    'settings.replay': "Qayta o'qish", 'settings.stop': "To'xtatish",
    'settings.voiceEnable': "Ovozli qo'llanmadan foydalanish",
    'settings.myInfo': "Mening ma'lumotlarim (moslashtirilgan tavsiya uchun, ixtiyoriy)",
    'settings.nameLabel': 'Ism', 'settings.namePlaceholder': 'Masalan: Hong Gil Dong',
    'settings.male': 'Erkak', 'settings.female': 'Ayol',
    'settings.age60': '60 yosh', 'settings.age70': '70 yosh', 'settings.age80': '80 yosh va undan katta',
    'settings.regionLabel': 'Yashash hududi', 'settings.regionPlaceholder': 'Masalan: Sangnok-gu, Ansan-si, Gyeonggi-do',
    'settings.myInfoNote': "Bu ma'lumot hujjat/SMS tahlil qilinganda ko'rib chiqiladi va moslashtirilgan tushuntirish uchun ishlatiladi. Boshqa joyga ulashilmaydi.",
    'settings.guardian': "Vasiy ma'lumotlari",
    'settings.guardianNameLabel': 'Vasiy ismi', 'settings.guardianNamePlaceholder': 'Masalan: Kim Min Su (o’g’li)',
    'settings.guardianPhoneLabel': 'Vasiy telefon raqami', 'settings.guardianPhonePlaceholder': 'Masalan: 010-1234-5678',
    'settings.autoNotify': "🔴 Xavfli SMS aniqlanganda avtomatik bildirishnoma yuborish",
    'settings.guardianNote': "Barcha sozlamalar bu qurilmada avtomatik saqlanadi va ilova qayta yuklansa ham saqlanib qoladi.",
    'settings.language': 'Til sozlamalari',
    'settings.languageNote': "Gyeonggi-da yashovchi chet elliklar orasida ko'p uchraydigan 4 tilni qo'llab-quvvatlaydi (xitoy·vetnam·tay·o'zbek, davlat statistikasiga ko'ra). Faqat asosiy ekran matnlari tarjima qilinadi, AI tahlil natijalari aniqlik uchun har doim koreys tilida beriladi.",
    'settings.support': "Mijozlarni qo'llab-quvvatlash",
    'settings.supportHelp': "Foydalanish bo'yicha qo'llanma",
    'settings.supportOnboarding': "Ekran qo'llanmasini qayta ko'rish (birinchi marta ishlatish qo'llanmasi)",
    'settings.supportCenter': "Mijozlarga xizmat ko'rsatish markazi bilan bog'lanish",
    'onboard.replay': 'Qayta eshitish', 'onboard.skip': "O'tkazib yuborish",
    'onboard.greet.title': 'Salom.<br>Men AI raqamli yordamchiman.',
    'onboard.greet.desc': 'Hujjatlarni oson tushunishga<br>va nima qilish kerakligini aytishga yordam beraman.',
    'onboard.greet.start': 'Boshlash',
    'onboard.greet.voice': 'Salom. Men AI raqamli yordamchiman. Haqiqiy ekranlar orqali foydalanish usulini qisqacha tushuntiraman.',
    'onboard.profile.title': "Bir nechta<br>ma'lumot bera olasizmi?",
    'onboard.profile.desc': "Kiritgan ma'lumotingiz faqat shu qurilma va xavfsiz serverda saqlanadi,<br>faqat sizga mos tushuntirish berish uchun ishlatiladi.<br>Xohlamasangiz o'tkazib yuborishingiz mumkin.",
    'onboard.profile.genderLabel': 'Jinsi', 'onboard.profile.ageLabel': 'Yosh guruhi',
    'onboard.profile.age50': '50 va undan kichik', 'onboard.profile.age60': '60–69', 'onboard.profile.age70': '70–79', 'onboard.profile.age80': '80 va undan katta',
    'skipConfirm.title': 'Qoʻllanma oʻtkazib yuborilsinmi?', 'skipConfirm.keep': 'Davom etish',
    'onboard.profile.useLocation': 'Joriy joylashuvimni kiritish',
    'onboard.profile.regionNote': "Tuman/shahargacha aniq yozsangiz, sizga mosroq ma'lumot bera olamiz.",
    'onboard.profile.next': 'Keyingi',
    'onboard.profile.voice': "Ism, jins, yosh guruhi va yashash hududingizni ayting, sizga mosroq yordam bera olaman. Xohlamasangiz o'tkazib yuborishingiz mumkin.",
    'onboard.notice.title': 'Hozircha tahlil qilish qiyin.',
    'onboard.notice.desc': "Hozir sinov versiyasi (qo'llanma) bo'lgani uchun,<br>haqiqiy tahlil taqdim etilmasligi mumkin.<br>Savollaringiz bo'lsa administratorga murojaat qiling.",
    'onboard.notice.next': 'Davom etish',
    'onboard.notice.voice': "Hozircha tahlil qilish qiyin. Sinov versiyasi bo'lgani uchun haqiqiy tahlil taqdim etilmasligi mumkin. Savollaringiz bo'lsa administratorga murojaat qiling.",
    'coach.cat.doc': 'Hujjat', 'coach.cat.sms': 'SMS', 'coach.cat.history': 'Tarix', 'coach.cat.info': "Ma'lumot",
    'coach.cat.welfare': "Ijtimoiy ta'minot", 'coach.cat.voice': 'Ovoz', 'coach.cat.emergency': 'Favqulodda', 'coach.cat.settings': 'Sozlamalar',
    'coach.cat.help': "Qo'llanma",
    'coach.moreHelp.title': "Bu yerda boshqa funksiyalarni ham ko'rasiz", 'coach.moreHelp.desc': "Pastdagi Ma'lumot, Tarix, Sozlamalar tugmalarini bosing.", 'coach.moreHelp.voice': "Pastdagi menyudan boshqa funksiyalarni ham ko'rishingiz mumkin.",
    'coach.next': "Keyingi bosqichga o'tish", 'coach.skipTutorial': "Qo'llanmani o'tkazib yuborish",
    'coach.doc1.title': 'Hujjatni suratga olib ko\'ring', 'coach.doc1.desc': 'Ushbu kartani bosib hujjatni suratga olib AI tahliliga topshirishingiz mumkin.', 'coach.doc1.voice': 'Hujjat suratga olish kartasini bosing.',
    'coach.doc2.title': 'Bevosita suratga olamiz', 'coach.doc2.desc': 'Kamera bilan hujjatni suratga oling.', 'coach.doc2.voice': 'Bevosita suratga olishni bosing.',
    'coach.doc3.title': 'Suratga olish tugmasini bosing', 'coach.doc3.desc': "Hujjatni ekran markaziga to'g'rilab tugmani bosing.", 'coach.doc3.voice': 'Suratga olish tugmasini bosing.',
    'coach.sms1.title': 'SMS xabarni ham tekshirish mumkin', 'coach.sms1.desc': 'Kelgan SMS xavfsizligini ham tekshirish mumkin.', 'coach.sms1.voice': 'SMS xulosasi kartasini bosing.',
    'coach.sms2.title': 'SMS ilovasini bosing', 'coach.sms2.desc': 'SMS ilovasini ochamiz.', 'coach.sms2.voice': 'SMS ilovasini bosing.',
    'coach.sms3.title': 'SMS xabarni bosib turib nusxalab ko\'ring', 'coach.sms3.desc': "Haqiqatda tekshirmoqchi bo'lgan SMS ni bosib turib nusxalash mumkin.", 'coach.sms3.voice': 'SMS ni bosib turib nusxalang.',
    'coach.sms4.title': 'Yana shu ilovaga qaytib keling', 'coach.sms4.desc': "Nusxalagandan so'ng, shu tugmani bosib ilovaga qayting.", 'coach.sms4.voice': 'Ilovani ochish tugmasini bosing.',
    'coach.sms5.title': 'Bosib turib joylashtirib ko\'ring', 'coach.sms5.desc': 'Shu joyni bosib turib joylashtirishni tanlang. Ekranni tez ikki marta bosish osonroq joylashtiradi.', 'coach.sms5.voice': 'Joylashtirish maydonini bosing. Tez ikki marta bosish osonroq joylashtiradi.',
    'coach.sms6.title': 'Tasdiqlashni bosing', 'coach.sms6.desc': 'Joylashtirish tugagach tasdiqlashni bosing.', 'coach.sms6.voice': 'Tasdiqlash tugmasini bosing.',
    'coach.sms7.title': 'Natijani ko\'rish uchun tasdiqlashni bosing', 'coach.sms7.desc': 'Shu tugmani bosganingizda AI SMS ni tekshirib beradi.', 'coach.sms7.voice': 'Natijani ko\'rish uchun tasdiqlash tugmasini bosing.',
    'coach.history1.title': 'So\'nggi tarixni ham ko\'rish mumkin', 'coach.history1.desc': 'Hozirgacha tekshirilgan hujjat va SMS tarixini birgalikda ko\'rish mumkin.', 'coach.history1.voice': 'So\'nggi tarix tugmasini bosing.',
    'coach.history2.title': 'Yana bosh sahifaga qaytamiz', 'coach.history2.desc': "← Bosh sahifaga tugmasini bosib istalgan vaqtda qaytish mumkin.", 'coach.history2.voice': 'Bosh sahifaga qaytish tugmasini bosing.',
    'coach.info1.title': "Bilish foydali ma'lumotlar ham bor", 'coach.info1.desc': "Asosiy pensiya, sog'liqni tekshirish kabi foydali ma'lumotlarni taqdim etamiz.", 'coach.info1.voice': "Bilish foydali ma'lumotlarni bosing.",
    'coach.info2.title': 'Ko\'rib bo\'lgach bosh sahifaga qayting', 'coach.info2.desc': 'Bosh sahifaga qaytish tugmasini bosing.', 'coach.info2.voice': 'Bosh sahifaga qaytish tugmasini bosing.',
    'coach.welfare1.title': "Yaqin atrofdagi ijtimoiy ta'minot markazlari va keksalar markazini ham topib beramiz", 'coach.welfare1.desc': "Joylashuvingiz yaqinidagi ijtimoiy ta'minot markazi va keksalar markazi joylashuvini ko'rsatamiz.", 'coach.welfare1.voice': "Yaqin atrofdagi ijtimoiy ta'minot·keksalar markazini qidirishni bosing.",
    'coach.welfare2.title': 'Yana bosh sahifaga qaytamiz', 'coach.welfare2.desc': 'Bosh sahifaga qaytish tugmasini bosing.', 'coach.welfare2.voice': 'Bosh sahifaga qaytish tugmasini bosing.',
    'coach.voice1.title': 'Ovoz orqali ham yo\'riqnoma olish mumkin', 'coach.voice1.desc': 'Shu tugmani bosib ekran yo\'riqnomasini yana eshitishingiz mumkin.', 'coach.voice1.voice': 'Ovoz orqali yo\'riqnoma olish tugmasini bosing.',
    'coach.emergency1.title': 'Favqulodda vaziyatda shu tugmani bosing', 'coach.emergency1.desc': "Vasiy yoki 119·112·118 ga to'g'ridan-to'g'ri bog'lanish mumkin. Bosib ko'ring, ko'rib bo'lgach keyingiga o'ting.", 'coach.emergency1.voice': 'Yordam tugmasini bosing. Tekshirib bo\'lgach keyingi tugmasini bosing.',
    'coach.settingsIntro.title': 'Sozlamalarni ham ko\'ramiz', 'coach.settingsIntro.desc': "Shrift o'lchami, ovoz tezligi, vasiy ma'lumotlarini o'zgartirish mumkin.", 'coach.settingsIntro.voice': 'Sozlamalar tugmasini bosing.',
    'coach.fontsize.title': "Shrift o'lchamini o'zgartirib ko'ring", 'coach.fontsize.desc': "Oddiy, katta, juda katta orasidan tanlang. Tanlab bo'lgach keyingiga o'ting.", 'coach.fontsize.voice': "Shrift o'lchamini bosing. Tanlab bo'lgach keyingi tugmasini bosing.",
    'coach.rate.title': "Ovoz tezligini ham o'zgartirish mumkin", 'coach.rate.desc': "O'zingizga qulay o'qish tezligini tanlang. Tanlab bo'lgach keyingiga o'ting.", 'coach.rate.voice': "Ovoz o'qish tezligini bosing. Tanlab bo'lgach keyingi tugmasini bosing.",
    'coach.guardian.title': "Vasiy ma'lumotlarini ro'yxatdan o'tkazib ko'ring", 'coach.guardian.desc': "Xavfli SMS aniqlansa vasiyga darhol xabar berish mumkin. Bu ixtiyoriy, xohlamasangiz keyingiga o'ting.", 'coach.guardian.voice': "Vasiy ismini kiriting. Xohlamasangiz keyingi tugmasini bosib o'tkazib yuboring.",
    'coach.helplink.title': 'Foydalanish yo\'riqnomasi ham bor', 'coach.helplink.desc': 'Chalkashib qolganda istalgan vaqtda qayta ko\'rish mumkin.', 'coach.helplink.voice': 'Foydalanish yo\'riqnomasini bosing.',
    'coach.helpback.title': 'Ortga qaytib yakunlaymiz', 'coach.helpback.desc': '← Ortga tugmasini bosing.', 'coach.helpback.voice': 'Ortga tugmasini bosing.',
    'coach.finish.title': 'Endi bosh sahifaga qaytsangiz tugaydi', 'coach.finish.desc': "Yo'riqnomani yakunlash uchun ← Bosh sahifaga tugmasini bosing.", 'coach.finish.voice': "Yo'riqnomani yakunlash uchun bosh sahifaga tugmasini bosing.",
    'coach.language.title': 'Tilni ham o\'zgartirish mumkin', 'coach.language.desc': "Xitoy·Vetnam·Tay·O'zbek orasidan tanlang. Tanlab bo'lgach keyingiga o'ting.", 'coach.language.voice': "Til sozlamasini bosing. Tanlab bo'lgach keyingi tugmasini bosing."
  }
};

/** 현재 언어 설정에 맞는 번역 문구를 돌려준다(동적으로 생성되는 화면 문구용). 번역이 없으면 한국어 원문으로 대체 */
function t(key){
  const lang = I18N[appState.settings.language] ? appState.settings.language : 'ko';
  return (I18N[lang] && I18N[lang][key]) || I18N.ko[key] || '';
}

function applyLanguage(){
  const lang = I18N[appState.settings.language] ? appState.settings.language : 'ko';
  const dict = I18N[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const text = (dict && dict[el.dataset.i18n]) || I18N.ko[el.dataset.i18n];
    if (text) el.innerHTML = text;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const text = (dict && dict[el.dataset.i18nPlaceholder]) || I18N.ko[el.dataset.i18nPlaceholder];
    if (text) el.placeholder = text;
  });
  syncToggleGroupString('languageGroup', lang);
}

function setLanguage(lang){
  appState.settings.language = lang;
  saveState();
  applyLanguage();
}

function syncSettingsUI(){
  syncToggleGroup('fontScaleGroup', 'scale', appState.settings.fontScale);
  syncToggleGroup('voiceRateGroup', 'rate', appState.settings.voiceRate);
  document.getElementById('guardianName').value = appState.guardian.name;
  document.getElementById('guardianPhone').value = appState.guardian.phone;
  document.getElementById('autoNotifyToggle').checked = appState.guardian.autoNotify;
  document.getElementById('voiceEnabledToggle').checked = appState.settings.voiceEnabled;
  syncProfileUI();
  applyLanguage();
}

/* ---- 내 정보(성별/연령대/지역, 선택 사항): 첫 화면 안내와 설정 화면 두 곳에 같은 값을 반영 ---- */
function syncToggleGroupString(groupId, currentValue){
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.value || '') === (currentValue || ''));
  });
}

function setProfileField(field, value){
  appState.profile[field] = value;
  saveState();
  syncProfileUI();
  renderPublicInfoCard();
  if (field === 'region') queueRegionInfoRefresh();
  queueProfileSave();
}

/** 저장된 나이를 연령대 버튼 값(50/60/70/80) 중 하나로 맞춘다.
 *  예전 버전에서 한 살 단위로 저장된 값(예: 73)이나 서버에서 받은 값도 해당 연령대로 흡수한다. */
function toAgeBand(age){
  const n = Number(age);
  if (!n) return 50;
  return Math.min(80, Math.max(50, Math.floor(n / 10) * 10));
}

let regionInfoTimer = null;
function queueRegionInfoRefresh(){
  clearTimeout(regionInfoTimer);
  regionInfoTimer = setTimeout(renderRegionInfoCard, 800);
}

/* ---- 프로필 서버 저장 (Cloudflare D1, 로그인 없이 기기별 deviceId로 구분) ---- */
const DEVICE_ID_KEY = 'ai_helper_device_id';
function getDeviceId(){
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'device-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

let profileSaveTimer = null;
function queueProfileSave(){
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(saveProfileToServer, 800);
}

async function saveProfileToServer(){
  if (!AI_WORKER_URL) return;
  try {
    await fetch(AI_WORKER_URL + '/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId(), ...appState.profile })
    });
  } catch (err) {
    console.warn('프로필 서버 저장 실패:', err);
  }
}

/** 기기를 바꿔도 같은 deviceId면 서버에 저장된 프로필을 불러온다(이 기기에 이미 있는 값이 없을 때만 덮어씀) */
async function loadProfileFromServer(){
  if (!AI_WORKER_URL) return;
  try {
    const res = await fetch(AI_WORKER_URL + '/profile?deviceId=' + encodeURIComponent(getDeviceId()));
    if (!res.ok) return;
    const data = await res.json();
    const hasLocal = appState.profile.name || appState.profile.gender || appState.profile.region;
    if (!hasLocal && data && (data.name || data.gender || data.age || data.region)) {
      appState.profile = Object.assign(appState.profile, data);
      saveState();
      syncProfileUI();
      renderPublicInfoCard();
    }
  } catch (err) {
    console.warn('프로필 서버 불러오기 실패:', err);
  }
}

/** 값이 다를 때만 반영해 입력 중인 커서 위치가 튀지 않게 한다 */
function setValueIfChanged(el, value){
  if (el && el.value !== value) el.value = value;
}

function syncProfileUI(){
  syncToggleGroupString('profileGenderGroup', appState.profile.gender);
  syncToggleGroupString('profileGenderGroupSettings', appState.profile.gender);
  const ageBand = String(toAgeBand(appState.profile.age));
  syncToggleGroupString('profileAgeGroup', ageBand);
  syncToggleGroupString('profileAgeGroupSettings', ageBand);
  setValueIfChanged(document.getElementById('profileName'), appState.profile.name);
  setValueIfChanged(document.getElementById('profileNameSettings'), appState.profile.name);
  setValueIfChanged(document.getElementById('profileRegion'), appState.profile.region);
  setValueIfChanged(document.getElementById('profileRegionSettings'), appState.profile.region);
}

/** 홈 화면 "알아두면 좋은 정보" 카드: 전국 공통으로 실제 확인된 노인 복지·안전 정보만 안내(지역별 실제 데이터는 없어 인사말만 맞춤화).
 *  각 항목을 누르면 외부 사이트로 바로 나가는 대신, 앱 안의 설명 화면(screen-info-*)으로 이동한다. */
const PUBLIC_INFO_ITEMS = [
  { id: 'pension', title: '기초연금 신청 안내', desc: '만 65세 이상, 소득 기준을 충족하면 매달 받을 수 있어요' },
  { id: 'checkup', title: '무료 건강검진', desc: '만 40세 이상은 국민건강보험공단에서 정기 검진을 받을 수 있어요' },
  { id: 'voicephishing', title: '보이스피싱 예방', desc: '의심스러운 전화나 문자는 118로 바로 신고할 수 있어요' }
];

function renderPublicInfoCard(){
  const card = document.getElementById('publicInfoCard');
  if (!card) return;
  const list = document.getElementById('publicInfoList');
  const titleEl = document.getElementById('publicInfoTitle');

  const { name, gender, age } = appState.profile;
  const who = name ? `${name}님` : (age ? `${toAgeBand(age)}대${gender ? ' ' + gender : ''} 어르신` : '');
  const greeting = who ? `${who}을 위한 정보` : t('home.publicInfoDefault');
  titleEl.innerHTML = `<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-info"></use></svg>${escapeHtml(greeting)}`;

  list.innerHTML = PUBLIC_INFO_ITEMS.map(item => `
    <div class="row" onclick="goTo('screen-info-${item.id}')" role="button" tabindex="0">
      <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-info"></use></svg></div>
      <div class="text"><div class="t1">${escapeHtml(item.title)}</div><div class="t2">${escapeHtml(item.desc)}</div></div>
      <svg class="chev" viewBox="0 0 24 24"><use href="#ic-chevron"></use></svg>
    </div>
  `).join('');
  card.style.display = 'block';
}

function notifyGuardian(){
  const note = document.getElementById('guardianNoteText');
  if (!appState.guardian.name) {
    if (note) note.textContent = '먼저 설정에서 보호자 정보를 등록해주세요.';
    speak('먼저 설정에서 보호자 정보를 등록해주세요.');
    return;
  }
  if (note) note.textContent = `${appState.guardian.name}님에게 알림을 보냈습니다.`;
  speak(`${appState.guardian.name}님에게 알림을 보냈습니다.`);
  addHistory('🔔 보호자 알림 발송', '⚪ 완료');
}

function callGuardian(){
  if (!appState.guardian.phone) {
    speak('설정에서 보호자 전화번호를 먼저 등록해주세요.');
    goTo('screen-settings');
    return;
  }
  window.location.href = 'tel:' + appState.guardian.phone;
}

/* ---------------------------------------------------------
   13. 쉬운 설명 ↔ 원문 토글
   --------------------------------------------------------- */
function setView(scopeSelector, view, easyId, originalId){
  document.querySelectorAll(scopeSelector + ' .view-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  document.getElementById(easyId).style.display = view === 'easy' ? 'block' : 'none';
  document.getElementById(originalId).style.display = view === 'original' ? 'block' : 'none';
}
function setDocView(view){ setView('#screen-result-doc', view, 'docEasyView', 'docOriginalView'); }

/* ---------------------------------------------------------
   14. 공통 유틸: 토스트 + 버튼 리플
   --------------------------------------------------------- */
let toastTimer = null;
function showGlobalToast(message){
  const toast = document.getElementById('globalToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

/** history/schedule에는 AI가 만든 텍스트(headline, checklist 항목 등)가 그대로 들어오므로, innerHTML 템플릿에 넣기 전에 항상 이스케이프한다 */
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

/** 버튼 클릭 시 리플 효과 (이벤트 위임으로 한 번만 등록 - 성능 최적화) */
function attachRippleEffect(){
  const rippleSelector = '.primary-btn, .secondary-btn, .guardian-btn, .auto-action-btn, .share-btn, .dashboard-more-btn, .reminder-btn, .practice-again-box, .sheet-btn';
  document.addEventListener('click', (e) => {
    const btn = e.target.closest(rippleSelector);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height);
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 500);
  });
}

/* ---------------------------------------------------------
   초기화
   --------------------------------------------------------- */
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-replay]')) {
    replayCurrentVoice();
  }
});

window.addEventListener('load', () => {
  loadState();

  const docPreviewEl = document.getElementById('docPreviewContent');
  if (docPreviewEl) docPreviewDefaultHTML = docPreviewEl.innerHTML;

  // 온보딩을 이미 마친 기기라면 인사 화면을 건너뛰고 홈에서 시작한다.
  // goTo()를 쓰지 않는 이유: 앱을 열자마자 안내 음성이 재생되는 걸 막기 위함(기존 동작 유지).
  const first = document.getElementById(appState.onboardingDone ? 'screen-home' : 'screen-greet');
  if (first !== activeScreenEl) {
    activeScreenEl.classList.remove('active');
    first.classList.add('active');
    activeScreenEl = first;
    document.body.classList.toggle('in-onboarding', onboardScreens.has(first.id));
  }
  // 이 경로는 goTo()를 우회하므로 네비바 표시도 여기서 직접 맞춰준다(빠뜨리면 첫 화면에서 네비바가 안 보인다)
  document.body.classList.toggle('has-bottom-nav', TAB_SCREENS.has(first.id));
  syncBottomNav(first.id);
  first.scrollTop = 0; // goTo()와 동일하게 항상 맨 위에서 시작(브라우저의 스크롤 복원 방지)
  document.getElementById('liveRegion').textContent = screenVoiceText(first);

  document.documentElement.style.setProperty('--scale', appState.settings.fontScale);
  syncSettingsUI();

  document.querySelectorAll('.schedule-check').forEach(bindScheduleCheckbox);

  attachRippleEffect();
  renderHomeDashboard();
  loadProfileFromServer();
});
