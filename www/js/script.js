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
  settings: { fontScale: 1.15, voiceRate: 1, voiceEnabled: true, language: 'ko' }, // 접근성 설정 — 어르신 대상 서비스라 기본 글자 크기 자체를 키움
  guardian: { name: '', phone: '', autoNotify: false },
  profile: { name: '', gender: '', age: '', region: '' }, // 맞춤 안내용(선택 사항): AI 분석 요청에 참고 정보로만 함께 전달됨.
                    // age는 실제로 입력받기 전까지 빈 값으로 둔다 — 기본값을 숫자로 두면 온보딩 나이 입력칸에
                    // 사용자가 입력한 적 없는 값이 이미 채워진 것처럼 보이는 문제가 있었다.
  avatarPhoto: '', // 홈 화면에 보여줄 프로필 사진(선택 사항). profile과 분리해두는 이유: pushStateToServer()가
                    // profile을 포함한 나머지 필드는 그대로 서버(D1)로 보내는데, 사진은 순전히 이 기기에서만
                    // 쓰는 것이라 서버로 전송되면 안 된다.
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
      avatarPhoto: appState.avatarPhoto,
      onboardingDone: appState.onboardingDone
    }));
  } catch (err) {
    console.warn('저장 실패:', err);
  }
  queueStateSync();
}

let stateSyncTimer = null;
function queueStateSync(){
  if (!getAuth()) return;
  clearTimeout(stateSyncTimer);
  stateSyncTimer = setTimeout(pushStateToServer, 1500);
}

async function pushStateToServer(){
  const auth = getAuth();
  if (!auth || !AI_WORKER_URL) return;
  try {
    await fetch(AI_WORKER_URL + '/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        state: {
          history: appState.history,
          schedule: appState.schedule,
          settings: appState.settings,
          guardian: appState.guardian,
          profile: appState.profile,
          onboardingDone: appState.onboardingDone,
        },
      }),
    });
  } catch (err) {
    console.warn('서버 동기화 실패(다음 저장 때 재시도):', err);
  }
}

/** 로그인 직후 1회 호출: 서버에 저장된 값이 있으면 로컬 appState를 그 값으로 덮어쓴다(여러 기기 동기화가
 *  목적이므로 "마지막으로 로그인한 곳"의 서버 값이 항상 이긴다 — 기존 프로필 동기화의 "로컬 우선"과 다르다). */
async function pullStateFromServer(){
  const auth = getAuth();
  if (!auth || !AI_WORKER_URL) return true;
  try {
    const res = await fetch(AI_WORKER_URL + '/state', { headers: authHeaders() });
    if (res.status === 401) return false; // 토큰이 서버에서 무효화됨 — 호출부가 로그아웃 처리하도록 알림
    if (!res.ok) return true;
    const data = await res.json();
    if (data.state) {
      const s = data.state;
      if (s.history) appState.history = s.history;
      if (s.schedule) appState.schedule = s.schedule;
      if (s.settings) appState.settings = Object.assign(appState.settings, s.settings);
      if (s.guardian) appState.guardian = Object.assign(appState.guardian, s.guardian);
      if (s.profile) appState.profile = Object.assign(appState.profile, s.profile);
      if (s.onboardingDone) appState.onboardingDone = true;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({ avatarPhoto: appState.avatarPhoto }, s)));
    } else {
      // 서버에 아직 아무것도 없음(첫 가입 직후) — 지금 로컬 값을 최초 스냅샷으로 올린다
      await pushStateToServer();
    }
    return true;
  } catch (err) {
    console.warn('서버 상태 불러오기 실패(로컬 값 유지):', err);
    return true;
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
    if (saved.avatarPhoto) appState.avatarPhoto = saved.avatarPhoto;
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

/** 안드로이드 시스템 WebView는 Web Speech API(window.speechSynthesis)를 안정적으로 지원하지 않아
 *  APK에서 음성 안내가 무음이 되는 문제가 있었다 — 네이티브 TTS 플러그인이 있으면 그걸 쓰고,
 *  없으면(웹 브라우저) 기존 speechSynthesis로 폴백한다. */
function getTtsPlugin(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Tts) || null;
}

/** 음성 지원 on/off 스위치는 홈 화면과 설정 화면 두 곳에 있다(voice-enabled-toggle 클래스로 묶임).
 *  el을 넘기면 그 스위치가 지금 누른 것이고, 나머지 스위치도 같은 상태로 맞춘다. */
function toggleVoice(el){
  const checked = el ? el.checked : !appState.settings.voiceEnabled;
  appState.settings.voiceEnabled = checked;
  syncVoiceEnabledToggles();
  if (!checked) stopVoice();
  saveState();
}

function syncVoiceEnabledToggles(){
  document.querySelectorAll('.voice-enabled-toggle').forEach(el => { el.checked = appState.settings.voiceEnabled; });
  const sub = document.querySelector('.home-greet-sub');
  if (sub) sub.textContent = t(appState.settings.voiceEnabled ? 'home.assistantActive' : 'home.assistantInactive');
  const rateSection = document.getElementById('voiceRateSection');
  if (rateSection) rateSection.style.display = appState.settings.voiceEnabled ? '' : 'none';
}

/** 번역된 문구(온보딩/튜토리얼)를 읽어줄 때만 언어별 TTS lang을 쓰고, 그 외(AI 분석 결과 등 항상 한국어인 문구)는 기본값(한국어)을 유지한다 */
const TTS_LANG_MAP = { ko: 'ko-KR', zh: 'zh-CN', vi: 'vi-VN', th: 'th-TH', uz: 'uz-UZ' };
function currentTtsLang(){ return TTS_LANG_MAP[appState.settings.language] || 'ko-KR'; }

/** force=true면 "음성 안내 사용하기"가 꺼져 있어도 읽는다 - "다시 듣기" 버튼처럼 사용자가 직접 눌러 요청한 경우에만 쓴다.
 *  화면 진입 시 자동으로 읽어주는 것(force 없음)은 토글을 그대로 따른다. */
function speak(text, lang, force){
  const liveRegion = document.getElementById('liveRegion');
  if ((!force && !appState.settings.voiceEnabled) || !text) {
    if (text && liveRegion) liveRegion.textContent = text;
    return;
  }
  const ttsLang = lang || 'ko-KR';
  const Tts = getTtsPlugin();
  if (Tts) {
    Tts.speak({ text, lang: ttsLang, rate: appState.settings.voiceRate });
  } else if (window.speechSynthesis) {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = ttsLang;
    utter.rate = appState.settings.voiceRate;
    const langPrefix = utter.lang.split('-')[0];
    const matchVoice = voices.find(v => v.lang && v.lang.startsWith(langPrefix));
    if (matchVoice) utter.voice = matchVoice;
    speechSynthesis.speak(utter);
  }
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
  if (active) speak(screenVoiceText(active), screenVoiceLang(active), true);
}

/** 음성 읽기 멈추기 */
function stopVoice(){
  const Tts = getTtsPlugin();
  if (Tts) Tts.stop();
  else if (window.speechSynthesis) speechSynthesis.cancel();
}

/* ---------------------------------------------------------
   4. 화면 전환 + 진행바
   --------------------------------------------------------- */
/* 안내(온보딩) 화면 동안에는 긴급 도움 FAB을 숨긴다 */
const onboardScreens = new Set(['screen-greet', 'screen-signup', 'screen-login', 'screen-reset-pin', 'screen-onboard-access', 'screen-profile', 'screen-guardian-profile']);

/* 하단 네비게이션 바를 노출할 최상위 화면. 여기 없는 화면(촬영·로딩·결과 등 흐름 중간)에서는 숨겨서
   "네비바가 보이면 출발점, 안 보이면 진행 중"이라는 규칙을 만든다.
   더보기는 이제 화면 전환이 아니라 사이드바 드로어(openMoreDrawer())라 여기 포함되지 않는다.
   기록(screen-history)·설정(screen-settings)은 더보기 메뉴로 옮겨갔다 — 각 화면의 gear-btn과
   더보기의 "분석 기록" 행으로 여전히 접근 가능하다. */
const TAB_SCREENS = new Set(['screen-home', 'screen-info']);

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
  // 인앱 카메라를 켠 채로 촬영 화면을 벗어나면(뒤로가기 등) 카메라를 계속 켜두지 않도록 반드시 먼저 끈다
  if (activeScreenEl && activeScreenEl.id === 'screen-doc-capture' && id !== 'screen-doc-capture') stopInAppCamera();
  if (activeScreenEl) activeScreenEl.classList.remove('active');
  const target = document.getElementById(id);
  target.classList.add('active');
  target.scrollTop = 0; // 화면은 각자 스크롤 위치를 기억하므로, 새로 들어올 때는 항상 맨 위에서 시작한다
  activeScreenEl = target;
  speak(screenVoiceText(target), screenVoiceLang(target));
  document.body.classList.toggle('in-onboarding', onboardScreens.has(id));

  // 네비바는 최상위 탭 화면에서만 보인다.
  document.body.classList.toggle('has-bottom-nav', TAB_SCREENS.has(id));
  syncBottomNav(id);

  // 홈에 도달했다는 건 온보딩(인사→프로필→튜토리얼)을 어떤 경로로든 빠져나왔다는 뜻이다.
  // 건너뛰기·튜토리얼 완주 등 경로가 여러 개라 각각에 표시를 다는 대신 도착 지점에서 한 번만 기록한다.
  if (id === 'screen-home' && !appState.onboardingDone) {
    appState.onboardingDone = true;
    saveState();
  }

  if (id === 'screen-home') renderHomeDashboard(); // 오늘 해야 할 일 카드(renderTodayTasks 포함)를 홈 진입 시 채운다
  if (id === 'screen-info') renderInfoTab();
  if (id === 'screen-stats') renderStats();
  if (id === 'screen-settings') syncSettingsUI();
  if (id === 'screen-onboard-access') syncAccessibilityOnboardUI();
  if (id === 'screen-profile') syncProfileUI();
  if (id === 'screen-my-info') syncProfileUI();
  if (id === 'screen-history') renderHistory();
  if (id === 'screen-welfare-nearby') loadWelfareNearby();
  if (id === 'screen-doc-capture') startInAppCamera();
  if (id === 'screen-loading-doc') startLoadingProgress('progressFillLoadDoc');
  if (id === 'screen-doc-collect') renderPendingPhotos();
  if (id === 'screen-ask') renderAskScreen();
  if (id === 'screen-result-doc') { renderDocResult(); applyDocPreview(); renderDocPager(); }
  if (id === 'screen-loading-text') startLoadingProgress('progressFillLoadText');
  if (id === 'screen-result-text') {
    renderSmsResult();
    syncGuardianNotifyPrompt();
  }
  if (id === 'screen-guardian-profile') syncGuardianUI();
  if (INFO_DETAIL_GREET_IDS[id]) renderInfoDetailGreet(id);
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
  renderHomeDueCard();
  renderHomeInfoCard();
  renderHomeGreet();
  renderAvatarPhoto();
}

/** 프로필의 성별 값("남성"/"여성", 항상 한국어로 저장됨)을 현재 화면 언어로 번역한다 */
function homeGenderWord(gender){
  if (gender === '남성') return t('settings.male');
  if (gender === '여성') return t('settings.female');
  return '';
}

/** 더보기 화면 상단 프로필 요약 카드(이름/나이/성별/지역)를 appState.profile로 채운다.
 *  값을 입력한 적 없으면 지어내지 않고 '-'로 둔다. */
function renderMoreProfileSummary(){
  const p = appState.profile;
  const nameEl = document.getElementById('moreProfileName');
  if (nameEl) nameEl.textContent = p.name || '-';
  const ageEl = document.getElementById('moreProfileAge');
  if (ageEl) ageEl.textContent = p.age ? `${p.age}${t('home.moreAgeUnit')}` : '-';
  const genderEl = document.getElementById('moreProfileGender');
  if (genderEl) genderEl.textContent = homeGenderWord(p.gender) || '-';
  const regionEl = document.getElementById('moreProfileRegion');
  if (regionEl) regionEl.textContent = p.region || '-';
}

/** 홈 인사 카드의 이름 부분("OOO님" / "70대 어르신" / 기본값). 언어를 바꾸면 이 문구도 같이 바뀌도록 t()로 가져온다. */
function homeGreetName(){
  const { name, gender, age } = appState.profile;
  if (name) return name + t('home.greetNameSuffix');
  if (age) {
    const genderWord = homeGenderWord(gender);
    const template = genderWord ? t('home.greetAgeGender') : t('home.greetAge');
    return template.replace('{age}', toAgeBand(age)).replace('{gender}', genderWord);
  }
  return t('home.greetDefault');
}

function renderHomeGreet(){
  const el = document.getElementById('homeGreetName');
  if (el) el.textContent = homeGreetName();
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
  if (!el) return; // screen-more가 프로필 요약+메뉴 화면으로 바뀌면서 이 목록은 더 이상 없다
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
  if (!wrap) return; // screen-more가 프로필 요약+메뉴 화면으로 바뀌면서 이 섹션은 더 이상 없다
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

/** 통계(월별 합계·누적 그래프)를 그리려면 기록이 어느 정도 쌓여 있어야 해서 상한을 늘렸다.
 *  항목 하나가 작은 객체라 localStorage 용량에는 여유가 있다. */
const HISTORY_LIMIT = 100;

/** 분석 결과 중 다시 열어볼 때 필요한 것만 골라 기록에 저장한다.
 *  사진 자체는 저장하지 않는다 - 기록을 최대 100건까지 쌓는데 사진(수백 KB씩)을 다 넣으면
 *  localStorage 용량을 금방 넘긴다. 다시 볼 때는 "사진은 다시 보여드릴 수 없어요"로 안내한다. */
const ANALYSIS_STORE_KEYS = ['status', 'headline', 'summary', 'checklist', 'phone', 'website', 'mapQuery', 'category', 'amount', 'dueDate', 'issuer'];

/** 분석 기록 추가.
 *  extra 에 AI 분석 결과 전체(status/headline/summary/checklist/...)를 넘기면
 *  기록에서 다시 열어볼 수 있고(openHistoryEntry), 문서라면 amount/dueDate도 통계에 쓰인다.
 *  ts(밀리초)는 정렬·그래프용이다 — time 은 "7/29 14:30" 같은 표시용 문자열이라 정렬에 쓸 수 없다.
 *  extra 없이 호출하던 기존 코드와 예전에 저장된 기록({title, result, time}만 있는 항목)도 그대로 동작한다. */
function addHistory(title, result, extra){
  const exists = appState.history.some(h => h.title === title);
  if (exists) { saveState(); return; }
  const entry = { title, result, time: formatNow(), ts: Date.now() };
  if (extra && typeof extra === 'object') {
    const analysis = {};
    for (const k of ANALYSIS_STORE_KEYS) {
      if (extra[k] !== undefined && extra[k] !== null && extra[k] !== '') analysis[k] = extra[k];
    }
    if (Object.keys(analysis).length) entry.analysis = analysis;

    const amount = Number(extra.amount);
    if (Number.isFinite(amount) && amount > 0) entry.amount = amount;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(extra.dueDate || ''))) entry.dueDate = extra.dueDate;
    if (extra.category) entry.category = String(extra.category);
    if (extra.issuer) entry.issuer = String(extra.issuer);
  }
  appState.history.unshift(entry);
  if (appState.history.length > HISTORY_LIMIT) appState.history.length = HISTORY_LIMIT;
  saveState();
  // 홈의 최근 기록 카드는 기록 탭으로 옮겨졌다(renderHistory가 전체 목록을 그린다).
}

/** 기록을 눌러 그때의 분석 결과를 다시 연다.
 *  예전에 저장된 기록(이 기능이 생기기 전이라 analysis가 없는 항목)은 원문을 저장해두지 않았으므로
 *  다시 볼 수 없다고 솔직하게 안내한다 - 없는 내용을 지어내 보여주지 않는다. */
function openHistoryEntry(index){
  const h = appState.history[index];
  if (!h) return;
  if (!h.analysis) { speak(t('history.noDetail')); return; }

  const isSms = h.title.startsWith('💬');
  lastCapturedPhoto = null; // 사진은 저장해두지 않으므로 다시 보여줄 수 없다
  if (isSms) {
    lastSmsAnalysis = h.analysis;
    goTo('screen-result-text');
  } else {
    lastDocAnalysis = h.analysis;
    docAnalyses = [h.analysis];
    docAnalysisIndex = 0;
    historyPreviewMode = true; // applyDocPreview()가 사진 대신 안내 문구를 보여주도록
    goTo('screen-result-doc');
  }
}

/** 기록 하나의 시각을 밀리초로. 예전 기록에는 ts 가 없으므로 time 문자열에서 최대한 복원한다.
 *  복원도 안 되면 null 을 돌려주고, 통계는 그런 항목을 건너뛴다(날짜를 지어내지 않는다). */
function historyTimestamp(h){
  if (h && Number.isFinite(h.ts)) return h.ts;
  const m = /^(\d{1,2})\/(\d{1,2})/.exec(String((h && h.time) || ''));
  if (!m) return null;
  const now = new Date();
  const month = Number(m[1]) - 1;
  // 연도가 없어 올해로 가정하되, 미래가 되면 작년으로 본다
  let year = now.getFullYear();
  const guess = new Date(year, month, Number(m[2]));
  if (guess.getTime() > now.getTime() + 86400000) year -= 1;
  return new Date(year, month, Number(m[2])).getTime();
}

function renderHistory(){
  const hList = document.getElementById('historyList');
  const sList = document.getElementById('scheduleList');
  if (appState.history.length === 0) {
    hList.innerHTML = '<div class="empty-state">아직 분석한 기록이 없습니다.<br>문서 찍기나 문자 보기를 이용해보세요.</div>';
  } else {
    // 항목을 누르면 openHistoryEntry()가 그때의 분석 결과를 다시 보여준다.
    // analysis가 없는(이 기능 이전에 저장된) 기록도 눌러지되, 안에서 "다시 볼 수 없다"고 안내한다.
    hList.innerHTML = appState.history.map((h, i) => `
      <div class="history-item" onclick="openHistoryEntry(${i})" role="button" tabindex="0">
        <div class="hi-body">
          <div class="hi-title">${escapeHtml(h.title)}</div>
          <div class="hi-meta">${escapeHtml(h.result)} · ${escapeHtml(h.time)}</div>
        </div>
        <svg class="chev" viewBox="0 0 24 24"><use href="#ic-chevron"></use></svg>
      </div>`
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
  // 문서에서 읽어낸 값을 기록에 함께 남겨 기한 알림·통계에 쓴다(없으면 addHistory가 알아서 걸러낸다)
  // 문서가 여러 개면 각각을 기록에 남긴다(통계·기한 알림이 문서 단위로 쌓여야 하므로)
  if (docAnalyses.length > 1) {
    docAnalyses.forEach(doc => {
      const b = statusBadgeMap[doc.status] || statusBadgeMap.normal;
      addHistory('📄 ' + (doc.headline || '문서 분석'), b.text, doc);
    });
  } else {
    addHistory('📄 ' + headline, badge.text, lastDocAnalysis || undefined);
  }
  pendingPhotos = [];
  docAnalyses = [];
  docAnalysisIndex = 0;
  lastCapturedPhoto = null;
  lastDocAnalysis = null;
  goTo('screen-home');
}

function finishSmsResult(){
  if (lastSmsAnalysis) {
    const badge = statusBadgeMap[lastSmsAnalysis.status] || statusBadgeMap.normal;
    // lastSmsAnalysis를 함께 넘겨야 기록에서 다시 열어볼 수 있다(예전에는 제목만 남기고 버렸다)
    addHistory('💬 ' + (lastSmsAnalysis.headline || '문자 분석'), badge.text, lastSmsAnalysis);
    // 예전에는 여기서 '보호자 알림 발송 (자동)' 기록을 남겼지만, 실제로 문자를 보내는 코드가 없어
    // 하지도 않은 일을 기록에 남기는 셈이었다. 브라우저/웹뷰는 사용자의 조작 없이 문자 앱을 열 수 없어
    // 자동 발송 자체가 불가능하므로, 기록은 notifyGuardian()에서 사용자가 실제로 버튼을 눌러
    // 문자 앱이 열렸을 때만 남긴다.
  }
  pendingSmsText = '';
  lastSmsAnalysis = null;
  goTo('screen-home');
}

/* ---------------------------------------------------------
   7-1. 실제 카메라 / 갤러리 연동 (Capacitor)
   --------------------------------------------------------- */
const AI_WORKER_URL = 'https://ondam-ai.kke88084.workers.dev';

let lastCapturedPhoto = null;
let lastDocAnalysis = null;
let lastDocChecklistRows = [];
let docPreviewDefaultHTML = '';
/** openHistoryEntry()가 켜두는 1회용 플래그. applyDocPreview()가 다음 한 번 읽고 스스로 끈다. */
let historyPreviewMode = false;

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
  // 바로 분석하지 않고 모아두는 화면으로 간다. 원하는 만큼 찍은 뒤 "분석하기"를 눌러야 분석이 시작된다.
  pendingPhotos.push(lastCapturedPhoto);
  lastCapturedPhoto = pendingPhotos[0];   // 결과 화면 미리보기는 첫 장을 쓴다
  goTo('screen-doc-collect');
}

/** 아직 분석하지 않고 모아둔 사진들.
 *  한 문서의 여러 페이지일 수도, 서로 다른 문서일 수도 있으며 그 판단은 AI가 한다
 *  (어르신에게 "이게 한 문서인가요?"를 묻지 않기 위함). */
let pendingPhotos = [];
const MAX_DOC_PHOTOS = 5;   // worker/src/index.js 의 같은 이름 상수와 맞춰야 한다

function removePendingPhoto(index){
  pendingPhotos.splice(index, 1);
  lastCapturedPhoto = pendingPhotos[0] || null;
  if (pendingPhotos.length === 0) { goTo('screen-doc-choice'); return; }
  renderPendingPhotos();
}

function renderPendingPhotos(){
  const list = document.getElementById('pendingPhotoList');
  if (!list) return;
  list.innerHTML = pendingPhotos.map((src, i) => `
    <div class="photo-thumb">
      <img src="${escapeHtml(src)}" alt="">
      <span class="photo-num">${i + 1}</span>
      <button type="button" class="photo-remove" onclick="removePendingPhoto(${i})" aria-label="${escapeHtml(t('docCollect.remove'))}">×</button>
    </div>`).join('');
  const count = document.getElementById('pendingPhotoCount');
  if (count) count.textContent = t('docCollect.count').replace('{n}', pendingPhotos.length);
  const addBtn = document.getElementById('pendingAddBtn');
  if (addBtn) addBtn.style.display = pendingPhotos.length >= MAX_DOC_PHOTOS ? 'none' : '';
}

/** "분석하기": 모아둔 사진을 한 번에 보낸다 */
function analyzePendingPhotos(){
  if (pendingPhotos.length === 0) return;
  goTo('screen-loading-doc');
  if (AI_WORKER_URL) analyzeDocument(pendingPhotos);
}

function cancelPendingPhotos(){
  pendingPhotos = [];
  lastCapturedPhoto = null;
  goTo('screen-home');
}
function capturePhoto(){ return pickPhoto(true, 'environment'); }
function pickFromGallery(){ return pickPhoto(false, null); }

/* ---- 인앱 카메라: 외부 카메라 앱이나 파일 선택기로 나가지 않고 웹뷰 안에서 바로 촬영한다.
   getUserMedia를 지원하지 않거나 권한이 거부되면(구형 기기, 데스크톱에서 권한 거부 등) 조용히
   기존 capturePhoto()(네이티브 플러그인 또는 파일 선택) 경로로 폴백한다 — 화면은 안내 테두리만 보여준 채로 그대로 둔다. ---- */
let inAppCameraStream = null;

async function startInAppCamera(){
  const video = document.getElementById('inAppCameraVideo');
  if (!video || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    inAppCameraStream = stream;
    video.srcObject = stream;
    video.style.display = 'block';
  } catch (err) {
    inAppCameraStream = null; // 권한 거부·카메라 없음: 안내 테두리만 남기고 촬영 버튼은 capturePhoto() 폴백으로 동작
  }
}

function stopInAppCamera(){
  if (inAppCameraStream) {
    inAppCameraStream.getTracks().forEach(track => track.stop());
    inAppCameraStream = null;
  }
  const video = document.getElementById('inAppCameraVideo');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
}

/** 촬영 버튼: 인앱 카메라 미리보기가 켜져 있으면 지금 보이는 화면을 그대로 캡처하고,
 *  아니면(폴백) 기존 capturePhoto()(네이티브 플러그인 또는 파일 선택)로 넘어간다. */
function captureInAppPhoto(){
  if (!inAppCameraStream) { capturePhoto(); return; }
  const video = document.getElementById('inAppCameraVideo');
  const canvas = document.getElementById('inAppCameraCanvas');
  canvas.width = video.videoWidth || 720;
  canvas.height = video.videoHeight || 960;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  stopInAppCamera();
  pendingPhotos.push(dataUrl);
  lastCapturedPhoto = pendingPhotos[0];
  goTo('screen-doc-collect');
}

/* ---- 홈 화면 프로필 사진 ----
   문서 사진과 달리 서버로 보내지 않고 이 기기에만 작은 크기로 저장한다(appState.avatarPhoto). */
const AVATAR_MAX_SIDE = 320;

/** 원본 사진을 정사각형에 가깝게 줄여 작은 data URL로 만든다. 캔버스가 막히면(교차 출처 등) 원본을 그대로 돌려준다. */
function prepareAvatarPhoto(src){
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const scale = Math.min(1, AVATAR_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        resolve(src);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function pickAvatarPhoto(){
  const Camera = getCameraPlugin();
  let raw = null;
  try {
    if (Camera) {
      const { results } = await Camera.chooseFromGallery({ quality: 80 });
      if (!results || !results.length) return;
      raw = results[0].webPath;
    } else {
      raw = await pickWebPhoto(null);
      if (!raw) return;
    }
  } catch (err) {
    return; // 사용자가 선택을 취소한 경우 등: 그대로 둔다
  }
  const prepared = await prepareAvatarPhoto(raw);
  if (!prepared) return;
  appState.avatarPhoto = prepared;
  saveState();
  renderAvatarPhoto();
}

function renderAvatarPhoto(){
  document.querySelectorAll('.home-avatar').forEach(el => {
    el.classList.toggle('has-photo', !!appState.avatarPhoto);
    el.style.backgroundImage = appState.avatarPhoto ? `url("${appState.avatarPhoto}")` : '';
  });
}

/** 지금 보고 있는 문서(lastDocAnalysis)에 해당하는 사진을 pendingPhotos에서 찾는다.
 *  Worker가 돌려주는 pages(1부터 시작하는 사진 번호)로 매칭하고, 없으면 문서 순서(docAnalysisIndex)로 대신한다.
 *  사진이 여러 장이라 문서마다 다른 사진을 봐야 하는데, 예전에는 항상 첫 장(lastCapturedPhoto)만 보여줬다. */
function docPreviewPhotoForCurrent(){
  if (!pendingPhotos.length) return null;
  const pages = lastDocAnalysis && Array.isArray(lastDocAnalysis.pages) ? lastDocAnalysis.pages : null;
  if (pages && pages.length && pages[0] >= 1 && pages[0] <= pendingPhotos.length) {
    return pendingPhotos[pages[0] - 1];
  }
  return pendingPhotos[docAnalysisIndex] || pendingPhotos[0];
}

/** 실제로 찍거나 고른 사진이 있으면 결과 화면에 보여주고,
 *  기록을 다시 열어본 경우(사진을 저장해두지 않음)에는 안내 문구를,
 *  그 외(연습 등 사진이 아예 없는 경우)에는 기본 예시로 되돌린다. */
function applyDocPreview(){
  const el = document.getElementById('docPreviewContent');
  const isHistoryPreview = historyPreviewMode;
  historyPreviewMode = false; // 다음 화면 진입에 영향이 남지 않도록 한 번 읽고 바로 끈다
  const photo = docPreviewPhotoForCurrent();
  if (photo) {
    el.innerHTML = `<img src="${photo}" style="width:100%;display:block;">`;
  } else if (isHistoryPreview) {
    // history.noPhoto는 <br>이 섞인 번역 문구라 escapeHtml로 감싸면 안 된다(다른 data-i18n 문구와 같은 방식)
    el.innerHTML = `<div style="padding:28px 16px;text-align:center;color:var(--ink-faint);font-size:13px;">${t('history.noPhoto')}</div>`;
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

/** 체크리스트를 대표하는 일러스트 카드를 채우거나 숨긴다. Worker가 생성에 실패하면(키 없음 등) illustration이
 *  없으므로, 이때는 빈 칸을 보여주지 않고 카드를 통째로 숨긴다 - 지도 렌더링 실패와 같은 원칙. */
function applyIllustration(cardId, imgId, dataUri){
  const card = document.getElementById(cardId);
  const img = document.getElementById(imgId);
  if (!card || !img) return;
  if (dataUri) {
    img.src = dataUri;
    card.style.display = 'block';
  } else {
    img.removeAttribute('src');
    card.style.display = 'none';
  }
}

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

/* ---- 업로드 전 사진 줄이기 ----
   요즘 휴대폰 사진은 원본 그대로 base64로 바꾸면 수 MB이고, 중계 서버가 큰 본문을 거부해
   ("Request Entity Too Large") 분석이 실패한다. 글자를 읽는 데는 긴 변 1600px 이면 충분하므로
   보내기 전에 줄이고 JPEG로 다시 인코딩한다. 원본 화면 미리보기에는 영향을 주지 않는다. */
const UPLOAD_MAX_SIDE = 1600;
const UPLOAD_JPEG_QUALITY = 0.82;

function preparePhotoForUpload(src){
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(dataUrlToBase64(canvas.toDataURL('image/jpeg', UPLOAD_JPEG_QUALITY)));
      } catch (err) {
        // 캔버스가 막힌 경우(교차 출처 등)에는 원본 그대로라도 보내본다
        resolve(dataUrlToBase64(src));
      }
    };
    img.onerror = () => resolve(dataUrlToBase64(src));
    img.src = src;
  });
}

/** AI 분석 자체가 실패했을 때(서버 오류, API 크레딧 부족 등) 공통 화면으로 보내고, "다시 시도" 버튼이 원래 화면으로 돌아가도록 기억해둔다 */
let aiErrorRetryScreen = 'screen-home';
function goToAiError(retryScreen, isOffline){
  aiErrorRetryScreen = retryScreen;
  finishAllProgress();

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
  if (aiErrorRetryScreen === 'screen-sms-recent' && pendingSmsText) {
    goTo('screen-loading-text');
    analyzeSmsText(pendingSmsText);
    return;
  }
  goTo(aiErrorRetryScreen);
}

/** 사진 한 장(문자열) 또는 여러 장(배열)을 받아 분석한다. */
async function analyzeDocument(input){
  const dataUrls = Array.isArray(input) ? input : [input];
  if (!navigator.onLine) { goToAiError('screen-doc-choice', true); return; }
  // 원본 그대로 보내면 본문이 수 MB가 되어 중계 서버가 거부한다. 보내기 전에 줄인다.
  const parsedList = (await Promise.all(dataUrls.map(preparePhotoForUpload))).filter(Boolean);
  if (parsedList.length === 0) { goTo('screen-doc-error'); return; }

  try {
    const res = await fetch(AI_WORKER_URL + '/analyze-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: parsedList.map(p => ({ data: p.base64, mediaType: p.mediaType })),
        profile: appState.profile,
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) { goToAiError('screen-doc-choice'); return; }
    // 새 형식은 documents 배열, 예전 형식은 단일 객체. 둘 다 받아들인다.
    docAnalyses = Array.isArray(data.documents) && data.documents.length ? data.documents : [data];
    docAnalysisIndex = 0;
    lastDocAnalysis = docAnalyses[0];
    finishAllProgress();
    goTo('screen-result-doc');
  } catch (err) {
    goToAiError('screen-doc-choice', !navigator.onLine);
  }
}

/* ---- 문서가 여러 개일 때 결과를 넘겨 보기 ----
   사진을 여러 장 찍으면 AI가 한 문서로 묶거나 여러 문서로 나눈다.
   1개면 지금까지와 똑같이 보이고, 2개 이상일 때만 넘기기 막대가 나타난다. */
let docAnalyses = [];
let docAnalysisIndex = 0;

function showDocAnalysis(index){
  if (index < 0 || index >= docAnalyses.length) return;
  docAnalysisIndex = index;
  lastDocAnalysis = docAnalyses[index];
  renderDocResult();
  applyDocPreview();
  renderDocPager();
}

/** 문서가 여러 장일 때 이전/다음 화살표로 넘기는 페이지 표시. 숫자(1/2)를 크게 보여줘 몇 번째인지 한눈에 알 수 있게 한다. */
function renderDocPager(){
  const pager = document.getElementById('docPager');
  if (!pager) return;
  if (docAnalyses.length < 2) { pager.style.display = 'none'; return; }
  const isFirst = docAnalysisIndex === 0;
  const isLast = docAnalysisIndex === docAnalyses.length - 1;
  pager.innerHTML = `
    <div class="pager-arrows">
      <button type="button" class="pager-arrow-btn" onclick="showDocAnalysis(${docAnalysisIndex - 1})" ${isFirst ? 'disabled' : ''} aria-label="${t('result.docPrev')}">
        <svg class="inline-icon" viewBox="0 0 24 24" style="transform:scaleX(-1);"><use href="#ic-chevron"></use></svg>
      </button>
      <div class="pager-label">${escapeHtml(t('result.docCountLabel').replace('{i}', docAnalysisIndex + 1).replace('{n}', docAnalyses.length))}</div>
      <button type="button" class="pager-arrow-btn" onclick="showDocAnalysis(${docAnalysisIndex + 1})" ${isLast ? 'disabled' : ''} aria-label="${t('result.docNext')}">
        <svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-chevron"></use></svg>
      </button>
    </div>`;
  pager.style.display = 'block';
}

/** AI 분석 결과(headline/summary/checklist/status)를 결과 화면에 반영. AI가 만든 텍스트이므로 항상 textContent로만 채워 넣는다(HTML 삽입 금지). */
/* ---- 문서에서 읽어낸 핵심 값(금액·기한·기관·분류) ----
   Worker가 category/amount/dueDate/issuer 를 돌려주기 시작하면 켜지는 화면이다.
   아직 배포 전이라 이 필드들이 없는 응답이 오면 아래 함수들이 전부 빈 값으로 처리해 카드를 숨긴다.
   값이 없을 때 "0원"이나 임의의 날짜를 지어내지 않는다. */

/** 금액을 천 단위 콤마와 함께. 값이 없거나 0이면 빈 문자열 */
function formatDocAmount(amount){
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toLocaleString('ko-KR') + '원';
}

/** "2026-08-10" -> "8월 10일까지". 형식이 아니면 빈 문자열 */
function formatDocDueDate(dueDate){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate || '').trim());
  if (!m) return '';
  return `${Number(m[2])}월 ${Number(m[3])}일까지`;
}

/** 기한까지 남은 날짜 안내. { text, urgent } 또는 null */
function docDueDateLeft(dueDate){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate || '').trim());
  if (!m) return null;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return { text: '기한이 지났어요', urgent: true };
  if (days === 0) return { text: '오늘까지예요', urgent: true };
  return { text: `${days}일 남았어요`, urgent: days <= 7 };
}

function renderDocKeyFacts(data){
  const wrap = document.getElementById('docKeyFacts');
  if (!wrap) return;
  const amountText = formatDocAmount(data && data.amount);
  const dueText = formatDocDueDate(data && data.dueDate);
  const issuer = String((data && data.issuer) || '').trim();
  const category = String((data && data.category) || '').trim();

  const amountBox = document.getElementById('docKeyAmount');
  amountBox.style.display = amountText ? 'block' : 'none';
  if (amountText) document.getElementById('docKeyAmountValue').textContent = amountText;

  const dueBox = document.getElementById('docKeyDue');
  dueBox.style.display = dueText ? 'block' : 'none';
  if (dueText) {
    document.getElementById('docKeyDueValue').textContent = dueText;
    const left = docDueDateLeft(data.dueDate);
    const leftEl = document.getElementById('docKeyDueLeft');
    leftEl.textContent = left ? left.text : '';
    leftEl.classList.toggle('urgent', !!(left && left.urgent));
  }

  // 기관명·분류는 AI가 문서에서 읽은 값이므로 번역하지 않고 원문 그대로 보여준다
  const tags = [];
  if (issuer) tags.push(issuer);
  if (category && category !== '기타') tags.push(category);
  document.getElementById('docKeyTags').innerHTML =
    tags.map(v => `<span class="tag">${escapeHtml(v)}</span>`).join('');

  wrap.style.display = (amountText || dueText || tags.length) ? 'flex' : 'none';
}

function renderDocResult(){
  const data = lastDocAnalysis;
  if (!data) return;

  // 화면 진입 시(goTo)의 기본 음성 안내는 이 함수가 실행되기 전에 읽히므로, 실제 분석 결과를
  // data-voice에 반영해두고 여기서 다시 읽어준다("다시 듣기" 버튼도 이 속성을 그대로 사용함)
  const voiceText = [data.headline, data.summary].filter(Boolean).join('. ');
  document.getElementById('screen-result-doc').setAttribute('data-voice', voiceText);
  speak(voiceText);

  renderDocKeyFacts(data);
  applyResultHero(document.querySelector('#screen-result-doc .result-card'), data);
  applyIllustration('docIllustration', 'docIllustrationImg', data.illustration);

  document.querySelector('#docEasyView p').textContent = data.summary || '';

  const checklistEl = document.querySelector('#screen-result-doc .checklist');
  checklistEl.innerHTML = '';
  const checklist = data.checklist || [];
  // 번역이 나중에 도착했을 때 라벨/체크박스/알림버튼을 함께 갱신할 수 있도록 참조를 모아둔다(아래 applyDocResultTranslation 참고)
  const checklistRows = [];
  if (checklist.length === 0) {
    checklistEl.innerHTML = '<div class="empty-hint">특별히 하실 일은 없어요.</div>';
  } else {
    checklist.forEach(item => {
      // state.text를 통해 참조해야 번역 도착 후 알림 버튼(openReminderModal)에도 번역된 문구가 전달된다
      const state = { text: item };
      const row = document.createElement('div');
      row.className = 'checklist-row';

      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'schedule-check';
      checkbox.dataset.schedule = state.text;
      checkbox.dataset.source = '문서 분석';
      label.appendChild(checkbox);
      const textNode = document.createTextNode(' ' + state.text);
      label.appendChild(textNode);

      const btn = document.createElement('button');
      btn.className = 'reminder-btn';
      btn.innerHTML = '<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-bell"></use></svg>알림 설정';
      btn.addEventListener('click', () => openReminderModal(state.text, '문서 분석'));

      row.appendChild(label);
      row.appendChild(btn);
      checklistEl.appendChild(row);
      bindScheduleCheckbox(checkbox);
      checklistRows.push({ state, checkbox, textNode });
    });
  }

  // 표시 언어가 한국어가 아니면 위에서 그린 한국어 결과 위에 번역을 덧입힌다(비동기, 실패해도 한국어 그대로 유지).
  // analyzeDocument()가 goTo('screen-result-doc')를 부를 때 이미 appState.settings.language가 반영돼 있으므로
  // 언어를 바꾼 뒤 분석한 경우든, 이미 다른 언어에서 분석한 경우든 여기서 자연스럽게 처리된다.
  // retryDocTranslation()이 체크박스 상태를 잃지 않고 재시도할 수 있도록 rows 참조를 기억해둔다.
  lastDocChecklistRows = checklistRows;
  applyDocResultTranslation(data, checklistRows);
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
let lastSmsChecklistRows = [];

function getSmsReaderPlugin(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SmsReader) || null;
}

/** 문자 확인 화면 진입점. 권한이 있으면 바로 목록을 보여주고, 없으면 요청하거나
 *  (플러그인 자체가 없는 웹/iOS라면) 권한 필요 화면으로 보낸다. 복사/붙여넣기로는 폴백하지 않는다. */
async function openSmsCheck(){
  const SmsReader = getSmsReaderPlugin();
  if (!SmsReader) { showSmsPermissionNeeded('unsupported'); return; }
  try {
    const status = await SmsReader.checkPermissions();
    if (status.sms === 'granted') { await loadAndShowRecentSms(SmsReader); return; }
    const requested = await SmsReader.requestPermissions();
    if (requested.sms === 'granted') { await loadAndShowRecentSms(SmsReader); return; }
    showSmsPermissionNeeded('denied');
  } catch (err) {
    showSmsPermissionNeeded('denied');
  }
}

function showSmsPermissionNeeded(reason){
  const isUnsupported = reason === 'unsupported';
  document.getElementById('smsPermissionTitle').innerHTML = isUnsupported
    ? t('sms.permission.unsupportedTitle')
    : t('sms.permission.title');
  document.getElementById('smsPermissionDesc').innerHTML = isUnsupported
    ? t('sms.permission.unsupportedDesc')
    : t('sms.permission.desc');
  document.getElementById('smsPermissionSettingsBtn').style.display = isUnsupported ? 'none' : '';
  goTo('screen-sms-permission-needed');
}

function openSmsAppSettings(){
  const SmsReader = getSmsReaderPlugin();
  if (SmsReader) SmsReader.openAppSettings();
}

async function loadAndShowRecentSms(SmsReader){
  goTo('screen-sms-recent');
  document.getElementById('smsRecentCount').textContent = t('sms.recent.loading');
  try {
    const { messages } = await SmsReader.getRecentMessages({ limit: 30 });
    renderSmsRecentList(messages || []);
  } catch (err) {
    renderSmsRecentList([]);
  }
}

/** SmsReader가 넘겨주는 epoch ms를 "오늘 14:32" / "7월 30일 14:32" 형태로 보여준다.
 *  재난안전문자처럼 문구가 거의 같은 문자가 반복 수신될 때, 시각이 없으면 화면에서 완전히
 *  같은 문자가 중복된 것처럼 보인다 — 실제로는 서로 다른 시각에 온 별개 문자일 수 있으므로 구분해준다. */
function formatSmsReceivedAt(epochMs){
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return isToday ? `오늘 ${time}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
}

/** 문자 미리보기 한 줄(50자)만 보여주고, 발신번호·받은 시각은 그대로 표시한다.
 *  AI가 만든 텍스트가 아니라 기기 문자 원문이므로 XSS 방지를 위해 항상 textContent로만 채운다. */
function renderSmsRecentList(messages){
  const listEl = document.getElementById('smsRecentList');
  const emptyEl = document.getElementById('smsRecentEmpty');
  const countEl = document.getElementById('smsRecentCount');
  listEl.innerHTML = '';
  if (messages.length === 0) {
    countEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  countEl.style.display = '';
  countEl.textContent = t('sms.recent.desc');
  emptyEl.style.display = 'none';
  messages.forEach((msg) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.onclick = () => selectSmsMessage(msg.body);

    const iconChip = document.createElement('div');
    iconChip.className = 'icon-chip accent';
    iconChip.innerHTML = '<svg viewBox="0 0 24 24"><use href="#ic-chat"></use></svg>';

    const text = document.createElement('div');
    text.className = 'text';
    const t1 = document.createElement('div');
    t1.className = 't1';
    t1.textContent = msg.address || t('sms.recent.unknownSender');
    const t2 = document.createElement('div');
    t2.className = 't2';
    const preview = (msg.body || '').replace(/\s+/g, ' ').trim();
    t2.textContent = preview.length > 50 ? preview.slice(0, 50) + '…' : preview;
    text.appendChild(t1);
    text.appendChild(t2);
    // 받은 시각을 보여줘야 "완전히 같아 보이는" 반복 재난안전문자 등을 서로 다른 문자로 구분할 수 있다
    // (미리보기만으로는 몇 시에 온 문자인지 알 수 없어 중복처럼 보이는 문제가 있었다).
    if (msg.date) {
      const t3 = document.createElement('div');
      t3.style.cssText = 'font-size:12px;font-weight:500;color:var(--ink-faint);margin-top:2px;';
      t3.textContent = formatSmsReceivedAt(msg.date);
      text.appendChild(t3);
    }

    row.appendChild(iconChip);
    row.appendChild(text);
    listEl.appendChild(row);
  });
}

function selectSmsMessage(body){
  pendingSmsText = body;
  startSmsAnalysis();
}

function startSmsAnalysis(){
  goTo('screen-loading-text');
  analyzeSmsText(pendingSmsText);
}

async function analyzeSmsText(text){
  if (!navigator.onLine) { goToAiError('screen-sms-recent', true); return; }

  try {
    const res = await fetch(AI_WORKER_URL + '/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, profile: appState.profile })
    });
    const data = await res.json();
    if (!res.ok || data.error) { goToAiError('screen-sms-recent'); return; }
    lastSmsAnalysis = data;
    finishAllProgress();
    goTo('screen-result-text');
  } catch (err) {
    goToAiError('screen-sms-recent', !navigator.onLine);
  }
}

/** AI 분석 결과를 문자 결과 화면에 반영. AI가 만든 텍스트이므로 textContent로만 채운다(HTML 삽입 금지) */
/** 문자가 위험으로 판별되지 않았을 때(정보/정상)를 대비한 일반적인 안내.
 *  AI가 checklist를 비워 보내면(할 일이 특별히 없는 경우) 여기로 대신 채운다 —
 *  실제 문자 내용을 지어내지 않고, 늘 맞는 일반 원칙만 담는다. */
const SMS_DEFAULT_TIPS = [
  '상대방이 요구하는 계좌번호나 비밀번호를 절대 말하지 마세요.',
  '가족이나 가까운 지인에게 지금 상황을 꼭 알리세요.'
];

function renderSmsResult(){
  const data = lastSmsAnalysis;
  if (!data) return;

  // 화면 진입 시(goTo)의 기본 음성 안내는 이 함수보다 먼저 실행되므로, 실제 판별 결과를
  // data-voice에 넣어두고 여기서 다시 읽어준다("다시 듣기" 버튼도 이 속성을 그대로 사용함).
  // 예전에는 data-voice가 "위험할 수 있습니다"로 고정돼 있어 안전한 문자에도 위험하다고 읽었다.
  const voiceText = [data.headline, data.summary].filter(Boolean).join('. ');
  document.getElementById('screen-result-text').setAttribute('data-voice', voiceText);
  speak(voiceText);

  applyResultHero(document.querySelector('#screen-result-text .result-card'), data);
  applyIllustration('smsIllustration', 'smsIllustrationImg', data.illustration);

  // 위험(danger) 판정일 때만 "위험 문자 요소" 카드로 이유를 보여주고, result-card 안의 이유 문장은 숨긴다
  // (같은 내용 중복 방지, Figma 시안 반영). 정상/정보 판정은 기존처럼 result-card 안에만 보여준다.
  const isDanger = data.status === 'danger';
  const reasonLabelEl = document.querySelector('#screen-result-text .reason-label');
  const subtextEl = document.querySelector('#screen-result-text .result-card .subtext');
  if (reasonLabelEl) reasonLabelEl.style.display = isDanger ? 'none' : '';
  if (subtextEl) subtextEl.style.display = isDanger ? 'none' : '';
  const riskCard = document.getElementById('smsRiskCard');
  if (riskCard) {
    riskCard.style.display = isDanger ? 'block' : 'none';
    const riskItem = document.getElementById('smsRiskSummaryItem');
    if (riskItem) riskItem.textContent = data.summary || '';
  }

  // "지금 바로 대처하세요" — 예전에는 HTML에 고정된 두 문장이라 분석 결과가 바뀌어도 그대로였다.
  // AI가 이 문자에 맞춰 알려준 checklist로 채우고, 비어있을 때만 일반 안전 수칙으로 대신한다.
  const todoEl = document.getElementById('smsTodoList');
  const todoRows = [];
  if (todoEl) {
    const items = (Array.isArray(data.checklist) && data.checklist.length) ? data.checklist : SMS_DEFAULT_TIPS;
    todoEl.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'checklist-row';
      const label = document.createElement('label');
      label.style.cursor = 'default';
      label.textContent = item;
      row.appendChild(label);
      todoEl.appendChild(row);
      todoRows.push({ label, item });
    });
  }

  // 표시 언어가 한국어가 아니면 위 한국어 결과 위에 번역을 덧입힌다(비동기, 실패해도 한국어 그대로 유지).
  // SMS_DEFAULT_TIPS로 채워진 경우에도 화면에 실제로 보이는 문구를 그대로 번역 대상에 넣는다.
  lastSmsChecklistRows = todoRows;
  applySmsResultTranslation(data, todoRows);
}

/* ---------------------------------------------------------
   9. 자동 실행 버튼 (지도 열기)
   --------------------------------------------------------- */
function openMap(query){
  window.open('https://map.kakao.com/?q=' + encodeURIComponent(query), '_blank');
}

/* ---------------------------------------------------------
   9-1. 더보기: 오른쪽에서 슬라이드인하는 사이드바 드로어
   --------------------------------------------------------- */
function openMoreDrawer(){
  renderMoreProfileSummary();
  document.getElementById('moreBackdrop').style.display = 'block';
  document.getElementById('moreDrawer').classList.add('open');
  syncBottomNav('screen-more'); // 드로어가 열려있는 동안은 "더보기" 탭을 활성 표시한다
}
function closeMoreDrawer(){
  document.getElementById('moreBackdrop').style.display = 'none';
  document.getElementById('moreDrawer').classList.remove('open');
  syncBottomNav(activeScreenEl ? activeScreenEl.id : 'screen-home'); // 실제로 보고 있던 화면 탭으로 활성 표시 복구
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
  hideGuardianPhonePrompt();
}

/* ---- 긴급 도움 시트 안의 보호자 전화번호 인라인 입력 ----
   예전에는 번호가 없으면 goTo('screen-settings')로 설정 화면으로 보냈는데,
   급한 상황에서 설정 화면을 헤매게 만드는 나쁜 흐름이었다.
   이제는 시트를 닫지 않고 그 자리에서 번호를 받아, 저장과 동시에 전화를 건다. */
function guardianPhoneDigits(value){
  return String(value || '').replace(/\D/g, '');
}
/** 회원가입/PIN 재설정처럼 본인 명의 휴대폰 번호가 실제로 필요한 곳에서 쓰는 엄격한 검증.
 *  010으로 시작하는 10~11자리 국내 휴대폰 번호 형식만 통과시킨다(자릿수만 세던 기존 방식은
 *  010이 아닌 임의의 숫자로도 가입이 되는 문제가 있었다). */
function isValidKoreanMobilePhone(value){
  return /^010\d{7,8}$/.test(guardianPhoneDigits(value));
}
/** 번호를 저장한 뒤에 할 일: 'call'(전화 걸기) 또는 'sms'(보호자에게 알리는 문자 앱 열기) */
let guardianPhonePromptMode = 'call';
function showGuardianPhonePrompt(mode){
  const wrap = document.getElementById('guardianPhonePrompt');
  if (!wrap) return;
  guardianPhonePromptMode = (mode === 'sms') ? 'sms' : 'call';
  const saveBtn = document.getElementById('guardianPhoneQuickSave');
  if (saveBtn) {
    // data-i18n 을 같이 바꿔둬야 나중에 언어를 바꿔도 applyLanguage()가 알맞은 문구로 다시 채운다
    saveBtn.dataset.i18n = guardianPhonePromptMode === 'sms' ? 'emergency.phoneSaveSms' : 'emergency.phoneSaveCall';
    saveBtn.textContent = t(saveBtn.dataset.i18n);
  }
  wrap.style.display = 'block';
  const err = document.getElementById('guardianPhoneQuickError');
  if (err) err.style.display = 'none';
  const input = document.getElementById('guardianPhoneQuick');
  if (input) {
    input.value = appState.guardian.phone || '';
    setTimeout(() => { try { input.focus(); } catch (e) {} }, 60);
  }
  speak(t('emergency.phoneAsk'));
}
function hideGuardianPhonePrompt(){
  guardianPhonePromptMode = 'call';   // 다음에 시트를 그냥 열었을 때는 기본값(전화 걸기)으로 돌아간다
  const wrap = document.getElementById('guardianPhonePrompt');
  if (wrap) wrap.style.display = 'none';
  const err = document.getElementById('guardianPhoneQuickError');
  if (err) err.style.display = 'none';
}
/** 숫자와 하이픈만 남긴다(어르신이 다른 문자를 눌러도 번호가 망가지지 않도록) */
function onGuardianPhoneInput(input){
  const cleaned = String(input.value || '').replace(/[^0-9-]/g, '');
  if (cleaned !== input.value) input.value = cleaned;
  const err = document.getElementById('guardianPhoneQuickError');
  if (err) err.style.display = 'none';
}
function saveGuardianPhoneAndCall(){
  const input = document.getElementById('guardianPhoneQuick');
  const err = document.getElementById('guardianPhoneQuickError');
  const phone = String(input ? input.value : '').replace(/[^0-9-]/g, '').trim();
  if (guardianPhoneDigits(phone).length < 9) {
    // 숫자가 모자라면 전화를 걸지 않고 화면에 안내만 띄운다(잘못된 번호로 거는 것을 막기 위함)
    if (err) err.style.display = 'block';
    speak(t('emergency.phoneInvalid'));
    return;
  }
  appState.guardian.phone = phone;
  saveState();
  syncGuardianUI();   // 설정·온보딩 화면에도 같은 번호를 반영
  const mode = guardianPhonePromptMode;
  closeEmergencySheet();
  // 보호자에게 알리려다 번호가 없어서 여기까지 온 경우에는 전화가 아니라 문자 앱을 연다
  if (mode === 'sms') { openGuardianSmsApp(); return; }
  window.location.href = 'tel:' + phone;
}

function callGuardianFromSheet(){
  if (guardianPhoneDigits(appState.guardian.phone).length < 9) { showGuardianPhonePrompt(); return; }   // 시트를 닫지 않고 그 안에서 입력받는다
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
  syncToggleGroup('fontScaleGroupOnboard', 'scale', value);
  saveState();
}

function setVoiceRate(value){
  appState.settings.voiceRate = value;
  syncToggleGroup('voiceRateGroup', 'rate', value);
  syncToggleGroup('voiceRateGroupOnboard', 'rate', value);
  saveState();
  speak('이 정도 속도로 읽어드릴게요.');
}

/** 회원가입 직후 접근성 설정 화면(screen-onboard-access) 진입 시, screen-settings와 같은
 *  세그먼트/토글 컨트롤을 현재 appState.settings 값에 맞춰 미리 표시한다. */
function syncAccessibilityOnboardUI(){
  syncToggleGroup('fontScaleGroupOnboard', 'scale', appState.settings.fontScale);
  syncToggleGroup('voiceRateGroupOnboard', 'rate', appState.settings.voiceRate);
  syncVoiceEnabledToggles();
  syncToggleGroupString('languageGroupOnboard', appState.settings.language);
}

/** 보호자(자녀) 정보: 설정 화면과 온보딩의 "자녀 정보" 화면 두 곳에 같은 값을 반영한다(내 정보와 같은 방식). */
function syncGuardianUI(){
  setValueIfChanged(document.getElementById('guardianName'), appState.guardian.name);
  setValueIfChanged(document.getElementById('guardianNameOnboard'), appState.guardian.name);
  setValueIfChanged(document.getElementById('guardianPhone'), appState.guardian.phone);
  setValueIfChanged(document.getElementById('guardianPhoneOnboard'), appState.guardian.phone);
  const toggle = document.getElementById('autoNotifyToggle');
  if (toggle) toggle.checked = appState.guardian.autoNotify;
}

function setGuardianField(field, value){
  appState.guardian[field] = value;
  saveState();
  syncGuardianUI();
}

/* ---------------------------------------------------------
   언어 설정 (경기도 거주 외국인주민 통계 기준 상위 4개국 언어).
   핵심 화면(홈/설정) 문구만 번역하고, AI 분석 결과는 정확성을 위해 항상 한국어로 유지한다.
   --------------------------------------------------------- */
const I18N = {
  ko: {
    'home.sectionTitle': '무엇을 도와드릴까요?',
    'home.assistantActive': '온담 비서가 활성화되었습니다', 'home.assistantInactive': '온담 비서가 비활성화되었습니다',
    'home.greetDefault': '어르신',
    'home.greetNameSuffix': '님', 'home.greetAge': '{age}대 어르신', 'home.greetAgeGender': '{age}대 {gender} 어르신',
    'home.docCaptureTitle': '문서 촬영',
    'home.docCaptureDesc': '사진을 찍거나 불러오면 AI가 쉽게 설명해드려요',
    'home.smsCheckTitle': '문자 내용 요약',
    'home.smsCheckDesc': '받은 문자가 안전한지 AI가 확인해드려요',
    'home.welfareTitle': '주변 복지센터·경로당 찾기',
    'home.moreMenu': '더보기',
    'home.moreNameLabel': '이름 :', 'home.moreAgeLabel': '나이', 'home.moreGenderLabel': '성별', 'home.moreRegionLabel': '지역', 'home.moreAgeUnit': '세',
    'home.moreMyInfo': '내 정보', 'home.moreHistory': '분석 기록', 'home.moreStats': '통계',
    'home.welfareDesc': '내 위치 주변 복지센터·경로당 위치를 알려드려요',
    'home.todayTasks': '오늘 해야 할 일',
    'home.viewAll': '전체 보기',
    'home.noTasksToday': '오늘 할 일이 없습니다.',
    'home.publicInfoDefault': '알아두면 좋은 정보',
    'home.infoMore': '정보 더보기',
    'home.dueTitle': '곧 내야 할 것',
    'home.dueMore': '전체 통계 보기',
    'stats.title': '고지서 통계',
    'result.share': '자녀에게 보내기',
    'result.ask': '이 문서에 대해 물어보기',
    'ask.title': '물어보기',
    'ask.voice': '궁금한 것을 눌러보시거나 직접 적어주세요.',
    'ask.suggested': '이런 걸 물어보실 수 있어요',
    'ask.placeholder': '직접 물어보기',
    'ask.send': '물어보기',
    'ask.note': '이 문서에 적힌 내용을 바탕으로 답해드려요. 문서에 없는 내용은 그렇다고 알려드립니다.',
    'ask.thinking': '생각하고 있어요...',
    'ask.failed': '지금은 답변을 드리기 어려워요. 잠시 후 다시 물어봐 주세요.',
    'ask.offline': '인터넷 연결을 확인해주세요.',
    'ask.notInDocument': '※ 이 문서에 적힌 내용은 아니에요. 정확한 것은 해당 기관에 확인해주세요.',
    'history.noDetail': '이 기록은 예전 방식으로 저장되어 다시 볼 수 없어요.',
    'history.noPhoto': '이 기록의 사진은 다시 보여드릴 수 없어요.<br>아래 내용은 그때 분석한 결과 그대로예요.',
    'docCollect.title': '찍은 사진',
    'docCollect.count': '{n}장을 찍으셨어요.',
    'docCollect.hint': '여러 장을 찍으셔도 됩니다. 같은 문서의 앞뒤든, 서로 다른 문서든 알아서 구분해 드려요.',
    'docCollect.addMore': '사진 더 찍기',
    'docCollect.analyze': '분석하기',
    'docCollect.remove': '이 사진 지우기',
    'docCollect.voice': '사진을 더 찍으시거나, 다 찍으셨으면 분석하기를 눌러주세요.',
    'docChoice.photoLimit': '사진은 다섯 장까지 찍으실 수 있어요.',
    'result.docCountLabel': '문서 {i} / {n}',
    'result.docPrev': '이전 문서', 'result.docNext': '다음 문서',
    'result.shareNothing': '보낼 결과가 없어요.',
    'stats.safetyLabel': '보호자용 안전 확인 현황', 'stats.safetyDangerCount': '위험으로 판정된 건수', 'stats.safetyNone': '위험으로 판정된 문서·문자가 없어요.',
    'stats.thisMonth': '이번 달 고지서',
    'stats.cumulative': '달마다 쌓인 금액',
    'stats.upcoming': '다가오는 납부 기한',
    'stats.empty': '아직 금액이나 기한이 적힌 문서를 확인한 적이 없어요.<br>고지서를 촬영하면 여기에 모아서 보여드릴게요.',
    'home.disclaimer': '본 서비스는 AI 분석 결과로 참고용이며,<br>중요 문서는 전문가와 상담하시기 바랍니다.',
    'nav.home': '홈', 'nav.info': '정보', 'nav.help': '도움', 'nav.history': '기록', 'nav.settings': '설정',
    'info.sectionTitle': '알아두면 좋은 정보',
    'info.empty': '표시할 정보를 불러오지 못했어요.<br>설정에서 사시는 지역을 입력하시면 더 많은 정보를 볼 수 있어요.',
    'settings.title': '설정',
    'settings.fontSize': '화면 글자 크기',
    'settings.fontNormal': '보통', 'settings.fontLarge': '크게', 'settings.fontXLarge': '아주 크게',
    'settings.voiceSpeed': '음성 읽기 속도',
    'settings.rate05': '0.5배속', 'settings.rate1': '1배속', 'settings.rate15': '1.5배속', 'settings.rate2': '2배속',
    'settings.replay': '다시 읽기', 'settings.stop': '멈추기',
    'settings.voiceEnable': '음성 안내 사용하기',
    'settings.accountTitle': '계정', 'settings.logout': '로그아웃',
    'settings.myInfo': '내 정보 (맞춤 안내용, 선택 사항)',
    'settings.nameLabel': '이름', 'settings.namePlaceholder': '예: 홍길동',
    'settings.male': '남성', 'settings.female': '여성',
    'settings.age60': '60대', 'settings.age70': '70대', 'settings.age80': '80대 이상',
    'settings.regionLabel': '사시는 지역', 'settings.regionPlaceholder': '예: 경기도 안산시 상록구',
    'settings.myInfoNote': '문서·문자를 분석할 때 이 정보를 함께 참고해서 더 알맞게 설명해드려요. 다른 곳에 공유되지 않습니다.',
    'settings.guardian': '보호자 정보',
    'settings.guardianNameLabel': '보호자 이름', 'settings.guardianNamePlaceholder': '예: 김민수 (아들)',
    'settings.guardianPhoneLabel': '보호자 전화번호', 'settings.guardianPhonePlaceholder': '예: 010-1234-5678',
    'settings.autoNotify': '🔴 위험 문자를 발견하면 보호자에게 알릴지 물어보기',
    'settings.guardianHowNote': '보호자에게 알릴 때는 이 기기의 문자 앱이 열리고, 내용이 미리 채워집니다. 보내기는 직접 눌러주세요 — 앱이 대신 문자를 보내지는 않습니다.',
    'settings.guardianNote': '모든 설정은 이 기기에 자동 저장되어, 앱을 새로고침해도 유지됩니다.',
    'guardian.needPhone': '보호자 전화번호가 아직 없어요. 아래에 번호를 적어주세요.',
    'guardian.smsOpened': '문자 앱을 열었어요. 내용을 확인하고 전송을 눌러주세요.',
    'guardian.registerHint': '보호자 전화번호를 등록하면 위험한 문자를 바로 알릴 수 있어요.',
    'guardian.askOnDanger': '위험한 문자예요. 보호자에게 알리시겠어요? 위 버튼을 누르면 문자 앱이 열립니다.',
    'guardian.historySmsOpen': '🔔 보호자에게 알리기 (문자 앱 열기)',
    'emergency.phoneAsk': '보호자 전화번호를 적어주세요.',
    'emergency.phonePlaceholder': '예: 010-1234-5678',
    'emergency.phoneInvalid': '전화번호가 짧아요. 숫자를 9자리 이상 적어주세요.',
    'emergency.phoneSaveCall': '저장하고 전화걸기',
    'emergency.phoneSaveSms': '저장하고 문자 앱 열기',
    'help.settingsGuardian': '보호자 이름·전화번호를 등록하면, 위험한 문자를 확인했을 때 문자 앱을 열어 알릴 수 있어요',
    'settings.language': '언어 설정',
    'settings.languageNote': '경기도 거주 외국인주민 중 비중이 높은 4개 언어를 지원합니다(중국·베트남·태국·우즈베키스탄, 공공통계 기준 상위 국적). 화면 핵심 문구만 번역되며, AI 분석 결과는 정확성을 위해 한국어로 제공됩니다.',
    'settings.support': '고객 지원',
    'settings.supportHelp': '사용 방법 안내',
    'settings.supportOnboarding': '화면 안내(첫 실행 안내) 다시 보기',
    'settings.supportCenter': '고객센터 연결',
    'onboard.replay': '다시 듣기', 'onboard.skip': '건너뛰기',
    'onboard.greet.title': '안녕하세요!<br>AI 디지털 도우미 <span class="accent-ink">온담(OnDam)</span>입니다.',
    'onboard.greet.desc': '복잡한 공문서와 납부 고지서를 대신 읽고<br>꼭 하셔야 할 일을 쉽게 정리해 드립니다.',
    'onboard.greet.start': '온담 시작하기',
    'onboard.greet.voice': '안녕하세요. AI 디지털 도우미입니다. 실제 화면을 보여드리며 사용 방법을 간단히 안내해드릴게요.',
    'onboard.signup.title': '회원가입', 'onboard.signup.desc': '전화번호와 비밀번호로 계정을 만들어요.<br>이 계정으로 다른 기기에서도 내 정보를 이어서 쓸 수 있어요.',
    'onboard.signup.phoneLabel': '전화번호',
    'onboard.signup.pinLabel': '비밀번호', 'onboard.signup.pinPlaceholder': '비밀번호 입력', 'onboard.signup.pinConfirmPlaceholder': '비밀번호 다시 입력',
    'onboard.signup.submit': '가입하기', 'onboard.signup.toLogin': '이미 계정이 있으신가요? 로그인하기',
    'onboard.signup.errorPhone': '전화번호를 다시 확인해주세요', 'onboard.signup.errorPinFormat': '비밀번호는 숫자 4자리로 입력해주세요',
    'onboard.signup.errorPinMismatch': '입력하신 비밀번호가 서로 달라요', 'onboard.signup.errorPhoneExists': '이미 가입된 전화번호예요. 로그인해주세요',
    'onboard.signup.errorGeneric': '가입에 실패했어요. 잠시 후 다시 시도해주세요',
    'onboard.login.title': '로그인', 'onboard.login.desc': '가입할 때 쓴 전화번호와 비밀번호를 입력해주세요.',
    'onboard.login.submit': '로그인', 'onboard.login.toSignup': '계정이 없으신가요? 회원가입',
    'onboard.login.errorInvalid': '전화번호 또는 비밀번호가 올바르지 않습니다', 'onboard.login.errorLocked': '너무 여러 번 틀렸어요. 15분 후 다시 시도해주세요',
    'onboard.login.forgotPin': '비밀번호를 잊으셨나요?',
    'onboard.signup.voice': '이름과 전화번호, 비밀번호를 입력해서 가입해주세요.',
    'onboard.login.voice': '전화번호와 비밀번호를 입력해서 로그인해주세요.',
    'onboard.resetPin.title': '비밀번호 재설정', 'onboard.resetPin.desc': '가입할 때 쓴 이름과 전화번호를 입력하면 인증번호를 문자로 보내드려요.',
    'onboard.resetPin.requestOtp': '인증번호 받기', 'onboard.resetPin.otpLabel': '인증번호 (6자리)', 'onboard.resetPin.submit': '재설정하기',
    'onboard.resetPin.otpSentNotice': '인증번호를 보냈습니다', 'onboard.resetPin.errorSmsFailed': '문자 발송에 실패했어요. 잠시 후 다시 시도해주세요',
    'onboard.resetPin.errorOtpExpired': '인증번호가 만료됐어요. 다시 받아주세요', 'onboard.resetPin.errorOtpLocked': '너무 여러 번 틀렸어요. 처음부터 다시 시도해주세요',
    'onboard.resetPin.errorOtpInvalid': '인증번호가 올바르지 않습니다 ({n}회 남음)',
    'onboard.resetPin.successNotice': '비밀번호가 재설정됐어요. 새 비밀번호로 로그인해주세요.',
    'onboard.resetPin.voice': '이름과 전화번호를 입력하면 인증번호를 문자로 보내드려요.',
    'onboard.profile.title': '몇 가지만<br>알려주시겠어요?',
    'onboard.access.title': '몇 가지만<br>알려주시겠어요?', 'onboard.access.desc': '원하지 않으면 건너뛰어도 됩니다.',
    'onboard.access.voice': '화면 글자 크기와 음성 읽기 속도, 언어를 미리 맞춰두실 수 있어요. 원하지 않으면 건너뛰어도 됩니다.',
    'onboard.profile.desc': '입력하신 정보는 이 기기와 안전한 서버에만 저장되고,<br>더 알맞은 설명을 드리는 데만 사용돼요.',
    'onboard.profile.genderLabel': '성별', 'onboard.profile.ageLabel': '나이',
    'onboard.profile.agePlaceholder': '예: 73', 'onboard.profile.ageNote': '만 나이를 숫자로 적어주세요. 나이에 따라 받을 수 있는 혜택이 달라요.',
    'skipConfirm.title': '튜토리얼을 건너뛸까요?', 'skipConfirm.keep': '계속 보기',
    'onboard.profile.useLocation': '내 현재 위치 입력하기',
    'onboard.profile.regionNote': '시/군/구까지 자세히 적어주시면 더 알맞은 정보를 드릴 수 있어요.',
    'onboard.profile.next': '다음',
    'onboard.profile.voice': '이름과 성별, 연령대, 사시는 지역을 알려주시면 더 맞춤형으로 도와드릴 수 있어요.',
    'onboard.guardian.title': '자녀(보호자) 정보도<br>알려주시겠어요?',
    'onboard.guardian.desc': '위험한 문자를 받았을 때 자녀에게 바로 알리거나,<br>긴급 도움 버튼으로 전화를 걸 때 사용돼요.',
    'onboard.guardian.voice': '급한 일이 있을 때 알릴 자녀나 보호자의 이름과 전화번호를 알려주시겠어요? 원하지 않으면 건너뛰어도 됩니다.',
    'common.home': '← 홈으로', 'common.back': '← 뒤로',
    'docChoice.title': 'AI 분석하기',
    'docChoice.desc': '분석하고 싶은 문서를 촬영하거나 사진첩에서 불러오세요.',
    'docChoice.voicePill': '음성 안내 다시 듣기',
    'docChoice.cameraTitle': '사진 촬영하기', 'docChoice.cameraDesc': '카메라로 문서를 찍습니다',
    'docChoice.galleryTitle': '사진 불러오기', 'docChoice.galleryDesc': '저장된 사진을 불러옵니다',
    'docChoice.tipTitle': '꼭 확인해 주세요!',
    'docChoice.tip1': '문서의 글자가 선명하게 보이도록 촬영해 주세요.',
    'docChoice.tip2': '빛 반사가 적은 밝은 곳에서 촬영하면 더 정확합니다.',
    'docChoice.voice': '사진 촬영하기, 사진 불러오기 중에서 골라주세요.',
    'docCapture.inProgress': '🔵 진행 중',
    'docCapture.guide': '문서를 화면 가운데<br>오도록 맞춰주세요',
    'docCapture.caption': '👆 촬영 버튼을 눌러주세요',
    'docCapture.blurExample': '사진이 흐릿하게 나왔다면? (예시 보기)',
    'docCapture.voice': '문서가 화면 가운데 오도록 맞춘 다음, 아래 버튼을 눌러 촬영해주세요.',
    'loadingDoc.headline': 'AI가 문서를 읽고,<br />그림도 함께 준비하고 있습니다',
    'loadingText.headline': 'AI가 문자를 확인하고,<br />그림도 함께 준비하고 있습니다',
    'result.docTitle': '분석 결과', 'result.readAloud': '큰 소리로 읽어주기',
    'result.translateFailNotice': '번역을 실패했습니다. 다시 시도하시겠습니까?', 'result.translateFailRetry': '다시 시도',
    'result.docKind': '문서 종류', 'result.viewPhoto': '사진 보기',
    'result.amountLabel': '납부할 금액', 'result.dueLabel': '납부 기한',
    'result.aiSummaryTitle': '⚪ AI가 정리한 내용',
    'result.todoLabel': '해야 할 일',
    'result.actionPhone': '전화하기', 'result.actionWebsite': '홈페이지', 'result.actionMap': '길찾기',
    'result.shareTitle': '공유하기', 'result.shareSms': '문자', 'result.shareKakao': '💛 카카오톡', 'result.shareCopy': '복사하기',
    'result.docConfirm': '확인 완료',
    'result.textTitle': '진위 판별 결과', 'result.dangerPill': '⚠ 위험 감지', 'result.listenVoice': '음성으로 듣기',
    'result.reasonLabel': '왜 위험한가요?',
    'result.notifyGuardian': '보호자에게 문자 전달하기',
    'result.checkAnotherSms': '다른 문자 확인하기',
    'result.riskFactorsTitle': '🔴 위험 문자 요소', 'result.report118': '118 신고(경찰청 신고)', 'result.askSms': '이 문자에 대해 물어보기',
    'result.legalNote': '본 판별은 인공지능 분석 결과이므로 법적 효력이 없습니다.<br>의심스러운 경우 반드시 관계 기관에 직접 문의하세요.',
    'result.textConfirm': '확인했습니다', 'result.practiceAgain': '연습 다시 하기',
    'sms.permission.voice': '문자 확인을 하려면 문자 읽기 권한이 필요해요.',
    'sms.permission.title': '문자 확인을 하려면<br>문자 읽기 권한이 필요해요.',
    'sms.permission.desc': '확인을 누른 문자만 서버로 보내 분석해요.<br>다른 문자는 읽지 않아요.',
    'sms.permission.unsupportedTitle': '이 기능은<br>안드로이드 앱에서만 사용할 수 있어요.',
    'sms.permission.unsupportedDesc': '이 기기·브라우저에서는<br>문자를 직접 불러올 수 없어요.',
    'sms.permission.retry': '다시 시도',
    'sms.permission.openSettings': '앱 설정에서 허용하기',
    'sms.recent.voice': '최근 문자 목록을 가져왔어요. 확인하고 싶은 문자를 눌러주세요.',
    'sms.recent.title': '최근 문자',
    'sms.recent.desc': '최근 문자를 가져왔어요. 확인하고 싶은 문자를 눌러주세요.',
    'sms.recent.empty': '받은 문자가 없어요.',
    'sms.recent.loading': '문자를 불러오는 중이에요...',
    'sms.recent.unknownSender': '알 수 없는 발신자',
    'emergency.title': '긴급 도움', 'emergency.guardian': '보호자',
    'emergency.howToAgain': '사용법 다시 보기', 'emergency.close': '닫기',
    'error.docBlurTitle': '사진이 흐려요.',
    'error.docBlurDesc': '글씨가 잘 보이지 않아요.<br>밝은 곳에서 다시 찍어주세요.',
    'error.docBlurHint': '💡 문서를 평평하게 놓고, 그림자가 생기지 않도록 밝은 곳에서 찍으면 더 잘 인식돼요.',
    'error.retakePhoto': '다시 찍기', 'error.pickGallery': '갤러리에서 선택하기',
    'error.docBlurVoice': '사진이 흐려서 읽을 수 없어요. 밝은 곳에서 다시 찍어주세요.',
    'error.retry': '다시 시도', 'error.goHome': '홈으로 돌아가기',
    'error.aiVoice': '지금은 분석이 어려워요. 잠시 후 다시 시도해주세요.',
  },
  zh: {
    'home.sectionTitle': '需要什么帮助？',
    'home.assistantActive': '온담 助手已启用', 'home.assistantInactive': '온담 助手已停用',
    'home.greetDefault': '您好',
    'home.greetNameSuffix': '', 'home.greetAge': '{age}多岁的您', 'home.greetAgeGender': '{age}多岁的{gender}士',
    'home.docCaptureTitle': '文件拍摄',
    'home.docCaptureDesc': '拍摄或导入照片，AI会为您简单说明',
    'home.smsCheckTitle': '短信内容摘要',
    'home.smsCheckDesc': 'AI帮您确认收到的短信是否安全',
    'home.welfareTitle': '附近福利中心·老人活动中心',
    'home.moreMenu': '更多',
    'home.moreNameLabel': '姓名 :', 'home.moreAgeLabel': '年龄', 'home.moreGenderLabel': '性别', 'home.moreRegionLabel': '地区', 'home.moreAgeUnit': '岁',
    'home.moreMyInfo': '我的信息', 'home.moreHistory': '分析记录', 'home.moreStats': '统计',
    'home.welfareDesc': '为您查找所在位置附近的福利中心、老人活动中心',
    'home.todayTasks': '今天要做的事',
    'home.viewAll': '查看全部',
    'home.noTasksToday': '今天没有要做的事。',
    'home.publicInfoDefault': '需要了解的信息',
    'home.infoMore': '查看更多信息',
    'home.dueTitle': '即将要缴纳的',
    'home.dueMore': '查看全部统计',
    'stats.title': '缴费单统计',
    'result.share': '发送给子女',
    'result.ask': '询问关于这份文件',
    'ask.title': '提问',
    'ask.voice': '请点击想了解的内容，或直接输入。',
    'ask.suggested': '您可以这样提问',
    'ask.placeholder': '直接提问',
    'ask.send': '提问',
    'ask.note': '我们会根据这份文件上写的内容回答。文件上没有的内容会如实告知。',
    'ask.thinking': '正在思考...',
    'ask.failed': '现在难以给出答复。请稍后再问。',
    'ask.offline': '请检查网络连接。',
    'ask.notInDocument': '※ 这不是文件上写的内容。准确信息请向相关机构确认。',
    'history.noDetail': '这条记录是以旧方式保存的，无法再次查看详情。',
    'history.noPhoto': '无法再次显示这条记录的照片。<br>以下内容是当时分析的结果。',
    'docCollect.title': '已拍摄的照片',
    'docCollect.count': '已拍摄{n}张。',
    'docCollect.hint': '可以拍多张。无论是同一份文件的正反面，还是不同的文件，我们都会自动区分。',
    'docCollect.addMore': '再拍一张',
    'docCollect.analyze': '开始分析',
    'docCollect.remove': '删除这张照片',
    'docCollect.voice': '可以继续拍照，拍完后请点击开始分析。',
    'docChoice.photoLimit': '照片最多可以拍五张。',
    'result.docCountLabel': '文件 {i} / {n}',
    'result.docPrev': '上一份文件', 'result.docNext': '下一份文件',
    'result.shareNothing': '没有可发送的结果。',
    'stats.safetyLabel': '监护人安全确认现况', 'stats.safetyDangerCount': '被判定为危险的件数', 'stats.safetyNone': '没有被判定为危险的文件或短信。',
    'stats.thisMonth': '本月缴费单',
    'stats.cumulative': '每月累计金额',
    'stats.upcoming': '临近的缴纳期限',
    'stats.empty': '还没有确认过记有金额或期限的文件。<br>拍摄缴费单后就会汇总显示在这里。',
    'home.disclaimer': '本服务为AI分析结果，仅供参考，<br>重要文件请咨询专业人士。',
    'nav.home': '主页', 'nav.info': '信息', 'nav.help': '帮助', 'nav.history': '记录', 'nav.settings': '设置',
    'info.sectionTitle': '需要了解的信息',
    'info.empty': '无法加载要显示的信息。<br>在设置中输入您居住的地区，可以查看更多信息。',
    'settings.title': '设置',
    'settings.fontSize': '屏幕字体大小',
    'settings.fontNormal': '普通', 'settings.fontLarge': '大', 'settings.fontXLarge': '特大',
    'settings.voiceSpeed': '语音朗读速度',
    'settings.rate05': '0.5倍速', 'settings.rate1': '1倍速', 'settings.rate15': '1.5倍速', 'settings.rate2': '2倍速',
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
    'settings.autoNotify': '🔴 发现危险短信时询问是否通知监护人',
    'settings.guardianHowNote': '通知监护人时，会打开本机的短信应用并预先填好内容。发送请您亲自点击 — 本应用不会代替您发送短信。',
    'settings.guardianNote': '所有设置都会自动保存在此设备上，刷新应用后仍会保留。',
    'guardian.needPhone': '还没有监护人电话号码。请在下方填写号码。',
    'guardian.smsOpened': '已打开短信应用。请确认内容后点击发送。',
    'guardian.registerHint': '登记监护人电话号码后，发现危险短信可立即告知。',
    'guardian.askOnDanger': '这是危险短信。要通知监护人吗？点击上方按钮即可打开短信应用。',
    'guardian.historySmsOpen': '🔔 通知监护人（打开短信应用）',
    'emergency.phoneAsk': '请填写监护人电话号码。',
    'emergency.phonePlaceholder': '例：010-1234-5678',
    'emergency.phoneInvalid': '号码太短了。请输入至少9位数字。',
    'emergency.phoneSaveCall': '保存并拨打电话',
    'emergency.phoneSaveSms': '保存并打开短信应用',
    'help.settingsGuardian': '登记监护人姓名和电话号码后，确认到危险短信时可打开短信应用告知对方',
    'settings.language': '语言设置',
    'settings.languageNote': '支持京畿道外国居民中比例较高的4种语言（中文·越南语·泰语·乌兹别克语，依公共统计数据）。仅翻译核心画面文字，AI分析结果为确保准确性，始终以韩语提供。',
    'settings.support': '客户支持',
    'settings.supportHelp': '使用方法说明',
    'settings.supportOnboarding': '重新查看画面指南（首次使用指南）',
    'settings.supportCenter': '联系客服中心',
    'onboard.replay': '再听一次', 'onboard.skip': '跳过',
    'onboard.greet.title': '您好！<br>AI数字助手 <span class="accent-ink">온담(OnDam)</span>。',
    'onboard.greet.desc': '帮您读懂复杂的公文和缴费通知单，<br>并把必须要做的事整理得清清楚楚。',
    'onboard.greet.start': '开始使用 OnDam',
    'onboard.greet.voice': '您好。我是AI数字助手。我会通过实际画面简单介绍使用方法。',
    'onboard.profile.title': '请告诉我<br>几项信息好吗？',
    'onboard.access.title': '请告诉我<br>几项信息好吗？', 'onboard.access.desc': '如果不需要,可以跳过。',
    'onboard.access.voice': '您可以先设置好屏幕字体大小、语音朗读速度和语言。如果不需要,可以跳过。',
    'onboard.profile.desc': '您输入的信息只保存在本设备和安全的服务器中，<br>仅用于提供更合适的说明。',
    'onboard.profile.genderLabel': '性别', 'onboard.profile.ageLabel': '年龄',
    'onboard.profile.agePlaceholder': '例: 73', 'onboard.profile.ageNote': '请填写周岁数字。可享受的福利会因年龄而异。',
    'skipConfirm.title': '要跳过教程吗？', 'skipConfirm.keep': '继续观看',
    'onboard.profile.useLocation': '输入我的当前位置',
    'onboard.profile.regionNote': '详细填写到市/郡/区，可以为您提供更合适的信息。',
    'onboard.profile.next': '下一步',
    'onboard.profile.voice': '请告诉我姓名、性别、年龄段、居住地区，我可以为您提供更贴心的帮助。',
    'common.home': '← 返回主页', 'common.back': '← 返回',
    'docChoice.title': 'AI分析',
    'docChoice.desc': '请拍摄想要分析的文件，或从相册中选择。',
    'docChoice.voicePill': '重新收听语音讲解',
    'docChoice.cameraTitle': '拍摄照片', 'docChoice.cameraDesc': '用相机拍摄文件',
    'docChoice.galleryTitle': '导入照片', 'docChoice.galleryDesc': '载入已保存的照片',
    'docChoice.tipTitle': '请务必确认！',
    'docChoice.tip1': '请拍摄时让文件上的字清晰可见。',
    'docChoice.tip2': '在反光少的明亮处拍摄会更准确。',
    'docChoice.voice': '请选择拍摄照片或导入照片。',
    'docCapture.inProgress': '🔵 进行中',
    'docCapture.guide': '请将文件对准<br>屏幕中央',
    'docCapture.caption': '👆 请按拍摄按钮',
    'docCapture.blurExample': '照片拍模糊了怎么办？（查看示例）',
    'docCapture.voice': '请将文件对准屏幕中央，然后按下方按钮拍摄。',
    'loadingDoc.headline': 'AI正在阅读文件，<br />同时也在准备插图',
    'loadingText.headline': 'AI正在确认短信，<br />同时也在准备插图',
    'result.docTitle': '分析结果', 'result.readAloud': '大声朗读',
    'result.translateFailNotice': '翻译失败了。要重试吗?', 'result.translateFailRetry': '重试',
    'result.docKind': '文件种类', 'result.viewPhoto': '查看照片',
    'result.amountLabel': '应缴金额', 'result.dueLabel': '缴纳期限',
    'result.aiSummaryTitle': '⚪ AI整理的内容',
    'result.todoLabel': '要做的事',
    'result.actionPhone': '拨打电话', 'result.actionWebsite': '官方网站', 'result.actionMap': '查找路线',
    'result.shareTitle': '分享', 'result.shareSms': '短信', 'result.shareKakao': '💛 KakaoTalk', 'result.shareCopy': '复制',
    'result.docConfirm': '确认完成',
    'result.textTitle': '真伪判别结果', 'result.dangerPill': '⚠ 检测到危险', 'result.listenVoice': '语音收听',
    'result.reasonLabel': '为什么危险？',
    'result.notifyGuardian': '转发短信给监护人',
    'result.checkAnotherSms': '确认其他短信',
    'result.riskFactorsTitle': '🔴 危险短信要素', 'result.report118': '118举报(向警察厅举报)', 'result.askSms': '询问这条短信',
    'result.legalNote': '本判别为人工智能分析结果，不具有法律效力。<br>如有可疑之处，请务必直接向相关机构咨询。',
    'result.textConfirm': '我知道了', 'result.practiceAgain': '重新练习',
    'sms.permission.voice': '要确认短信，需要短信读取权限。',
    'sms.permission.title': '要确认短信，<br>需要短信读取权限。',
    'sms.permission.desc': '只会把您点击确认的短信发送到服务器分析。<br>不会读取其他短信。',
    'sms.permission.unsupportedTitle': '此功能<br>仅支持安卓应用。',
    'sms.permission.unsupportedDesc': '此设备/浏览器<br>无法直接读取短信。',
    'sms.permission.retry': '重试',
    'sms.permission.openSettings': '在应用设置中允许',
    'sms.recent.voice': '已获取最近的短信列表。请点击想确认的短信。',
    'sms.recent.title': '最近短信',
    'sms.recent.desc': '已获取最近的短信。请点击想确认的短信。',
    'sms.recent.empty': '没有收到的短信。',
    'sms.recent.loading': '正在加载短信...',
    'sms.recent.unknownSender': '未知发件人',
    'emergency.title': '紧急求助', 'emergency.guardian': '监护人',
    'emergency.howToAgain': '重新查看使用方法', 'emergency.close': '关闭',
    'error.docBlurTitle': '照片模糊了。',
    'error.docBlurDesc': '字看不清楚。<br>请在明亮的地方重新拍摄。',
    'error.docBlurHint': '💡 把文件放平，在明亮且不产生阴影的地方拍摄，识别效果会更好。',
    'error.retakePhoto': '重新拍摄', 'error.pickGallery': '从相册选择',
    'error.docBlurVoice': '照片太模糊，无法读取。请在明亮的地方重新拍摄。',
    'error.retry': '重试', 'error.goHome': '返回主页',
    'error.aiVoice': '现在暂时无法分析。请稍后再试。',
  },
  vi: {
    'home.sectionTitle': 'Bạn cần giúp gì?',
    'home.assistantActive': 'Trợ lý 온담 đã được kích hoạt', 'home.assistantInactive': 'Trợ lý 온담 đã bị tắt',
    'home.greetDefault': 'Cô/Chú',
    'home.greetNameSuffix': '', 'home.greetAge': 'Cô/Chú khoảng {age} tuổi', 'home.greetAgeGender': '{gender} khoảng {age} tuổi',
    'home.docCaptureTitle': 'Chụp tài liệu',
    'home.docCaptureDesc': 'Chụp hoặc tải ảnh lên, AI sẽ giải thích dễ hiểu cho bạn',
    'home.smsCheckTitle': 'Tóm tắt nội dung tin nhắn',
    'home.smsCheckDesc': 'AI sẽ xác nhận giúp bạn tin nhắn nhận được có an toàn không',
    'home.welfareTitle': 'Tìm trung tâm phúc lợi và nhà sinh hoạt người cao tuổi',
    'home.moreMenu': 'Xem thêm',
    'home.moreNameLabel': 'Tên :', 'home.moreAgeLabel': 'Tuổi', 'home.moreGenderLabel': 'Giới tính', 'home.moreRegionLabel': 'Khu vực', 'home.moreAgeUnit': ' tuổi',
    'home.moreMyInfo': 'Thông tin của tôi', 'home.moreHistory': 'Lịch sử phân tích', 'home.moreStats': 'Thống kê',
    'home.welfareDesc': 'Tìm trung tâm phúc lợi, nhà sinh hoạt người cao tuổi gần vị trí của bạn',
    'home.todayTasks': 'Việc cần làm hôm nay',
    'home.viewAll': 'Xem tất cả',
    'home.noTasksToday': 'Hôm nay không có việc cần làm.',
    'home.publicInfoDefault': 'Thông tin nên biết',
    'home.infoMore': 'Xem thêm thông tin',
    'home.dueTitle': 'Sắp phải nộp',
    'home.dueMore': 'Xem toàn bộ thống kê',
    'stats.title': 'Thống kê hóa đơn',
    'result.share': 'Gửi cho con cái',
    'result.ask': 'Hỏi về tài liệu này',
    'ask.title': 'Hỏi đáp',
    'ask.voice': 'Hãy bấm vào điều bạn thắc mắc hoặc tự nhập câu hỏi.',
    'ask.suggested': 'Bạn có thể hỏi như thế này',
    'ask.placeholder': 'Tự nhập câu hỏi',
    'ask.send': 'Hỏi',
    'ask.note': 'Chúng tôi trả lời dựa trên nội dung ghi trong tài liệu này. Nếu tài liệu không có, chúng tôi sẽ nói rõ.',
    'ask.thinking': 'Đang suy nghĩ...',
    'ask.failed': 'Hiện chưa thể trả lời. Xin hỏi lại sau ít phút.',
    'ask.offline': 'Xin kiểm tra kết nối mạng.',
    'ask.notInDocument': '※ Đây không phải nội dung ghi trong tài liệu. Xin xác nhận chính xác với cơ quan liên quan.',
    'history.noDetail': 'Bản ghi này được lưu theo cách cũ nên không thể xem lại chi tiết.',
    'history.noPhoto': 'Không thể hiển thị lại ảnh của bản ghi này.<br>Nội dung dưới đây là kết quả phân tích lúc đó.',
    'docCollect.title': 'Ảnh đã chụp',
    'docCollect.count': 'Bạn đã chụp {n} ảnh.',
    'docCollect.hint': 'Bạn có thể chụp nhiều ảnh. Dù là mặt trước sau của cùng một tài liệu hay các tài liệu khác nhau, chúng tôi sẽ tự phân biệt.',
    'docCollect.addMore': 'Chụp thêm ảnh',
    'docCollect.analyze': 'Phân tích',
    'docCollect.remove': 'Xóa ảnh này',
    'docCollect.voice': 'Bạn có thể chụp thêm, hoặc bấm Phân tích khi đã chụp xong.',
    'docChoice.photoLimit': 'Bạn có thể chụp tối đa năm ảnh.',
    'result.docCountLabel': 'Tài liệu {i} / {n}',
    'result.docPrev': 'Tài liệu trước', 'result.docNext': 'Tài liệu sau',
    'result.shareNothing': 'Không có kết quả để gửi.',
    'stats.safetyLabel': 'Tình trạng xác nhận an toàn dành cho người giám hộ', 'stats.safetyDangerCount': 'Số trường hợp được đánh giá nguy hiểm', 'stats.safetyNone': 'Không có tài liệu/tin nhắn nào được đánh giá là nguy hiểm.',
    'stats.thisMonth': 'Hóa đơn tháng này',
    'stats.cumulative': 'Số tiền tích lũy theo tháng',
    'stats.upcoming': 'Hạn nộp sắp tới',
    'stats.empty': 'Bạn chưa kiểm tra tài liệu nào có ghi số tiền hay hạn nộp.<br>Hãy chụp hóa đơn, chúng tôi sẽ tổng hợp tại đây.',
    'home.disclaimer': 'Dịch vụ này chỉ mang tính tham khảo (kết quả phân tích AI),<br>hãy hỏi chuyên gia với tài liệu quan trọng.',
    'nav.home': 'Trang chủ', 'nav.info': 'Thông tin', 'nav.help': 'Trợ giúp', 'nav.history': 'Lịch sử', 'nav.settings': 'Cài đặt',
    'info.sectionTitle': 'Thông tin nên biết',
    'info.empty': 'Không tải được thông tin để hiển thị.<br>Nhập khu vực bạn đang sống trong Cài đặt để xem thêm thông tin.',
    'settings.title': 'Cài đặt',
    'settings.fontSize': 'Cỡ chữ màn hình',
    'settings.fontNormal': 'Vừa', 'settings.fontLarge': 'Lớn', 'settings.fontXLarge': 'Rất lớn',
    'settings.voiceSpeed': 'Tốc độ đọc giọng nói',
    'settings.rate05': 'Tốc độ 0.5x', 'settings.rate1': 'Tốc độ 1x', 'settings.rate15': 'Tốc độ 1.5x', 'settings.rate2': 'Tốc độ 2x',
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
    'settings.autoNotify': '🔴 Hỏi có báo cho người giám hộ khi phát hiện tin nhắn nguy hiểm không',
    'settings.guardianHowNote': 'Khi báo cho người giám hộ, ứng dụng tin nhắn của máy sẽ mở ra với nội dung điền sẵn. Bạn hãy tự bấm gửi — ứng dụng không tự gửi tin nhắn thay bạn.',
    'settings.guardianNote': 'Mọi cài đặt được tự động lưu trên thiết bị này, vẫn giữ nguyên dù tải lại ứng dụng.',
    'guardian.needPhone': 'Chưa có số điện thoại người giám hộ. Xin nhập số ở bên dưới.',
    'guardian.smsOpened': 'Đã mở ứng dụng tin nhắn. Xin kiểm tra nội dung rồi bấm gửi.',
    'guardian.registerHint': 'Đăng ký số điện thoại người giám hộ để báo ngay khi gặp tin nhắn nguy hiểm.',
    'guardian.askOnDanger': 'Đây là tin nhắn nguy hiểm. Bạn có muốn báo cho người giám hộ không? Bấm nút ở trên để mở ứng dụng tin nhắn.',
    'guardian.historySmsOpen': '🔔 Báo cho người giám hộ (mở ứng dụng tin nhắn)',
    'emergency.phoneAsk': 'Vui lòng nhập số điện thoại người giám hộ.',
    'emergency.phonePlaceholder': 'VD: 010-1234-5678',
    'emergency.phoneInvalid': 'Số điện thoại quá ngắn. Hãy nhập ít nhất 9 chữ số.',
    'emergency.phoneSaveCall': 'Lưu và gọi ngay',
    'emergency.phoneSaveSms': 'Lưu và mở ứng dụng tin nhắn',
    'help.settingsGuardian': 'Đăng ký tên và số điện thoại người giám hộ để có thể mở ứng dụng tin nhắn báo tin khi gặp tin nhắn nguy hiểm',
    'settings.language': 'Cài đặt ngôn ngữ',
    'settings.languageNote': 'Hỗ trợ 4 ngôn ngữ có tỷ lệ cư dân nước ngoài cao ở Gyeonggi (Trung·Việt·Thái·Uzbek, theo thống kê công). Chỉ dịch các cụm từ chính trên màn hình, kết quả phân tích AI luôn bằng tiếng Hàn để đảm bảo chính xác.',
    'settings.support': 'Hỗ trợ khách hàng',
    'settings.supportHelp': 'Hướng dẫn sử dụng',
    'settings.supportOnboarding': 'Xem lại hướng dẫn màn hình (hướng dẫn lần đầu)',
    'settings.supportCenter': 'Kết nối trung tâm hỗ trợ',
    'onboard.replay': 'Nghe lại', 'onboard.skip': 'Bỏ qua',
    'onboard.greet.title': 'Xin chào!<br>Tôi là trợ lý số AI <span class="accent-ink">온담(OnDam)</span>.',
    'onboard.greet.desc': 'Tôi đọc giúp bạn các công văn, hóa đơn phức tạp<br>và sắp xếp gọn gàng những việc bạn cần làm.',
    'onboard.greet.start': 'Bắt đầu với OnDam',
    'onboard.greet.voice': 'Xin chào. Tôi là trợ lý số AI. Tôi sẽ hướng dẫn cách sử dụng đơn giản qua màn hình thực tế.',
    'onboard.profile.title': 'Cho tôi biết<br>một vài thông tin nhé?',
    'onboard.access.title': 'Cho tôi biết<br>một vài thông tin nhé?', 'onboard.access.desc': 'Nếu không muốn, bạn có thể bỏ qua.',
    'onboard.access.voice': 'Bạn có thể chỉnh trước cỡ chữ màn hình, tốc độ đọc bằng giọng nói và ngôn ngữ. Nếu không muốn, bạn có thể bỏ qua.',
    'onboard.profile.desc': 'Thông tin bạn nhập chỉ được lưu trên thiết bị này và máy chủ an toàn,<br>chỉ dùng để đưa ra giải thích phù hợp hơn.',
    'onboard.profile.genderLabel': 'Giới tính', 'onboard.profile.ageLabel': 'Tuổi',
    'onboard.profile.agePlaceholder': 'VD: 73', 'onboard.profile.ageNote': 'Hãy nhập tuổi bằng số. Quyền lợi được hưởng khác nhau tùy theo tuổi.',
    'skipConfirm.title': 'Bỏ qua hướng dẫn?', 'skipConfirm.keep': 'Tiếp tục xem',
    'onboard.profile.useLocation': 'Nhập vị trí hiện tại của tôi',
    'onboard.profile.regionNote': 'Nếu ghi rõ đến quận/huyện, chúng tôi có thể cung cấp thông tin phù hợp hơn.',
    'onboard.profile.next': 'Tiếp theo',
    'onboard.profile.voice': 'Cho tôi biết tên, giới tính, độ tuổi, nơi ở để tôi giúp bạn phù hợp hơn.',
    'common.home': '← Trang chủ', 'common.back': '← Quay lại',
    'docChoice.title': 'Phân tích AI',
    'docChoice.desc': 'Hãy chụp tài liệu bạn muốn phân tích hoặc chọn từ thư viện ảnh.',
    'docChoice.voicePill': 'Nghe lại hướng dẫn bằng giọng nói',
    'docChoice.cameraTitle': 'Chụp ảnh', 'docChoice.cameraDesc': 'Chụp tài liệu bằng máy ảnh',
    'docChoice.galleryTitle': 'Tải ảnh lên', 'docChoice.galleryDesc': 'Mở ảnh đã lưu',
    'docChoice.tipTitle': 'Hãy kiểm tra nhé!',
    'docChoice.tip1': 'Hãy chụp sao cho chữ trên tài liệu hiện rõ.',
    'docChoice.tip2': 'Chụp ở nơi sáng và ít bị phản chiếu ánh sáng sẽ chính xác hơn.',
    'docChoice.voice': 'Hãy chọn chụp ảnh hoặc tải ảnh lên.',
    'docCapture.inProgress': '🔵 Đang thực hiện',
    'docCapture.guide': 'Hãy căn tài liệu<br>vào giữa màn hình',
    'docCapture.caption': '👆 Hãy nhấn nút chụp',
    'docCapture.blurExample': 'Nếu ảnh bị mờ thì sao? (Xem ví dụ)',
    'docCapture.voice': 'Hãy căn tài liệu vào giữa màn hình rồi nhấn nút bên dưới để chụp.',
    'loadingDoc.headline': 'AI đang đọc tài liệu,<br />đồng thời chuẩn bị hình minh họa',
    'loadingText.headline': 'AI đang kiểm tra tin nhắn,<br />đồng thời chuẩn bị hình minh họa',
    'result.docTitle': 'Kết quả phân tích', 'result.readAloud': 'Đọc to lên',
    'result.translateFailNotice': 'Dịch thất bại. Bạn có muốn thử lại không?', 'result.translateFailRetry': 'Thử lại',
    'result.docKind': 'Loại tài liệu', 'result.viewPhoto': 'Xem ảnh',
    'result.amountLabel': 'Số tiền phải nộp', 'result.dueLabel': 'Hạn nộp',
    'result.aiSummaryTitle': '⚪ Nội dung AI đã tóm tắt',
    'result.todoLabel': 'Việc cần làm',
    'result.actionPhone': 'Gọi điện', 'result.actionWebsite': 'Trang chủ', 'result.actionMap': 'Tìm đường',
    'result.shareTitle': 'Chia sẻ', 'result.shareSms': 'Tin nhắn', 'result.shareKakao': '💛 KakaoTalk', 'result.shareCopy': 'Sao chép',
    'result.docConfirm': 'Đã xem xong',
    'result.textTitle': 'Kết quả kiểm tra thật giả', 'result.dangerPill': '⚠ Phát hiện nguy hiểm', 'result.listenVoice': 'Nghe bằng giọng nói',
    'result.reasonLabel': 'Tại sao nguy hiểm?',
    'result.notifyGuardian': 'Chuyển tin nhắn cho người giám hộ',
    'result.checkAnotherSms': 'Kiểm tra tin nhắn khác',
    'result.riskFactorsTitle': '🔴 Yếu tố tin nhắn nguy hiểm', 'result.report118': 'Báo cáo 118 (báo cảnh sát)', 'result.askSms': 'Hỏi về tin nhắn này',
    'result.legalNote': 'Kết quả này là phân tích của trí tuệ nhân tạo nên không có hiệu lực pháp lý.<br>Nếu thấy đáng ngờ, hãy trực tiếp hỏi cơ quan liên quan.',
    'result.textConfirm': 'Tôi đã xem', 'result.practiceAgain': 'Luyện tập lại',
    'sms.permission.voice': 'Để kiểm tra tin nhắn, cần quyền đọc tin nhắn.',
    'sms.permission.title': 'Để kiểm tra tin nhắn,<br>cần quyền đọc tin nhắn.',
    'sms.permission.desc': 'Chỉ tin nhắn bạn nhấn xác nhận mới được gửi đến máy chủ để phân tích.<br>Các tin nhắn khác sẽ không được đọc.',
    'sms.permission.unsupportedTitle': 'Tính năng này<br>chỉ dùng được trên ứng dụng Android.',
    'sms.permission.unsupportedDesc': 'Thiết bị/trình duyệt này<br>không thể đọc tin nhắn trực tiếp.',
    'sms.permission.retry': 'Thử lại',
    'sms.permission.openSettings': 'Cho phép trong Cài đặt ứng dụng',
    'sms.recent.voice': 'Đã lấy danh sách tin nhắn gần đây. Hãy nhấn vào tin nhắn muốn kiểm tra.',
    'sms.recent.title': 'Tin nhắn gần đây',
    'sms.recent.desc': 'Đã lấy tin nhắn gần đây. Hãy nhấn vào tin nhắn muốn kiểm tra.',
    'sms.recent.empty': 'Không có tin nhắn nào.',
    'sms.recent.loading': 'Đang tải tin nhắn...',
    'sms.recent.unknownSender': 'Người gửi không xác định',
    'emergency.title': 'Trợ giúp khẩn cấp', 'emergency.guardian': 'Người giám hộ',
    'emergency.howToAgain': 'Xem lại cách sử dụng', 'emergency.close': 'Đóng',
    'error.docBlurTitle': 'Ảnh bị mờ.',
    'error.docBlurDesc': 'Không nhìn rõ chữ.<br>Hãy chụp lại ở nơi sáng hơn.',
    'error.docBlurHint': '💡 Đặt tài liệu phẳng và chụp ở nơi sáng, không có bóng đổ thì sẽ nhận diện tốt hơn.',
    'error.retakePhoto': 'Chụp lại', 'error.pickGallery': 'Chọn từ thư viện ảnh',
    'error.docBlurVoice': 'Ảnh bị mờ nên không đọc được. Hãy chụp lại ở nơi sáng hơn.',
    'error.retry': 'Thử lại', 'error.goHome': 'Quay về trang chủ',
    'error.aiVoice': 'Hiện tại chưa thể phân tích. Hãy thử lại sau ít phút.',
  },
  th: {
    'home.sectionTitle': 'ต้องการความช่วยเหลือเรื่องอะไร?',
    'home.assistantActive': 'ผู้ช่วย 온담 เปิดใช้งานแล้ว', 'home.assistantInactive': 'ผู้ช่วย 온담 ปิดใช้งานแล้ว',
    'home.greetDefault': 'คุณลูกค้า',
    'home.greetNameSuffix': '', 'home.greetAge': 'ผู้สูงอายุวัย {age} ปีขึ้นไป', 'home.greetAgeGender': 'ผู้สูงอายุเพศ{gender} วัย {age} ปีขึ้นไป',
    'home.docCaptureTitle': 'ถ่ายภาพเอกสาร',
    'home.docCaptureDesc': 'ถ่ายหรือนำเข้ารูปภาพ AI จะอธิบายให้เข้าใจง่าย',
    'home.smsCheckTitle': 'สรุปเนื้อหาข้อความ',
    'home.smsCheckDesc': 'AI จะช่วยตรวจสอบว่าข้อความที่ได้รับปลอดภัยหรือไม่',
    'home.welfareTitle': 'ค้นหาศูนย์สวัสดิการ·ศูนย์ผู้สูงอายุใกล้เคียง',
    'home.moreMenu': 'ดูเพิ่มเติม',
    'home.moreNameLabel': 'ชื่อ :', 'home.moreAgeLabel': 'อายุ', 'home.moreGenderLabel': 'เพศ', 'home.moreRegionLabel': 'พื้นที่', 'home.moreAgeUnit': ' ปี',
    'home.moreMyInfo': 'ข้อมูลของฉัน', 'home.moreHistory': 'ประวัติการวิเคราะห์', 'home.moreStats': 'สถิติ',
    'home.welfareDesc': 'แจ้งตำแหน่งศูนย์สวัสดิการ·ศูนย์ผู้สูงอายุใกล้ที่อยู่ของคุณ',
    'home.todayTasks': 'สิ่งที่ต้องทำวันนี้',
    'home.viewAll': 'ดูทั้งหมด',
    'home.noTasksToday': 'วันนี้ไม่มีสิ่งที่ต้องทำ',
    'home.publicInfoDefault': 'ข้อมูลที่ควรรู้',
    'home.infoMore': 'ดูข้อมูลเพิ่มเติม',
    'home.dueTitle': 'ที่ต้องชำระเร็ว ๆ นี้',
    'home.dueMore': 'ดูสถิติทั้งหมด',
    'stats.title': 'สถิติใบแจ้งหนี้',
    'result.share': 'ส่งให้ลูกหลาน',
    'result.ask': 'ถามเกี่ยวกับเอกสารนี้',
    'ask.title': 'สอบถาม',
    'ask.voice': 'กรุณากดสิ่งที่สงสัย หรือพิมพ์คำถามเอง',
    'ask.suggested': 'คุณถามแบบนี้ได้',
    'ask.placeholder': 'พิมพ์คำถามเอง',
    'ask.send': 'ถาม',
    'ask.note': 'เราตอบตามเนื้อหาที่เขียนไว้ในเอกสารนี้ หากไม่มีในเอกสารเราจะแจ้งให้ทราบ',
    'ask.thinking': 'กำลังคิด...',
    'ask.failed': 'ตอนนี้ยังตอบไม่ได้ กรุณาถามใหม่ภายหลัง',
    'ask.offline': 'กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต',
    'ask.notInDocument': '※ ไม่ใช่เนื้อหาที่เขียนในเอกสาร กรุณาตรวจสอบกับหน่วยงานที่เกี่ยวข้อง',
    'history.noDetail': 'บันทึกนี้ถูกบันทึกด้วยวิธีเดิม จึงไม่สามารถดูรายละเอียดอีกครั้งได้',
    'history.noPhoto': 'ไม่สามารถแสดงรูปภาพของบันทึกนี้อีกครั้งได้<br>เนื้อหาด้านล่างคือผลการวิเคราะห์ในตอนนั้น',
    'docCollect.title': 'รูปที่ถ่ายแล้ว',
    'docCollect.count': 'ถ่ายไปแล้ว {n} รูป',
    'docCollect.hint': 'ถ่ายได้หลายรูป ไม่ว่าจะเป็นด้านหน้าหลังของเอกสารเดียวกัน หรือเอกสารคนละฉบับ เราจะแยกให้เอง',
    'docCollect.addMore': 'ถ่ายเพิ่ม',
    'docCollect.analyze': 'วิเคราะห์',
    'docCollect.remove': 'ลบรูปนี้',
    'docCollect.voice': 'ถ่ายเพิ่มได้ หรือถ้าถ่ายครบแล้วกรุณากดวิเคราะห์',
    'docChoice.photoLimit': 'ถ่ายรูปได้สูงสุดห้ารูป',
    'result.docCountLabel': 'เอกสาร {i} / {n}',
    'result.docPrev': 'เอกสารก่อนหน้า', 'result.docNext': 'เอกสารถัดไป',
    'result.shareNothing': 'ไม่มีผลลัพธ์ที่จะส่ง',
    'stats.safetyLabel': 'สถานะการตรวจสอบความปลอดภัยสำหรับผู้ดูแล', 'stats.safetyDangerCount': 'จำนวนที่ถูกตัดสินว่าอันตราย', 'stats.safetyNone': 'ไม่มีเอกสารหรือข้อความที่ถูกตัดสินว่าอันตราย',
    'stats.thisMonth': 'ใบแจ้งหนี้เดือนนี้',
    'stats.cumulative': 'ยอดสะสมรายเดือน',
    'stats.upcoming': 'กำหนดชำระที่ใกล้เข้ามา',
    'stats.empty': 'ยังไม่เคยตรวจสอบเอกสารที่ระบุจำนวนเงินหรือกำหนดชำระ<br>ถ่ายรูปใบแจ้งหนี้แล้วเราจะรวบรวมไว้ที่นี่',
    'home.disclaimer': 'บริการนี้เป็นผลวิเคราะห์จาก AI เพื่อการอ้างอิงเท่านั้น<br>เอกสารสำคัญกรุณาปรึกษาผู้เชี่ยวชาญ',
    'nav.home': 'หน้าแรก', 'nav.info': 'ข้อมูล', 'nav.help': 'ช่วยเหลือ', 'nav.history': 'ประวัติ', 'nav.settings': 'ตั้งค่า',
    'info.sectionTitle': 'ข้อมูลที่ควรรู้',
    'info.empty': 'ไม่สามารถโหลดข้อมูลที่จะแสดงได้<br>กรอกพื้นที่ที่คุณอาศัยอยู่ในตั้งค่า เพื่อดูข้อมูลเพิ่มเติม',
    'settings.title': 'ตั้งค่า',
    'settings.fontSize': 'ขนาดตัวอักษรหน้าจอ',
    'settings.fontNormal': 'ปกติ', 'settings.fontLarge': 'ใหญ่', 'settings.fontXLarge': 'ใหญ่มาก',
    'settings.voiceSpeed': 'ความเร็วในการอ่านออกเสียง',
    'settings.rate05': 'ความเร็ว 0.5 เท่า', 'settings.rate1': 'ความเร็ว 1 เท่า', 'settings.rate15': 'ความเร็ว 1.5 เท่า', 'settings.rate2': 'ความเร็ว 2 เท่า',
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
    'settings.autoNotify': '🔴 ถามว่าจะแจ้งผู้ดูแลหรือไม่เมื่อพบข้อความอันตราย',
    'settings.guardianHowNote': 'เมื่อแจ้งผู้ดูแล แอปข้อความของเครื่องจะเปิดขึ้นพร้อมเนื้อหาที่กรอกไว้ให้แล้ว กรุณากดส่งด้วยตนเอง — แอปนี้ไม่ได้ส่งข้อความแทนคุณ',
    'settings.guardianNote': 'การตั้งค่าทั้งหมดจะถูกบันทึกอัตโนมัติในเครื่องนี้ และคงอยู่แม้รีเฟรชแอป',
    'guardian.needPhone': 'ยังไม่มีเบอร์โทรผู้ดูแล กรุณากรอกเบอร์ด้านล่าง',
    'guardian.smsOpened': 'เปิดแอปข้อความแล้ว กรุณาตรวจสอบเนื้อหาแล้วกดส่ง',
    'guardian.registerHint': 'ลงทะเบียนเบอร์โทรผู้ดูแลไว้ จะแจ้งได้ทันทีเมื่อพบข้อความอันตราย',
    'guardian.askOnDanger': 'นี่เป็นข้อความอันตราย ต้องการแจ้งผู้ดูแลไหม กดปุ่มด้านบนเพื่อเปิดแอปข้อความ',
    'guardian.historySmsOpen': '🔔 แจ้งผู้ดูแล (เปิดแอปข้อความ)',
    'emergency.phoneAsk': 'กรุณากรอกเบอร์โทรผู้ดูแล',
    'emergency.phonePlaceholder': 'เช่น 010-1234-5678',
    'emergency.phoneInvalid': 'เบอร์โทรสั้นเกินไป กรุณากรอกตัวเลขอย่างน้อย 9 หลัก',
    'emergency.phoneSaveCall': 'บันทึกและโทรออก',
    'emergency.phoneSaveSms': 'บันทึกและเปิดแอปข้อความ',
    'help.settingsGuardian': 'ลงทะเบียนชื่อและเบอร์โทรผู้ดูแลไว้ เมื่อพบข้อความอันตรายจะเปิดแอปข้อความเพื่อแจ้งได้',
    'settings.language': 'ตั้งค่าภาษา',
    'settings.languageNote': 'รองรับ 4 ภาษาของผู้พำนักต่างชาติที่มีสัดส่วนสูงในคย็องกี (จีน·เวียดนาม·ไทย·อุซเบก ตามสถิติสาธารณะ) แปลเฉพาะข้อความหลักบนหน้าจอ ส่วนผลวิเคราะห์ AI จะเป็นภาษาเกาหลีเสมอเพื่อความถูกต้อง',
    'settings.support': 'ฝ่ายบริการลูกค้า',
    'settings.supportHelp': 'คำแนะนำการใช้งาน',
    'settings.supportOnboarding': 'ดูคำแนะนำหน้าจออีกครั้ง (คำแนะนำการใช้งานครั้งแรก)',
    'settings.supportCenter': 'ติดต่อศูนย์บริการลูกค้า',
    'onboard.replay': 'ฟังอีกครั้ง', 'onboard.skip': 'ข้าม',
    'onboard.greet.title': 'สวัสดีค่ะ!<br>ฉันคือผู้ช่วยดิจิทัล AI <span class="accent-ink">온담(OnDam)</span>',
    'onboard.greet.desc': 'ช่วยอ่านเอกสารราชการและใบแจ้งชำระเงินที่ซับซ้อนแทนคุณ<br>และจัดสรุปสิ่งที่ต้องทำให้เข้าใจง่าย',
    'onboard.greet.start': 'เริ่มต้นใช้ OnDam',
    'onboard.greet.voice': 'สวัสดีค่ะ ฉันคือผู้ช่วยดิจิทัล AI จะแนะนำวิธีใช้งานง่ายๆ ผ่านหน้าจอจริง',
    'onboard.profile.title': 'ขอข้อมูล<br>สักเล็กน้อยได้ไหมคะ?',
    'onboard.access.title': 'ขอข้อมูล<br>สักเล็กน้อยได้ไหมคะ?', 'onboard.access.desc': 'หากไม่ต้องการ สามารถข้ามได้',
    'onboard.access.voice': 'คุณสามารถตั้งค่าขนาดตัวอักษรหน้าจอ ความเร็วในการอ่านออกเสียง และภาษาไว้ล่วงหน้าได้ หากไม่ต้องการ สามารถข้ามได้',
    'onboard.profile.desc': 'ข้อมูลที่กรอกจะถูกเก็บไว้ในเครื่องนี้และเซิร์ฟเวอร์ที่ปลอดภัยเท่านั้น<br>ใช้เพื่อให้คำอธิบายที่เหมาะสมยิ่งขึ้นเท่านั้น',
    'onboard.profile.genderLabel': 'เพศ', 'onboard.profile.ageLabel': 'อายุ',
    'onboard.profile.agePlaceholder': 'เช่น 73', 'onboard.profile.ageNote': 'กรุณากรอกอายุเป็นตัวเลข สิทธิประโยชน์ที่ได้รับจะต่างกันตามอายุ',
    'skipConfirm.title': 'ข้ามบทแนะนำหรือไม่?', 'skipConfirm.keep': 'ดูต่อ',
    'onboard.profile.useLocation': 'กรอกตำแหน่งปัจจุบันของฉัน',
    'onboard.profile.regionNote': 'หากระบุถึงระดับอำเภอ/เขต จะช่วยให้เราให้ข้อมูลที่เหมาะสมยิ่งขึ้น',
    'onboard.profile.next': 'ถัดไป',
    'onboard.profile.voice': 'บอกชื่อ เพศ ช่วงอายุ และที่อยู่อาศัยให้ฉันทราบ เพื่อช่วยเหลือคุณได้เหมาะสมยิ่งขึ้น',
    'common.home': '← หน้าแรก', 'common.back': '← ย้อนกลับ',
    'docChoice.title': 'วิเคราะห์ด้วย AI',
    'docChoice.desc': 'กรุณาถ่ายภาพเอกสารที่ต้องการวิเคราะห์หรือเลือกจากคลังภาพ',
    'docChoice.voicePill': 'ฟังคำแนะนำเสียงอีกครั้ง',
    'docChoice.cameraTitle': 'ถ่ายภาพ', 'docChoice.cameraDesc': 'ถ่ายเอกสารด้วยกล้อง',
    'docChoice.galleryTitle': 'นำเข้ารูปภาพ', 'docChoice.galleryDesc': 'เปิดรูปภาพที่บันทึกไว้',
    'docChoice.tipTitle': 'กรุณาตรวจสอบด้วยนะคะ!',
    'docChoice.tip1': 'กรุณาถ่ายให้ตัวอักษรในเอกสารชัดเจน',
    'docChoice.tip2': 'ถ่ายในที่สว่างและมีแสงสะท้อนน้อยจะแม่นยำกว่า',
    'docChoice.voice': 'กรุณาเลือกถ่ายภาพหรือนำเข้ารูปภาพ',
    'docCapture.inProgress': '🔵 กำลังดำเนินการ',
    'docCapture.guide': 'กรุณาจัดเอกสาร<br>ให้อยู่กลางหน้าจอ',
    'docCapture.caption': '👆 กรุณากดปุ่มถ่ายภาพ',
    'docCapture.blurExample': 'ถ้ารูปออกมาเบลอ? (ดูตัวอย่าง)',
    'docCapture.voice': 'กรุณาจัดเอกสารให้อยู่กลางหน้าจอ แล้วกดปุ่มด้านล่างเพื่อถ่ายภาพ',
    'loadingDoc.headline': 'AI กำลังอ่านเอกสาร<br />และเตรียมภาพประกอบไปพร้อมกัน',
    'loadingText.headline': 'AI กำลังตรวจสอบข้อความ<br />และเตรียมภาพประกอบไปพร้อมกัน',
    'result.docTitle': 'ผลการวิเคราะห์', 'result.readAloud': 'อ่านออกเสียงดัง',
    'result.translateFailNotice': 'แปลไม่สำเร็จ ต้องการลองใหม่ไหม?', 'result.translateFailRetry': 'ลองอีกครั้ง',
    'result.docKind': 'ประเภทเอกสาร', 'result.viewPhoto': 'ดูรูปภาพ',
    'result.amountLabel': 'จำนวนเงินที่ต้องชำระ', 'result.dueLabel': 'กำหนดชำระ',
    'result.aiSummaryTitle': '⚪ เนื้อหาที่ AI สรุปให้',
    'result.todoLabel': 'สิ่งที่ต้องทำ',
    'result.actionPhone': 'โทรออก', 'result.actionWebsite': 'เว็บไซต์', 'result.actionMap': 'ค้นหาเส้นทาง',
    'result.shareTitle': 'แชร์', 'result.shareSms': 'ข้อความ', 'result.shareKakao': '💛 KakaoTalk', 'result.shareCopy': 'คัดลอก',
    'result.docConfirm': 'ตรวจสอบเสร็จแล้ว',
    'result.textTitle': 'ผลการตรวจสอบว่าจริงหรือปลอม', 'result.dangerPill': '⚠ ตรวจพบความเสี่ยง', 'result.listenVoice': 'ฟังด้วยเสียง',
    'result.reasonLabel': 'ทำไมถึงอันตราย?',
    'result.notifyGuardian': 'ส่งต่อข้อความให้ผู้ดูแล',
    'result.checkAnotherSms': 'ตรวจสอบข้อความอื่น',
    'result.riskFactorsTitle': '🔴 องค์ประกอบข้อความอันตราย', 'result.report118': 'แจ้ง 118 (แจ้งตำรวจ)', 'result.askSms': 'ถามเกี่ยวกับข้อความนี้',
    'result.legalNote': 'ผลการตัดสินนี้เป็นผลวิเคราะห์จากปัญญาประดิษฐ์ จึงไม่มีผลทางกฎหมาย<br>หากสงสัย กรุณาสอบถามหน่วยงานที่เกี่ยวข้องโดยตรง',
    'result.textConfirm': 'รับทราบแล้ว', 'result.practiceAgain': 'ฝึกอีกครั้ง',
    'sms.permission.voice': 'การตรวจสอบข้อความต้องได้รับสิทธิ์อ่านข้อความ',
    'sms.permission.title': 'การตรวจสอบข้อความ<br>ต้องได้รับสิทธิ์อ่านข้อความ',
    'sms.permission.desc': 'จะส่งเฉพาะข้อความที่คุณกดยืนยันไปวิเคราะห์ที่เซิร์ฟเวอร์เท่านั้น<br>จะไม่อ่านข้อความอื่น',
    'sms.permission.unsupportedTitle': 'ฟีเจอร์นี้<br>ใช้ได้เฉพาะแอปแอนดรอยด์เท่านั้น',
    'sms.permission.unsupportedDesc': 'อุปกรณ์/เบราว์เซอร์นี้<br>ไม่สามารถอ่านข้อความโดยตรงได้',
    'sms.permission.retry': 'ลองอีกครั้ง',
    'sms.permission.openSettings': 'อนุญาตในการตั้งค่าแอป',
    'sms.recent.voice': 'ดึงรายการข้อความล่าสุดมาแล้ว กรุณากดข้อความที่ต้องการตรวจสอบ',
    'sms.recent.title': 'ข้อความล่าสุด',
    'sms.recent.desc': 'ดึงข้อความล่าสุดมาแล้ว กรุณากดข้อความที่ต้องการตรวจสอบ',
    'sms.recent.empty': 'ไม่มีข้อความที่ได้รับ',
    'sms.recent.loading': 'กำลังโหลดข้อความ...',
    'sms.recent.unknownSender': 'ผู้ส่งที่ไม่รู้จัก',
    'emergency.title': 'ขอความช่วยเหลือฉุกเฉิน', 'emergency.guardian': 'ผู้ดูแล',
    'emergency.howToAgain': 'ดูวิธีใช้งานอีกครั้ง', 'emergency.close': 'ปิด',
    'error.docBlurTitle': 'รูปภาพเบลอ',
    'error.docBlurDesc': 'มองไม่เห็นตัวอักษรชัดเจน<br>กรุณาถ่ายใหม่ในที่สว่าง',
    'error.docBlurHint': '💡 วางเอกสารให้เรียบ และถ่ายในที่สว่างไม่มีเงา จะอ่านได้ดีขึ้น',
    'error.retakePhoto': 'ถ่ายใหม่', 'error.pickGallery': 'เลือกจากคลังภาพ',
    'error.docBlurVoice': 'รูปภาพเบลอจนอ่านไม่ได้ กรุณาถ่ายใหม่ในที่สว่าง',
    'error.retry': 'ลองอีกครั้ง', 'error.goHome': 'กลับไปหน้าแรก',
    'error.aiVoice': 'ตอนนี้ยังวิเคราะห์ไม่ได้ กรุณาลองใหม่อีกครั้งในภายหลัง',
  },
  uz: {
    'home.sectionTitle': 'Sizga qanday yordam kerak?',
    'home.assistantActive': "온담 yordamchisi faollashtirildi", 'home.assistantInactive': "온담 yordamchisi faolsizlantirildi",
    'home.greetDefault': 'Foydalanuvchi',
    'home.greetNameSuffix': '', 'home.greetAge': '{age} yoshli foydalanuvchi', 'home.greetAgeGender': '{age} yoshli {gender}',
    'home.docCaptureTitle': "Hujjat suratga olish",
    'home.docCaptureDesc': "Surat oling yoki yuklang, AI sizga tushunarli qilib tushuntirib beradi",
    'home.smsCheckTitle': "SMS xabarni qisqacha tekshirish",
    'home.smsCheckDesc': "AI olingan xabar xavfsizligini tekshirib beradi",
    'home.welfareTitle': "Yaqin atrofdagi ijtimoiy ta'minot markazlari va keksalar markazini toping",
    'home.moreMenu': "Ko'proq",
    'home.moreNameLabel': 'Ism :', 'home.moreAgeLabel': 'Yosh', 'home.moreGenderLabel': 'Jinsi', 'home.moreRegionLabel': 'Hudud', 'home.moreAgeUnit': ' yosh',
    'home.moreMyInfo': 'Mening ma\'lumotim', 'home.moreHistory': 'Tahlil tarixi', 'home.moreStats': 'Statistika',
    'home.welfareDesc': "Joylashuvingiz yaqinidagi ijtimoiy ta'minot markazlari va keksalar markazini ko'rsatamiz",
    'home.todayTasks': 'Bugungi vazifalar',
    'home.viewAll': "Barchasini ko'rish",
    'home.noTasksToday': "Bugun bajarilishi kerak bo'lgan vazifa yo'q.",
    'home.publicInfoDefault': "Bilish foydali ma'lumotlar",
    'home.infoMore': "Ko'proq ma'lumot",
    'home.dueTitle': 'Tez orada to\'lanadigan',
    'home.dueMore': 'Barcha statistikani ko\'rish',
    'stats.title': 'Hisob-kitob statistikasi',
    'result.share': 'Farzandlarga yuborish',
    'result.ask': 'Bu hujjat haqida so‘rash',
    'ask.title': 'So‘rash',
    'ask.voice': 'Qiziqtirgan narsani bosing yoki o‘zingiz yozing.',
    'ask.suggested': 'Shunday so‘rashingiz mumkin',
    'ask.placeholder': 'O‘zingiz so‘rang',
    'ask.send': 'So‘rash',
    'ask.note': 'Bu hujjatda yozilganlarga asoslanib javob beramiz. Hujjatda bo‘lmasa, shuni aytamiz.',
    'ask.thinking': 'O‘ylayapman...',
    'ask.failed': 'Hozir javob berish qiyin. Birozdan so‘ng qayta so‘rang.',
    'ask.offline': 'Internet aloqasini tekshiring.',
    'ask.notInDocument': '※ Bu hujjatda yozilgan narsa emas. Aniq ma’lumotni tegishli idoradan tekshiring.',
    'history.noDetail': 'Bu yozuv eski usulda saqlangani uchun qayta ko\'rib bo\'lmaydi.',
    'history.noPhoto': 'Bu yozuvning suratini qayta ko\'rsatib bo\'lmaydi.<br>Quyidagi mazmun o\'sha paytdagi tahlil natijasi.',
    'docCollect.title': 'Olingan suratlar',
    'docCollect.count': '{n} ta surat oldingiz.',
    'docCollect.hint': 'Bir nechta surat olishingiz mumkin. Bir hujjatning old-orqasi ham, turli hujjatlar ham bo\'lsa, o\'zimiz ajratamiz.',
    'docCollect.addMore': 'Yana surat olish',
    'docCollect.analyze': 'Tahlil qilish',
    'docCollect.remove': 'Bu suratni o\'chirish',
    'docCollect.voice': 'Yana surat olishingiz yoki tugagan bo\'lsa Tahlil qilish tugmasini bosishingiz mumkin.',
    'docChoice.photoLimit': 'Eng ko‘pi bilan besh ta surat olish mumkin.',
    'result.docCountLabel': 'Hujjat {i} / {n}',
    'result.docPrev': 'Oldingi hujjat', 'result.docNext': 'Keyingi hujjat',
    'result.shareNothing': 'Yuboradigan natija yo\'q.',
    'stats.safetyLabel': "Vasiy uchun xavfsizlik holati", 'stats.safetyDangerCount': "Xavfli deb topilgan holatlar soni", 'stats.safetyNone': "Xavfli deb topilgan hujjat yoki SMS yo'q.",
    'stats.thisMonth': 'Shu oydagi hisoblar',
    'stats.cumulative': 'Oylar bo\'yicha to\'plangan summa',
    'stats.upcoming': 'Yaqinlashayotgan to\'lov muddati',
    'stats.empty': 'Hali summa yoki muddat yozilgan hujjatni tekshirmagansiz.<br>Hisobni suratga olsangiz, shu yerda jamlab ko\'rsatamiz.',
    'home.disclaimer': "Bu xizmat AI tahlili natijasi bo'lib, faqat ma'lumot uchundir.<br>Muhim hujjatlar uchun mutaxassisga murojaat qiling.",
    'nav.home': 'Bosh sahifa', 'nav.info': "Ma'lumot", 'nav.help': 'Yordam', 'nav.history': 'Tarix', 'nav.settings': 'Sozlamalar',
    'info.sectionTitle': "Bilish foydali ma'lumotlar",
    'info.empty': "Ko'rsatiladigan ma'lumotni yuklab bo'lmadi.<br>Sozlamalarda yashash hududingizni kiritsangiz, ko'proq ma'lumot ko'rasiz.",
    'settings.title': 'Sozlamalar',
    'settings.fontSize': "Ekran shrift o'lchami",
    'settings.fontNormal': "Oddiy", 'settings.fontLarge': 'Katta', 'settings.fontXLarge': "Juda katta",
    'settings.voiceSpeed': "Ovozli o'qish tezligi",
    'settings.rate05': '0.5x tezlik', 'settings.rate1': '1x tezlik', 'settings.rate15': '1.5x tezlik', 'settings.rate2': '2x tezlik',
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
    'settings.autoNotify': "🔴 Xavfli SMS aniqlanganda vasiyga xabar berishni so'rash",
    'settings.guardianHowNote': "Vasiyga xabar berishda shu qurilmadagi SMS ilovasi matni oldindan to'ldirilgan holda ochiladi. Yuborish tugmasini o'zingiz bosing — ilova siz uchun SMS yubormaydi.",
    'settings.guardianNote': "Barcha sozlamalar bu qurilmada avtomatik saqlanadi va ilova qayta yuklansa ham saqlanib qoladi.",
    'guardian.needPhone': "Vasiyning telefon raqami hali yo'q. Quyiga raqamni yozing.",
    'guardian.smsOpened': "SMS ilovasi ochildi. Matnni tekshirib, yuborish tugmasini bosing.",
    'guardian.registerHint': "Vasiyning telefon raqamini kiritsangiz, xavfli SMS haqida darhol xabar bera olasiz.",
    'guardian.askOnDanger': "Bu xavfli SMS. Vasiyga xabar berasizmi? Yuqoridagi tugmani bossangiz SMS ilovasi ochiladi.",
    'guardian.historySmsOpen': "🔔 Vasiyga xabar berish (SMS ilovasi ochildi)",
    'emergency.phoneAsk': "Vasiyning telefon raqamini yozing.",
    'emergency.phonePlaceholder': 'Masalan: 010-1234-5678',
    'emergency.phoneInvalid': "Raqam juda qisqa. Kamida 9 ta raqam kiriting.",
    'emergency.phoneSaveCall': "Saqlab, qo'ng'iroq qilish",
    'emergency.phoneSaveSms': "Saqlab, SMS ilovasini ochish",
    'help.settingsGuardian': "Vasiyning ismi va telefon raqamini kiritsangiz, xavfli SMS aniqlanganda SMS ilovasini ochib xabar bera olasiz",
    'settings.language': 'Til sozlamalari',
    'settings.languageNote': "Gyeonggi-da yashovchi chet elliklar orasida ko'p uchraydigan 4 tilni qo'llab-quvvatlaydi (xitoy·vetnam·tay·o'zbek, davlat statistikasiga ko'ra). Faqat asosiy ekran matnlari tarjima qilinadi, AI tahlil natijalari aniqlik uchun har doim koreys tilida beriladi.",
    'settings.support': "Mijozlarni qo'llab-quvvatlash",
    'settings.supportHelp': "Foydalanish bo'yicha qo'llanma",
    'settings.supportOnboarding': "Ekran qo'llanmasini qayta ko'rish (birinchi marta ishlatish qo'llanmasi)",
    'settings.supportCenter': "Mijozlarga xizmat ko'rsatish markazi bilan bog'lanish",
    'onboard.replay': 'Qayta eshitish', 'onboard.skip': "O'tkazib yuborish",
    'onboard.greet.title': "Salom!<br>Men AI raqamli yordamchi <span class=\"accent-ink\">온담(OnDam)</span>man.",
    'onboard.greet.desc': "Murakkab rasmiy hujjatlar va to'lov kvitansiyalarini o'rningizga o'qib,<br>qilishingiz kerak bo'lgan ishlarni tushunarli qilib tartiblab beraman.",
    'onboard.greet.start': "OnDam bilan boshlash",
    'onboard.greet.voice': 'Salom. Men AI raqamli yordamchiman. Haqiqiy ekranlar orqali foydalanish usulini qisqacha tushuntiraman.',
    'onboard.profile.title': "Bir nechta<br>ma'lumot bera olasizmi?",
    'onboard.access.title': "Bir nechta<br>ma'lumot bera olasizmi?", 'onboard.access.desc': "Agar xohlamasangiz, o'tkazib yuborishingiz mumkin.",
    'onboard.access.voice': "Ekran shrift o'lchami, ovozli o'qish tezligi va tilni oldindan sozlab qo'yishingiz mumkin. Agar xohlamasangiz, o'tkazib yuborishingiz mumkin.",
    'onboard.profile.desc': "Kiritgan ma'lumotingiz faqat shu qurilma va xavfsiz serverda saqlanadi,<br>faqat sizga mos tushuntirish berish uchun ishlatiladi.",
    'onboard.profile.genderLabel': 'Jinsi', 'onboard.profile.ageLabel': 'Yosh',
    'onboard.profile.agePlaceholder': 'Masalan: 73', 'onboard.profile.ageNote': "Yoshingizni raqam bilan kiriting. Yoshga qarab olinadigan imtiyozlar farq qiladi.",
    'skipConfirm.title': 'Qoʻllanma oʻtkazib yuborilsinmi?', 'skipConfirm.keep': 'Davom etish',
    'onboard.profile.useLocation': 'Joriy joylashuvimni kiritish',
    'onboard.profile.regionNote': "Tuman/shahargacha aniq yozsangiz, sizga mosroq ma'lumot bera olamiz.",
    'onboard.profile.next': 'Keyingi',
    'onboard.profile.voice': "Ism, jins, yosh guruhi va yashash hududingizni ayting, sizga mosroq yordam bera olaman.",
    'common.home': '← Bosh sahifa', 'common.back': '← Orqaga',
    'docChoice.title': "AI bilan tahlil qilish",
    'docChoice.desc': "Tahlil qilmoqchi bo'lgan hujjatni suratga oling yoki galereyadan tanlang.",
    'docChoice.voicePill': "Ovozli yo'riqnomani qayta eshitish",
    'docChoice.cameraTitle': "Surat olish", 'docChoice.cameraDesc': 'Kamera bilan hujjatni suratga olish',
    'docChoice.galleryTitle': "Rasm yuklash", 'docChoice.galleryDesc': 'Saqlangan rasmni ochish',
    'docChoice.tipTitle': 'Albatta tekshiring!',
    'docChoice.tip1': 'Hujjatdagi harflar aniq ko\'rinadigan qilib suratga oling.',
    'docChoice.tip2': "Yorug' va yorug'lik aks etmaydigan joyda suratga olsangiz aniqroq bo'ladi.",
    'docChoice.voice': "Surat olish yoki rasm yuklashni tanlang.",
    'docCapture.inProgress': '🔵 Bajarilmoqda',
    'docCapture.guide': "Hujjatni ekranning<br>o'rtasiga joylashtiring",
    'docCapture.caption': '👆 Suratga olish tugmasini bosing',
    'docCapture.blurExample': "Rasm xira chiqsa-chi? (Namunani ko'rish)",
    'docCapture.voice': "Hujjatni ekran o'rtasiga joylashtiring va pastdagi tugmani bosib suratga oling.",
    'loadingDoc.headline': "AI hujjatni o'qimoqda,<br />shu bilan birga rasm ham tayyorlanmoqda",
    'loadingText.headline': "AI xabarni tekshirmoqda,<br />shu bilan birga rasm ham tayyorlanmoqda",
    'result.docTitle': 'Tahlil natijasi', 'result.readAloud': "Baland ovozda o'qib berish",
    'result.translateFailNotice': "Tarjima muvaffaqiyatsiz tugadi. Qayta urinib ko'rasizmi?", 'result.translateFailRetry': 'Qayta urinish',
    'result.docKind': 'Hujjat turi', 'result.viewPhoto': "Rasmni ko'rish",
    'result.amountLabel': "To'lanadigan summa", 'result.dueLabel': "To'lov muddati",
    'result.aiSummaryTitle': '⚪ AI jamlagan mazmun',
    'result.todoLabel': "Bajarish kerak bo'lgan ishlar",
    'result.actionPhone': "Qo'ng'iroq qilish", 'result.actionWebsite': 'Veb-sayt', 'result.actionMap': "Yo'lni topish",
    'result.shareTitle': 'Ulashish', 'result.shareSms': 'SMS', 'result.shareKakao': '💛 KakaoTalk', 'result.shareCopy': 'Nusxa olish',
    'result.docConfirm': "Tekshirib bo'ldim",
    'result.textTitle': 'Haqiqiyligini aniqlash natijasi', 'result.dangerPill': '⚠ Xavf aniqlandi', 'result.listenVoice': 'Ovozli eshitish',
    'result.reasonLabel': "Nega xavfli?",
    'result.notifyGuardian': 'Xabarni vasiyga yuborish',
    'result.checkAnotherSms': 'Boshqa SMS ni tekshirish',
    'result.riskFactorsTitle': "🔴 Xavfli SMS unsurlari", 'result.report118': "118 ga xabar berish (politsiyaga)", 'result.askSms': 'Bu SMS haqida so\'rash',
    'result.legalNote': "Ushbu xulosa sun'iy intellekt tahlili bo'lgani uchun yuridik kuchga ega emas.<br>Shubha tug'ilsa, albatta tegishli idoraga o'zingiz murojaat qiling.",
    'result.textConfirm': 'Tanishib chiqdim', 'result.practiceAgain': 'Qaytadan mashq qilish',
    'sms.permission.voice': "Xabarni tekshirish uchun xabar o'qish ruxsati kerak.",
    'sms.permission.title': "Xabarni tekshirish uchun<br>xabar o'qish ruxsati kerak.",
    'sms.permission.desc': "Faqat siz tasdiqlagan xabar serverga yuborilib tahlil qilinadi.<br>Boshqa xabarlar o'qilmaydi.",
    'sms.permission.unsupportedTitle': "Bu funksiya<br>faqat Android ilovada ishlaydi.",
    'sms.permission.unsupportedDesc': "Bu qurilma/brauzerda<br>xabarlarni to'g'ridan-to'g'ri o'qib bo'lmaydi.",
    'sms.permission.retry': 'Qayta urinish',
    'sms.permission.openSettings': "Ilova sozlamalarida ruxsat berish",
    'sms.recent.voice': "So'nggi xabarlar ro'yxati olindi. Tekshirmoqchi bo'lgan xabarni bosing.",
    'sms.recent.title': "So'nggi xabarlar",
    'sms.recent.desc': "So'nggi xabarlar olindi. Tekshirmoqchi bo'lgan xabarni bosing.",
    'sms.recent.empty': "Qabul qilingan xabar yo'q.",
    'sms.recent.loading': 'Xabarlar yuklanmoqda...',
    'sms.recent.unknownSender': "Noma'lum jo'natuvchi",
    'emergency.title': 'Shoshilinch yordam', 'emergency.guardian': 'Vasiy',
    'emergency.howToAgain': "Foydalanish yo'riqnomasini qayta ko'rish", 'emergency.close': 'Yopish',
    'error.docBlurTitle': 'Rasm xira chiqdi.',
    'error.docBlurDesc': "Harflar yaxshi ko'rinmayapti.<br>Yorug' joyda qaytadan suratga oling.",
    'error.docBlurHint': "💡 Hujjatni tekis qo'ying va soya tushmaydigan yorug' joyda suratga olsangiz yaxshiroq o'qiladi.",
    'error.retakePhoto': 'Qayta suratga olish', 'error.pickGallery': 'Galereyadan tanlash',
    'error.docBlurVoice': "Rasm xira bo'lgani uchun o'qib bo'lmadi. Yorug' joyda qaytadan suratga oling.",
    'error.retry': 'Qayta urinish', 'error.goHome': 'Bosh sahifaga qaytish',
    'error.aiVoice': "Hozir tahlil qilib bo'lmadi. Birozdan so'ng qayta urinib ko'ring.",
  }
};

/** 현재 언어 설정에 맞는 번역 문구를 돌려준다(동적으로 생성되는 화면 문구용). 번역이 없으면 한국어 원문으로 대체 */
/* ---- 언어: 정적으로 미리 옮겨둔 5개 언어 사전(I18N) 대신, 처음 그 언어를 고른 시점에
   Worker(Claude API, /translate)로 화면 문구 전체를 실시간 번역해 기기에 캐시해둔다.
   캐시가 있으면 정적 사전보다 그 결과를 우선 쓴다. 오프라인이거나 호출이 실패하면
   조용히 기존 정적 사전(I18N)으로 폴백한다 — 화면이 비거나 깨지는 대신 이전과 같은 번역을 계속 보여준다. ---- */
const TRANSLATION_CACHE_KEY = 'ai_helper_translations_v1';
let dynamicTranslations = {}; // { [lang]: { [i18nKey]: 번역된 문구 } }
(function loadDynamicTranslations(){
  try {
    const raw = localStorage.getItem(TRANSLATION_CACHE_KEY);
    if (raw) dynamicTranslations = JSON.parse(raw) || {};
  } catch (err) { dynamicTranslations = {}; }
})();

let translationInFlight = {}; // lang -> Promise. 같은 언어를 여러 번 골라도 중복 호출하지 않도록 막는다.

/** 이 언어를 API로 번역해둔 적이 없으면 Worker(/translate)를 한 번 호출해 I18N.ko 전체를 번역하고 캐시한다.
 *  실패해도 조용히 넘어간다 — t()/applyLanguage()가 정적 사전(I18N)으로 자동 폴백하기 때문에
 *  이 호출 자체가 실패해도 사용자 눈에는 아무 문제가 없다(그저 초벌 정적 번역이 계속 보일 뿐). */
async function translateUiIfNeeded(lang){
  if (lang === 'ko' || dynamicTranslations[lang] || !AI_WORKER_URL) return;
  if (translationInFlight[lang]) return translationInFlight[lang];

  const keys = Object.keys(I18N.ko);
  const texts = keys.map(k => I18N.ko[k]);

  translationInFlight[lang] = (async () => {
    try {
      const res = await fetch(AI_WORKER_URL + '/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, texts }),
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.translations)) return;
      const dict = {};
      keys.forEach((k, i) => { dict[k] = data.translations[i] || I18N.ko[k]; });
      dynamicTranslations[lang] = dict;
      try { localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(dynamicTranslations)); } catch (err) {}
      // 번역이 도착했을 때도 여전히 이 언어를 보고 있으면 화면에 바로 반영한다(먼저 정적 사전으로 보여주고 있었으므로)
      if (appState.settings.language === lang) applyLanguage();
    } catch (err) {
      // 네트워크 오류 등: 조용히 넘어가고 기존 정적 사전으로 계속 보여준다
    } finally {
      delete translationInFlight[lang];
    }
  })();
  return translationInFlight[lang];
}

/* ---- 문서/문자 "AI 분석 결과" 표시 번역 ----
   위 translateUiIfNeeded()는 화면 UI 문구(I18N.ko) 전체를 한 번 번역해 전역 캐시(dynamicTranslations)에
   저장하는 것이고, 이건 별개다 — 분석 결과(headline/summary/checklist)는 매번 새로 생성되는 데이터라
   전역 캐시에 넣지 않고 그 분석 객체(data._translated) 안에만 캐시해둔다. Worker의 분석 자체(worker/src/index.js)는
   항상 한국어를 그대로 생성해 저장/알림(appState.schedule 등)의 원문으로 남기고, 여기서는 순수하게
   "화면에 보여주는 문구"만 표시 언어로 덧입힌다. 실패해도 조용히 넘어가 한국어 원문을 계속 보여준다
   (translateUiIfNeeded와 같은 폴백 철학 — 사용자에게 오류를 보여주지 않는다). */

/** texts 배열을 lang으로 번역해 같은 순서/개수의 배열로 돌려준다. 실패(네트워크 오류, 형식 오류 등)하면 null. */
async function translateAnalysisTexts(lang, texts){
  if (!AI_WORKER_URL) return null;
  try {
    const res = await fetch(AI_WORKER_URL + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, texts }),
    });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.translations) || data.translations.length !== texts.length) return null;
    return data.translations;
  } catch (err) {
    return null;
  }
}

/** renderDocResult()가 그린 한국어 결과 위에 번역을 덧입힌다.
 *  rows: [{ state:{text}, checkbox, textNode }, ...] — renderDocResult()의 체크리스트 행 참조.
 *  data._translated[lang]에 캐시해 같은 결과를 같은 언어로 다시 보여줄 때(뒤로가기 등) 재호출하지 않는다. */
async function applyDocResultTranslation(data, rows){
  const lang = appState.settings.language;
  setTranslateFailNoticeVisible('docTranslateFailNotice', false);
  if (!lang || lang === 'ko') return;

  data._translated = data._translated || {};
  let cached = data._translated[lang];
  if (!cached) {
    const texts = [data.headline || '', data.summary || '', ...(data.checklist || [])];
    const translations = await translateAnalysisTexts(lang, texts);
    if (!translations) {
      // 실패: 한국어 원문을 그대로 유지하되, 아직 같은 결과/언어/화면을 보고 있으면 재시도 안내를 띄운다
      if (lastDocAnalysis === data && appState.settings.language === lang) {
        setTranslateFailNoticeVisible('docTranslateFailNotice', true);
      }
      return;
    }
    const items = data.checklist || [];
    cached = {
      headline: translations[0] || data.headline || '',
      summary: translations[1] || data.summary || '',
      checklist: items.map((item, i) => translations[2 + i] || item),
    };
    data._translated[lang] = cached;
  }

  // 번역이 도착하는 동안 사용자가 다른 문서로 넘겼거나(showDocAnalysis), 다른 화면/언어로 이동했으면 반영하지 않는다
  if (lastDocAnalysis !== data) return;
  if (appState.settings.language !== lang) return;
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen || activeScreen.id !== 'screen-result-doc') return;

  const card = document.querySelector('#screen-result-doc .result-card');
  if (card) {
    const headlineEl = card.querySelector('.headline');
    if (headlineEl) headlineEl.textContent = cached.headline;
    const subtextEl = card.querySelector('.subtext');
    if (subtextEl) subtextEl.textContent = cached.summary;
  }
  const easyViewP = document.querySelector('#docEasyView p');
  if (easyViewP) easyViewP.textContent = cached.summary;

  // 다음 "다시 듣기"부터는 번역된 문구로 읽어준다. 지금 당장 speak()를 다시 호출하지는 않는다 —
  // 사용자가 이미 다른 걸 하고 있을 수 있는 비동기 갱신이라 말을 걸어 방해하지 않는다.
  document.getElementById('screen-result-doc').setAttribute(
    'data-voice', [cached.headline, cached.summary].filter(Boolean).join('. ')
  );

  rows.forEach((row, i) => {
    const translated = cached.checklist[i];
    if (translated == null) return;
    row.state.text = translated; // 알림 버튼(openReminderModal)이 다음 클릭부터 번역된 문구를 쓰도록
    if (row.textNode) row.textNode.textContent = ' ' + translated;
    if (row.checkbox) row.checkbox.dataset.schedule = translated; // 체크 시 저장되는 일정 문구도 화면과 일치시킴
  });
}

/** renderSmsResult()가 그린 한국어 결과 위에 번역을 덧입힌다.
 *  rows: [{ label, item }, ...] — renderSmsResult()의 "지금 바로 대처하세요" 목록 행 참조
 *  (AI checklist든 SMS_DEFAULT_TIPS 폴백이든, 실제로 화면에 그려진 문구를 그대로 번역 대상으로 삼는다). */
async function applySmsResultTranslation(data, rows){
  const lang = appState.settings.language;
  setTranslateFailNoticeVisible('smsTranslateFailNotice', false);
  if (!lang || lang === 'ko') return;

  data._translated = data._translated || {};
  let cached = data._translated[lang];
  if (!cached) {
    const items = rows.map(r => r.item);
    const texts = [data.headline || '', data.summary || '', ...items];
    const translations = await translateAnalysisTexts(lang, texts);
    if (!translations) {
      // 실패: 한국어 원문을 그대로 유지하되, 아직 같은 결과/언어/화면을 보고 있으면 재시도 안내를 띄운다
      if (lastSmsAnalysis === data && appState.settings.language === lang) {
        setTranslateFailNoticeVisible('smsTranslateFailNotice', true);
      }
      return;
    }
    cached = {
      headline: translations[0] || data.headline || '',
      summary: translations[1] || data.summary || '',
      items: items.map((item, i) => translations[2 + i] || item),
    };
    data._translated[lang] = cached;
  }

  // 번역이 도착하는 동안 사용자가 다른 화면/언어로 이동했으면 반영하지 않는다
  if (lastSmsAnalysis !== data) return;
  if (appState.settings.language !== lang) return;
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen || activeScreen.id !== 'screen-result-text') return;

  const card = document.querySelector('#screen-result-text .result-card');
  if (card) {
    const headlineEl = card.querySelector('.headline');
    if (headlineEl) headlineEl.textContent = cached.headline;
    const subtextEl = card.querySelector('.subtext');
    if (subtextEl) subtextEl.textContent = cached.summary;
  }
  const riskItem = document.getElementById('smsRiskSummaryItem');
  if (riskItem) riskItem.textContent = cached.summary;
  document.getElementById('screen-result-text').setAttribute(
    'data-voice', [cached.headline, cached.summary].filter(Boolean).join('. ')
  );

  rows.forEach((row, i) => {
    const translated = cached.items[i];
    if (translated != null && row.label) row.label.textContent = translated;
  });
}

function setTranslateFailNoticeVisible(id, visible){
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? 'flex' : 'none';
}

/** "다시 시도" 버튼 — 캐시된 실패는 없으므로(실패는 캐시하지 않음) 그냥 다시 호출하면 재시도된다 */
function retryDocTranslation(){
  if (!lastDocAnalysis) return;
  applyDocResultTranslation(lastDocAnalysis, lastDocChecklistRows);
}
function retrySmsTranslation(){
  if (!lastSmsAnalysis) return;
  applySmsResultTranslation(lastSmsAnalysis, lastSmsChecklistRows);
}

function t(key){
  const lang = I18N[appState.settings.language] ? appState.settings.language : 'ko';
  const dyn = dynamicTranslations[lang];
  if (dyn && dyn[key]) return dyn[key];
  return (I18N[lang] && I18N[lang][key]) || I18N.ko[key] || '';
}

function applyLanguage(){
  const lang = I18N[appState.settings.language] ? appState.settings.language : 'ko';
  const dict = I18N[lang];
  const dyn = dynamicTranslations[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const text = (dyn && dyn[el.dataset.i18n]) || (dict && dict[el.dataset.i18n]) || I18N.ko[el.dataset.i18n];
    if (text) el.innerHTML = text;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const text = (dyn && dyn[el.dataset.i18nPlaceholder]) || (dict && dict[el.dataset.i18nPlaceholder]) || I18N.ko[el.dataset.i18nPlaceholder];
    if (text) el.placeholder = text;
  });
  syncToggleGroupString('languageGroup', lang);
  syncToggleGroupString('languageGroupOnboard', lang);
}

function setLanguage(lang){
  appState.settings.language = lang;
  saveState();
  applyLanguage();
  translateUiIfNeeded(lang);
}

function syncSettingsUI(){
  syncToggleGroup('fontScaleGroup', 'scale', appState.settings.fontScale);
  syncToggleGroup('voiceRateGroup', 'rate', appState.settings.voiceRate);
  syncGuardianUI();
  syncVoiceEnabledToggles();
  syncProfileUI();
  const acct = document.getElementById('accountInfoLine');
  if (acct) {
    const auth = getAuth();
    if (auth && auth.phone) {
      const digits = auth.phone;
      const masked = digits.length >= 8
        ? digits.slice(0, digits.length - 8) + digits.slice(-8, -4) + '****' + digits.slice(-4)
        : digits;
      acct.textContent = (auth.name ? auth.name + ' · ' : '') + masked;
    } else {
      acct.textContent = '';
    }
  }
  applyLanguage();
}

function handleLogout(){
  clearAuth();
  goTo('screen-login');
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
  renderHomeInfoCard(); // 인사말이 이름·나이를 따라가므로 홈 요약 카드도 같이 갱신한다
  renderHomeGreet();    // 홈 인사 카드의 "OOO님"도 마찬가지
  if (field === 'region') queueRegionInfoRefresh();
}

/** 나이 직접 입력: 만 나이를 그대로 저장한다(기초연금 65세처럼 혜택 기준이 한 살 단위라 반올림하지 않는다).
 *  빈 칸이면 "입력 안 함"으로 두고, 숫자가 아니거나 범위를 벗어나면 저장하지 않는다(입력 중인 값을 되돌리지 않기 위해 화면은 건드리지 않음). */
function setProfileAge(raw){
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') { setProfileField('age', ''); return; }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 120) return;
  setProfileField('age', n);
}

/** 인사말 등 표시용으로 나이를 연령대(50/60/70/80)로 묶는다.
 *  저장값은 만 나이 그대로이고, 이 함수는 "70대 어르신"처럼 부드럽게 부를 때만 쓴다. */
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

/* ---- 인증(회원가입/로그인) 상태: appState와 분리된 별도 localStorage 키에 저장한다.
   토큰이 서버로 동기화되는 appState JSON 안에 섞여 들어가면 안 되기 때문이다. ---- */
const AUTH_KEY = 'ai_helper_auth_v1';

function getAuth(){
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}
function setAuth(auth){
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (err) {}
}
function clearAuth(){
  try { localStorage.removeItem(AUTH_KEY); } catch (err) {}
}
function authHeaders(){
  const auth = getAuth();
  if (!auth) return {};
  return { 'X-User-Id': String(auth.userId), 'X-Auth-Token': auth.token };
}

async function signupRequest(phone, pin, name){
  try {
    const res = await fetch(AI_WORKER_URL + '/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, pin, name }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'unknown' };
    setAuth({ userId: data.userId, token: data.token, name: data.name, phone: phone.replace(/\D/g, '') });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}

async function loginRequest(phone, pin){
  try {
    const res = await fetch(AI_WORKER_URL + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, pin }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'unknown' };
    setAuth({ userId: data.userId, token: data.token, name: data.name, phone: phone.replace(/\D/g, '') });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}

async function requestPinResetOtp(phone, name){
  try {
    const res = await fetch(AI_WORKER_URL + '/request-pin-reset-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'unknown' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}

async function verifyPinResetOtp(phone, otp, newPin){
  try {
    const res = await fetch(AI_WORKER_URL + '/verify-pin-reset-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, otp, newPin }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'unknown', attemptsLeft: data.attemptsLeft };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}

function showFieldError(id, message){
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

async function handleSignupSubmit(){
  const name = document.getElementById('signupName').value.trim();
  const phone = document.getElementById('signupPhone').value.trim();
  const pin = document.getElementById('signupPin').value.trim();
  const pinConfirm = document.getElementById('signupPinConfirm').value.trim();

  if (!isValidKoreanMobilePhone(phone)) return showFieldError('signupError', t('onboard.signup.errorPhone'));
  if (!/^\d{4}$/.test(pin)) return showFieldError('signupError', t('onboard.signup.errorPinFormat'));
  if (pin !== pinConfirm) return showFieldError('signupError', t('onboard.signup.errorPinMismatch'));

  showFieldError('signupError', '');
  const result = await signupRequest(phone, pin, name);
  if (!result.ok) {
    if (result.error === 'phone_exists') return showFieldError('signupError', t('onboard.signup.errorPhoneExists'));
    if (result.error === 'invalid_pin') return showFieldError('signupError', t('onboard.signup.errorPinFormat'));
    return showFieldError('signupError', t('onboard.signup.errorGeneric'));
  }
  appState.profile.name = name;
  saveState();
  goTo('screen-onboard-access');
}

async function handleLoginSubmit(){
  const phone = document.getElementById('loginPhone').value.trim();
  const pin = document.getElementById('loginPin').value.trim();

  showFieldError('loginError', '');
  const result = await loginRequest(phone, pin);
  if (!result.ok) {
    if (result.error === 'locked') return showFieldError('loginError', t('onboard.login.errorLocked'));
    return showFieldError('loginError', t('onboard.login.errorInvalid'));
  }
  await pullStateFromServer();
  saveState();
  syncSettingsUI();
  goTo('screen-home');
}

async function handleRequestResetOtp(){
  const name = document.getElementById('resetPinName').value.trim();
  const phone = document.getElementById('resetPinPhone').value.trim();

  if (!isValidKoreanMobilePhone(phone)) return showFieldError('resetPinError', t('onboard.signup.errorPhone'));

  showFieldError('resetPinError', '');
  const result = await requestPinResetOtp(phone, name);
  if (!result.ok) return showFieldError('resetPinError', t('onboard.resetPin.errorSmsFailed'));

  document.getElementById('resetPinStep2').style.display = '';
  const notice = document.getElementById('resetPinNotice');
  notice.textContent = t('onboard.resetPin.otpSentNotice');
  notice.style.display = 'block';
}

async function handleVerifyResetOtp(){
  const phone = document.getElementById('resetPinPhone').value.trim();
  const otp = document.getElementById('resetPinOtp').value.trim();
  const newPin = document.getElementById('resetPinNewPin').value.trim();
  const newPinConfirm = document.getElementById('resetPinNewPinConfirm').value.trim();

  if (!/^\d{4}$/.test(newPin)) return showFieldError('resetPinError', t('onboard.signup.errorPinFormat'));
  if (newPin !== newPinConfirm) return showFieldError('resetPinError', t('onboard.signup.errorPinMismatch'));

  showFieldError('resetPinError', '');
  const result = await verifyPinResetOtp(phone, otp, newPin);
  if (!result.ok) {
    if (result.error === 'otp_expired') return showFieldError('resetPinError', t('onboard.resetPin.errorOtpExpired'));
    if (result.error === 'otp_locked') return showFieldError('resetPinError', t('onboard.resetPin.errorOtpLocked'));
    return showFieldError('resetPinError', t('onboard.resetPin.errorOtpInvalid').replace('{n}', result.attemptsLeft != null ? result.attemptsLeft : 0));
  }

  showFieldError('resetPinError', '');
  showGlobalToast(t('onboard.resetPin.successNotice'));
  goTo('screen-login');
}

/** 값이 다를 때만 반영해 입력 중인 커서 위치가 튀지 않게 한다 */
function setValueIfChanged(el, value){
  if (el && el.value !== value) el.value = value;
}

function syncProfileUI(){
  syncToggleGroupString('profileGenderGroup', appState.profile.gender);
  syncToggleGroupString('profileGenderGroupSettings', appState.profile.gender);
  syncToggleGroupString('profileGenderGroupMyInfo', appState.profile.gender);
  const ageText = appState.profile.age ? String(appState.profile.age) : '';
  setValueIfChanged(document.getElementById('profileAge'), ageText);
  setValueIfChanged(document.getElementById('profileAgeSettings'), ageText);
  setValueIfChanged(document.getElementById('profileAgeMyInfo'), ageText);
  setValueIfChanged(document.getElementById('profileName'), appState.profile.name);
  setValueIfChanged(document.getElementById('profileNameSettings'), appState.profile.name);
  setValueIfChanged(document.getElementById('profileNameMyInfo'), appState.profile.name);
  setValueIfChanged(document.getElementById('profileRegion'), appState.profile.region);
  setValueIfChanged(document.getElementById('profileRegionSettings'), appState.profile.region);
  setValueIfChanged(document.getElementById('profileRegionMyInfo'), appState.profile.region);
}

/** 홈 화면 "알아두면 좋은 정보" 카드: 전국 공통으로 실제 확인된 노인 복지·안전 정보만 안내(지역별 실제 데이터는 없어 인사말만 맞춤화).
 *  각 항목을 누르면 외부 사이트로 바로 나가는 대신, 앱 안의 설명 화면(screen-info-*)으로 이동한다. */
const PUBLIC_INFO_ITEMS = [
  { id: 'pension', title: '기초연금 신청 안내', desc: '만 65세 이상, 소득 기준을 충족하면 매달 받을 수 있어요' },
  { id: 'checkup', title: '무료 건강검진', desc: '만 40세 이상은 국민건강보험공단에서 정기 검진을 받을 수 있어요' },
  { id: 'voicephishing', title: '보이스피싱 예방', desc: '의심스러운 전화나 문자는 118로 바로 신고할 수 있어요' }
];

/* ---- 납부 기한 통계 ----
   기록(appState.history)에 dueDate/amount 가 있는 항목만 대상으로 한다.
   Worker 배포 전에는 이 값들이 없으므로 관련 카드가 전부 숨겨지고 기존과 동일하게 보인다. */

/** 아직 지나지 않은 기한이 있는 기록을 가까운 순으로 */
function upcomingDueEntries(){
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return appState.history
    .filter(h => /^\d{4}-\d{2}-\d{2}$/.test(String(h.dueDate || '')))
    .map(h => {
      const [y, mo, d] = h.dueDate.split('-').map(Number);
      return { ...h, due: new Date(y, mo - 1, d) };
    })
    .filter(h => h.due.getTime() >= today.getTime())
    .sort((a, b) => a.due - b.due);
}

const HOME_DUE_PREVIEW_COUNT = 2;
function renderHomeDueCard(){
  const card = document.getElementById('homeDueCard');
  if (!card) return;
  const items = upcomingDueEntries();
  if (items.length === 0) { card.style.display = 'none'; return; }

  document.getElementById('homeDueList').innerHTML = items.slice(0, HOME_DUE_PREVIEW_COUNT).map(h => {
    const left = docDueDateLeft(h.dueDate);
    const amount = formatDocAmount(h.amount);
    const sub = [formatDocDueDate(h.dueDate), amount].filter(Boolean).join(' · ');
    return `
      <div class="row">
        <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-calendar"></use></svg></div>
        <div class="text">
          <div class="t1">${escapeHtml(h.title)}</div>
          <div class="t2">${escapeHtml(sub)}</div>
        </div>
        ${left ? `<span class="due-chip${left.urgent ? ' urgent' : ''}">${escapeHtml(left.text)}</span>` : ''}
      </div>`;
  }).join('');
  card.style.display = 'block';
}

/* ---- 되묻기 ----
   자유 대화가 아니라 "방금 확인한 문서·문자"에 대해서만 묻는다.
   근거를 눈앞의 분석 결과로 한정해야 앱이 모르는 지역별 혜택·기관 정보를 지어내지 않는다. */
let askKind = 'doc';        // 'doc' | 'sms'
let askHistory = [];        // [{q, a}] — Worker에 직전 몇 턴만 함께 보낸다
let askPending = false;

/** 추천 질문: 분석 결과에 실제로 있는 값에 맞춰 고른다(금액이 없으면 납부 질문을 권하지 않는다) */
function askSuggestions(data){
  const list = [];
  if (askKind === 'sms') {
    if (data.status === 'danger') {
      list.push('이미 링크를 눌렀으면 어떻게 하나요?', '어디에 신고하면 되나요?');
    } else {
      list.push('이 문자 믿어도 되나요?', '제가 뭘 하면 되나요?');
    }
    list.push('보낸 곳이 진짜인지 어떻게 확인하나요?');
  } else {
    if (formatDocAmount(data.amount)) list.push('어디에 내면 되나요?');
    if (data.dueDate) list.push('기한을 넘기면 어떻게 되나요?');
    list.push('제가 꼭 해야 하는 일이 뭔가요?');
    if (data.phone) list.push('어디에 물어보면 되나요?');
    if (list.length < 3) list.push('이게 무슨 문서인가요?');
  }
  return list.slice(0, 4);
}

function currentAskAnalysis(){
  return askKind === 'sms' ? lastSmsAnalysis : lastDocAnalysis;
}

function openAsk(kind){
  askKind = kind === 'sms' ? 'sms' : 'doc';
  const data = currentAskAnalysis();
  if (!data) { speak(t('result.shareNothing')); return; }
  askHistory = [];
  goTo('screen-ask');
}

function closeAsk(){
  goTo(askKind === 'sms' ? 'screen-result-text' : 'screen-result-doc');
}

function renderAskScreen(){
  const data = currentAskAnalysis();
  if (!data) return;
  const label = document.getElementById('askContextLabel');
  if (label) label.textContent = data.headline || '';

  document.getElementById('askSuggestions').innerHTML = askSuggestions(data)
    .map(q => `<button type="button" class="ask-chip" onclick="submitAsk(${JSON.stringify(q).replace(/"/g, '&quot;')})">${escapeHtml(q)}</button>`)
    .join('');
  renderAskLog();
}

function renderAskLog(){
  const log = document.getElementById('askLog');
  if (!log) return;
  log.innerHTML = askHistory.map(item => `
    <div class="ask-q">${escapeHtml(item.q)}</div>
    <div class="ask-a${item.pending ? ' is-pending' : ''}">
      ${escapeHtml(item.a)}
      ${item.fromDocument === false ? `<div class="ask-a-note">${escapeHtml(t('ask.notInDocument'))}</div>` : ''}
    </div>`).join('');
  log.scrollTop = log.scrollHeight;
}

async function submitAsk(preset){
  if (askPending) return;
  const input = document.getElementById('askInput');
  const question = String(preset || (input && input.value) || '').trim();
  if (!question) return;
  const data = currentAskAnalysis();
  if (!data) return;

  if (input) input.value = '';
  askPending = true;
  document.getElementById('askSendBtn').disabled = true;
  askHistory.push({ q: question, a: t('ask.thinking'), pending: true });
  renderAskLog();

  const finish = (answer, fromDocument) => {
    const last = askHistory[askHistory.length - 1];
    last.a = answer;
    last.pending = false;
    last.fromDocument = fromDocument;
    askPending = false;
    document.getElementById('askSendBtn').disabled = false;
    renderAskLog();
    speak(answer);   // 답변은 AI가 만든 한국어 문장이라 한국어로 읽는다(CLAUDE.md 9번)
  };

  if (!AI_WORKER_URL || !navigator.onLine) { finish(t('ask.offline'), undefined); return; }
  try {
    const res = await fetch(AI_WORKER_URL + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        analysis: data,
        history: askHistory.slice(0, -1).map(h => ({ q: h.q, a: h.a })),
        profile: appState.profile,
      })
    });
    const json = await res.json();
    if (!res.ok || json.error || !json.answer) { finish(t('ask.failed'), undefined); return; }
    finish(json.answer, json.fromDocument);
  } catch (err) {
    finish(t('ask.failed'), undefined);
  }
}

/* ---- 분석 결과 공유하기 ----
   특정 보호자 번호로 보내는 것(notifyGuardian)과 달리, 받는 사람을 정하지 않고
   기기의 공유 시트를 열어 카카오톡·문자·메일 중에서 고르게 한다.
   공유 시트를 지원하지 않는 브라우저에서는 문자 앱으로 대체한다. */

/** 공유할 본문. AI가 만든 한국어 문장이 들어가므로 화면 UI와 달리 번역하지 않는다(CLAUDE.md 9번). */
function buildShareText(kind){
  const data = kind === 'sms' ? lastSmsAnalysis : lastDocAnalysis;
  if (!data) return '';
  const lines = [`[온담] ${kind === 'sms' ? '문자' : '문서'} 확인 결과입니다.`];
  const label = GUARDIAN_STATUS_LABEL[data.status];
  if (label) lines.push(`판정: ${label}`);
  if (data.headline) lines.push(data.headline);
  if (data.summary) lines.push(data.summary);

  if (kind === 'doc') {
    const amount = formatDocAmount(data.amount);
    const due = formatDocDueDate(data.dueDate);
    if (amount) lines.push(`납부할 금액: ${amount}`);
    if (due) lines.push(`납부 기한: ${due}`);
  }
  if (Array.isArray(data.checklist) && data.checklist.length) {
    lines.push('해야 할 일:');
    data.checklist.forEach(item => lines.push(`- ${item}`));
  }
  return lines.join('\n');
}

async function shareResult(kind){
  const text = buildShareText(kind);
  if (!text) { speak(t('result.shareNothing')); return; }

  // navigator.share 는 HTTPS + 사용자 조작이 있어야 뜬다. 없거나 취소되면 문자 앱으로 대체.
  if (navigator.share) {
    try {
      await navigator.share({ title: '온담 확인 결과', text });
      return;
    } catch (err) {
      // 사용자가 공유 시트를 닫은 경우(AbortError)는 실패가 아니므로 아무것도 하지 않는다
      if (err && err.name === 'AbortError') return;
    }
  }
  // 받는 사람을 비워 두면 문자 앱에서 직접 고르게 된다
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '');
  window.location.href = 'sms:' + (isIOS ? '&' : '?') + 'body=' + encodeURIComponent(text);
}

/* ---- 통계 화면 ----
   금액이 기록된 항목이 하나도 없으면 그래프·합계를 통째로 숨기고 안내만 보여준다.
   빈 그래프나 "0원"을 그럴듯하게 보여주지 않기 위함이다. */

/** 금액이 있는 기록을 달별로 묶어 [{key:'2026-07', label:'7월', sum, count}] 로. 오래된 달부터. */
function monthlyAmountBuckets(){
  const map = new Map();
  for (const h of appState.history) {
    const amount = Number(h.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const ts = historyTimestamp(h);
    if (ts == null) continue;               // 시각을 모르면 그래프에 올리지 않는다
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const cur = map.get(key) || { key, label: `${d.getMonth() + 1}월`, sum: 0, count: 0 };
    cur.sum += amount;
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 누적 선 그래프를 SVG로 직접 그린다(차트 라이브러리를 새로 들이지 않는다).
 *  점이 1개뿐이면 선이 그려지지 않으므로 점과 값만 보여준다. */
function renderStatsChart(buckets){
  const svg = document.getElementById('statsChart');
  const desc = document.getElementById('statsChartDesc');
  if (!svg) return;

  const W = 320, H = 170, padL = 14, padR = 14, padT = 22, padB = 26;
  let running = 0;
  const pts = buckets.map(b => { running += b.sum; return { label: b.label, value: running }; });
  const max = Math.max(...pts.map(p => p.value), 1);
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const x = (i) => pts.length === 1 ? padL + innerW / 2 : padL + (innerW * i) / (pts.length - 1);
  const y = (v) => padT + innerH - (innerH * v) / max;

  const parts = [];
  // 격자 3줄(가로) — 눈금은 뒤로 물러나게
  for (let g = 0; g <= 2; g++) {
    const gy = padT + (innerH * g) / 2;
    parts.push(`<line class="chart-grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/>`);
  }
  if (pts.length > 1) {
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(pts.length - 1).toFixed(1)},${padT + innerH} L${x(0).toFixed(1)},${padT + innerH} Z`;
    parts.push(`<path class="chart-area" d="${area}"/>`);
    parts.push(`<path class="chart-line" d="${line}"/>`);
  }
  pts.forEach((p, i) => {
    parts.push(`<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="5"/>`);
    parts.push(`<text class="chart-axis-text" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(p.label)}</text>`);
  });
  // 값 라벨은 마지막 점에만 (모든 점에 숫자를 붙이면 읽기 어려워진다)
  if (pts.length) {
    const last = pts.length - 1;
    const anchor = pts.length === 1 ? 'middle' : 'end';
    parts.push(`<text class="chart-label" x="${x(last).toFixed(1)}" y="${(y(pts[last].value) - 10).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(formatDocAmount(pts[last].value))}</text>`);
  }
  svg.innerHTML = parts.join('');

  if (desc) {
    desc.textContent = pts.map(p => `${p.label} 누적 ${formatDocAmount(p.value)}`).join(', ');
  }
}

function renderStats(){
  const buckets = monthlyAmountBuckets();
  const dueItems = upcomingDueEntries();
  const hasAmount = buckets.length > 0;

  // 1) 이번 달 합계
  const now = new Date();
  const thisKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonth = buckets.find(b => b.key === thisKey);
  const monthCard = document.getElementById('statsMonthCard');
  if (thisMonth) {
    document.getElementById('statsMonthAmount').textContent = formatDocAmount(thisMonth.sum);
    document.getElementById('statsMonthCount').textContent = `${thisMonth.count}건`;
    monthCard.style.display = 'block';
  } else {
    monthCard.style.display = 'none';
  }

  // 2) 전체 누적 선 그래프 + 달별 표
  const chartSection = document.getElementById('statsChartSection');
  chartSection.style.display = hasAmount ? 'block' : 'none';
  if (hasAmount) {
    renderStatsChart(buckets);
    let running = 0;
    document.getElementById('statsMonthList').innerHTML = buckets.map(b => {
      running += b.sum;
      return `
        <div class="row">
          <div class="text">
            <div class="t1">${escapeHtml(b.label)} · ${b.count}건</div>
            <div class="t2">누적 ${escapeHtml(formatDocAmount(running))}</div>
          </div>
          <div class="t1" style="flex-shrink:0;font-weight:800;">${escapeHtml(formatDocAmount(b.sum))}</div>
        </div>`;
    }).join('');
  }

  // 3) 다가오는 기한 전체
  const dueSection = document.getElementById('statsDueSection');
  dueSection.style.display = dueItems.length ? 'block' : 'none';
  if (dueItems.length) {
    document.getElementById('statsDueList').innerHTML = dueItems.map(h => {
      const left = docDueDateLeft(h.dueDate);
      const sub = [formatDocDueDate(h.dueDate), formatDocAmount(h.amount)].filter(Boolean).join(' · ');
      return `
        <div class="row">
          <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-calendar"></use></svg></div>
          <div class="text"><div class="t1">${escapeHtml(h.title)}</div><div class="t2">${escapeHtml(sub)}</div></div>
          ${left ? `<span class="due-chip${left.urgent ? ' urgent' : ''}">${escapeHtml(left.text)}</span>` : ''}
        </div>`;
    }).join('');
  }

  document.getElementById('statsEmpty').style.display = (hasAmount || dueItems.length) ? 'none' : 'block';
}

/** 프로필이 있으면 "○○님을 위한 정보"처럼 인사말을 맞춰준다(지역별 실데이터가 아니라 호칭만 맞춤). */
function publicInfoGreeting(){
  const { name, gender, age } = appState.profile;
  const who = name ? `${name}님` : (age ? `${toAgeBand(age)}대${gender ? ' ' + gender : ''} 어르신` : '');
  return who ? `${who}을 위한 정보` : t('home.publicInfoDefault');
}

/** "알아두면 좋은 정보"의 상세 화면(기초연금/건강검진/보이스피싱)마다 있는 인사말 줄을 채운다.
 *  프로필(이름/성별/연령대)이 바뀌어도 이 화면에 처음 들어올 때 늘 최신 값으로 다시 그린다. */
const INFO_DETAIL_GREET_IDS = {
  'screen-info-pension': 'infoPensionGreet',
  'screen-info-checkup': 'infoCheckupGreet',
  'screen-info-voicephishing': 'infoVoicephishingGreet'
};
function renderInfoDetailGreet(screenId){
  const elId = INFO_DETAIL_GREET_IDS[screenId];
  const el = elId && document.getElementById(elId);
  if (el) el.textContent = publicInfoGreeting();
}

function publicInfoRowsHtml(items){
  return items.map(item => `
    <div class="row" onclick="goTo('screen-info-${item.id}')" role="button" tabindex="0">
      <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-info"></use></svg></div>
      <div class="text"><div class="t1">${escapeHtml(item.title)}</div><div class="t2">${escapeHtml(item.desc)}</div></div>
      <svg class="chev" viewBox="0 0 24 24"><use href="#ic-chevron"></use></svg>
    </div>
  `).join('');
}

/** 정보 탭(screen-info)의 전체 목록 */
function renderPublicInfoCard(){
  const card = document.getElementById('publicInfoCard');
  if (!card) return;
  document.getElementById('publicInfoTitle').innerHTML =
    `<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-info"></use></svg>${escapeHtml(publicInfoGreeting())}`;
  document.getElementById('publicInfoList').innerHTML = publicInfoRowsHtml(PUBLIC_INFO_ITEMS);
  card.style.display = 'block';
}

/** 홈의 정보 요약 카드: 앞의 2개만 보여주고 나머지는 "더보기"로 정보 탭에 넘긴다.
 *  홈이 다시 길어지는 것을 막기 위한 상한이므로 이 숫자를 늘리지 말 것. */
const HOME_INFO_PREVIEW_COUNT = 2;
function renderHomeInfoCard(){
  const card = document.getElementById('homeInfoCard');
  if (!card) return;
  document.getElementById('homeInfoTitle').innerHTML =
    `<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-info"></use></svg>${escapeHtml(publicInfoGreeting())}`;
  document.getElementById('homeInfoList').innerHTML = publicInfoRowsHtml(PUBLIC_INFO_ITEMS.slice(0, HOME_INFO_PREVIEW_COUNT));
  card.style.display = 'block';
}

/* ---- 보호자에게 알리기 ----
   외부 문자 발송 API(계정·비용 필요)를 쓰지 않고,
   기기의 문자 앱을 sms: 스킴으로 열어 받는 사람과 본문만 미리 채워준다.
   실제 '전송'은 사용자가 문자 앱에서 직접 누르는 것이므로, 앱은 절대 "보냈습니다"라고 말하지 않는다. */

/** 보호자에게 보낼 문자 본문. AI 원문(summary/checklist)을 그대로 옮기지 않고 판정 + 한 줄 요약만 담는다.
 *  본문은 보호자가 받아보는 실제 문자 내용이고 AI가 만든 한국어 문장이 섞이므로, 화면 UI와 달리 번역하지 않는다
 *  (CLAUDE.md 9번 항목: AI 분석 결과는 오역 위험 때문에 항상 한국어로 유지). */
const GUARDIAN_STATUS_LABEL = { danger: '위험', info: '정보', normal: '정상' };
function guardianSmsBody(){
  const lines = ['[온담] 방금 확인한 문자를 전달드려요.'];
  if (lastSmsAnalysis) {
    lines.push('판정: ' + (GUARDIAN_STATUS_LABEL[lastSmsAnalysis.status] || '확인 필요'));
    const headline = String(lastSmsAnalysis.headline || '').trim();
    if (headline) lines.push(headline.length > 60 ? headline.slice(0, 60) + '…' : headline);
  }
  // "보호자에게 문자 전달하기" — 판정 요약뿐 아니라 실제 원문도 함께 보내 보호자가 직접 확인할 수 있게 한다.
  if (pendingSmsText) {
    lines.push('--- 받은 문자 원문 ---');
    lines.push(pendingSmsText);
  }
  lines.push('확인 부탁드립니다.');
  return lines.join('\n');
}

/** sms: 링크를 만든다. 본문 구분자가 iOS는 '&', 그 외(Android 등)는 '?'라 플랫폼을 보고 고른다.
 *  본문은 줄바꿈·특수문자가 섞이므로 반드시 encodeURIComponent로 인코딩한다. */
function buildGuardianSmsHref(phone, body){
  const number = String(phone || '').replace(/[^0-9+*#]/g, '');
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  return 'sms:' + number + (isIOS ? '&' : '?') + 'body=' + encodeURIComponent(body);
}

function notifyGuardian(){
  const note = document.getElementById('guardianNoteText');
  if (guardianPhoneDigits(appState.guardian.phone).length < 9) {
    // 설정 화면으로 튕기지 않고, 이미 있는 긴급 도움 시트의 번호 입력 흐름을 그대로 재사용한다.
    if (note) note.textContent = t('guardian.needPhone');
    speak(t('guardian.needPhone'));
    openEmergencySheet();
    showGuardianPhonePrompt('sms');
    return;
  }
  openGuardianSmsApp();
}

/** 보호자 번호가 확실히 있는 상태에서 문자 앱을 연다(기록도 여기서만 남긴다) */
function openGuardianSmsApp(){
  const note = document.getElementById('guardianNoteText');
  if (note) note.textContent = t('guardian.smsOpened');
  speak(t('guardian.smsOpened'));
  addHistory(t('guardian.historySmsOpen'), '⚪ 완료');
  window.location.href = buildGuardianSmsHref(appState.guardian.phone, guardianSmsBody());
}

/** 위험 판정 + '알릴지 물어보기' 설정이 켜져 있으면 보호자 알리기 버튼을 눈에 띄게 강조한다.
 *  브라우저·웹뷰는 사용자의 조작 없이 문자 앱을 열 수 없어 자동 발송은 불가능하므로, 안내까지만 한다. */
function syncGuardianNotifyPrompt(){
  const note = document.getElementById('guardianNoteText');
  const btn = document.querySelector('#screen-result-text .guardian-btn');
  const hasPhone = guardianPhoneDigits(appState.guardian.phone).length >= 9;
  const ask = !!(lastSmsAnalysis && lastSmsAnalysis.status === 'danger' && appState.guardian.autoNotify);
  if (btn) btn.classList.toggle('urgent', ask);
  if (!note) return;
  if (!hasPhone) { note.textContent = t('guardian.registerHint'); return; }
  note.textContent = ask ? t('guardian.askOnDanger') : '';
}

function callGuardian(){
  // 숫자가 9자리 미만이면(비어있거나 오타 등 잘못 입력된 번호) 실제로는 걸리지 않는 tel: 링크를 여는 대신
  // 번호부터 다시 받는다 — notifyGuardian()의 검증과 동일한 기준을 쓴다.
  if (guardianPhoneDigits(appState.guardian.phone).length < 9) {
    // 설정 화면으로 튕기지 않고, 긴급 도움 시트를 열어 그 안에서 바로 번호를 받는다(저장 즉시 전화 연결)
    openEmergencySheet();
    showGuardianPhonePrompt();
    return;
  }
  window.location.href = 'tel:' + appState.guardian.phone;
}

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

window.addEventListener('load', async () => {
  loadState();
  translateUiIfNeeded(appState.settings.language);

  const docPreviewEl = document.getElementById('docPreviewContent');
  if (docPreviewEl) docPreviewDefaultHTML = docPreviewEl.innerHTML;

  // 로그인 토큰이 있으면 홈에서 시작(서버 상태를 조용히 불러온다), 없으면 인사 화면(회원가입 유도)에서 시작한다.
  // goTo()를 쓰지 않는 이유: 앱을 열자마자 안내 음성이 재생되는 걸 막기 위함(기존 동작 유지).
  let firstScreenId = 'screen-greet';
  if (getAuth()) {
    const stillValid = await pullStateFromServer();
    firstScreenId = stillValid ? 'screen-home' : 'screen-login';
    if (!stillValid) clearAuth();
  }
  const first = document.getElementById(firstScreenId);
  if (first !== activeScreenEl) {
    activeScreenEl.classList.remove('active');
    first.classList.add('active');
    activeScreenEl = first;
    document.body.classList.toggle('in-onboarding', onboardScreens.has(first.id));
  }
  document.body.classList.toggle('has-bottom-nav', TAB_SCREENS.has(first.id));
  syncBottomNav(first.id);
  first.scrollTop = 0;
  document.getElementById('liveRegion').textContent = screenVoiceText(first);

  document.documentElement.style.setProperty('--scale', appState.settings.fontScale);
  syncSettingsUI();

  document.querySelectorAll('.schedule-check').forEach(bindScheduleCheckbox);

  attachRippleEffect();
  renderHomeDashboard();
});
