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
   8. AI에게 질문하기 (FAQ + 자유 입력)
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
  settings: { fontScale: 1, voiceRate: 1, voiceEnabled: true, language: 'ko', highContrast: false }, // 접근성 설정
  guardian: { name: '', phone: '', autoNotify: false },
  profile: { name: '', gender: '', ageBand: '', region: '' } // 맞춤 안내용(선택 사항): AI 분석 요청에 참고 정보로만 함께 전달됨
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
      profile: appState.profile
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

function speak(text){
  const liveRegion = document.getElementById('liveRegion');
  if (!appState.settings.voiceEnabled || !window.speechSynthesis || !text) {
    if (text && liveRegion) liveRegion.textContent = text;
    return;
  }
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ko-KR';
  utter.rate = appState.settings.voiceRate;
  const koVoice = voices.find(v => v.lang && v.lang.startsWith('ko'));
  if (koVoice) utter.voice = koVoice;
  speechSynthesis.speak(utter);
  if (liveRegion) liveRegion.textContent = text;
}

/** 현재 화면의 안내 음성을 다시 읽기 */
function replayCurrentVoice(){
  const active = document.querySelector('.screen.active');
  if (active) speak(active.getAttribute('data-voice'));
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

let activeScreenEl = document.querySelector('.screen.active');

function goTo(id){
  if (activeScreenEl) activeScreenEl.classList.remove('active');
  const target = document.getElementById(id);
  target.classList.add('active');
  activeScreenEl = target;
  // 코치마크가 이 화면에서 직접 안내 음성을 읽어줄 예정이면, 화면 기본 안내와 겹쳐 읽혀 잘리는 걸 막기 위해 기본 음성은 건너뛴다
  if (!coachWillNarrate(id)) speak(target.getAttribute('data-voice'));
  document.body.classList.toggle('in-onboarding', onboardScreens.has(id) || coachActive);

  if (id === 'screen-home') renderHomeDashboard();
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

/** 첫 화면의 "건너뛰기": 실수로 누르는 경우가 많아 같은 문구로 한 번 더 확인한다 */
function confirmSkipTutorial(){
  if (confirm('튜토리얼을 건너뛸까요?')) goTo('screen-home');
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
  updateHomeRecent();
  renderPublicInfoCard();
  renderRegionInfoCard();
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

/** 주변 복지센터 화면에도 같은 경로당 데이터를 보여준다(경기도 시/군이 매칭될 때만) */
async function renderWelfareGyeonggiSection(){
  const wrap = document.getElementById('welfareGyeonggiSection');
  if (!wrap) return;
  const region = (appState.profile.region || '').trim();
  const data = await fetchRegionInfo(region);
  if (!data || !data.matched || !data.centers || data.centers.length === 0) { wrap.style.display = 'none'; return; }

  document.getElementById('welfareGyeonggiTitle').innerHTML =
    `<svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-pin"></use></svg>${escapeHtml(data.city)} 경로당(등록 정보)`;
  document.getElementById('welfareGyeonggiList').innerHTML = data.centers.map(regionCenterRowHtml).join('');
  wrap.style.display = 'block';
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
    el.innerHTML = '<div class="empty-state" style="padding:10px 0;">오늘 할 일이 없습니다.</div>';
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

/** 프로필의 "사시는 지역"을 기기 위치(Geolocation API)로 자동 입력. 역지오코딩도 같은 Nominatim을 사용(API 키 불필요) */
function useCurrentLocationForRegion(){
  if (!navigator.geolocation) { showGlobalToast('이 기기에서는 위치 확인을 지원하지 않아요.'); return; }
  showGlobalToast('위치를 확인하는 중이에요...');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
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
      showGlobalToast('위치 확인에 실패했어요. 직접 입력해주세요.');
    }
  }, () => {
    showGlobalToast('위치 권한이 필요해요. 직접 입력해주세요.');
  });
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
  mapEl.style.display = 'none';

  if (!navigator.geolocation) { statusEl.textContent = '이 기기에서는 위치 확인을 지원하지 않아요.'; return; }
  statusEl.textContent = '내 위치를 확인하고 있어요...';

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    welfareUserLat = latitude;
    welfareUserLon = longitude;
    statusEl.textContent = '주변 시설을 찾고 있어요...';
    renderWelfareGyeonggiSection();

    try {
      const query = `[out:json][timeout:20];(node["amenity"="social_facility"](around:2000,${latitude},${longitude});node["amenity"="community_centre"](around:2000,${latitude},${longitude});node["office"="government"]["government"="administrative"](around:2000,${latitude},${longitude}););out center 15;`;
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

      statusEl.textContent = `내 위치 주변 ${places.length}곳을 찾았어요.`;
      listEl.innerHTML = places.map(p => `
        <div class="row" onclick="openWelfareRouteSheet('${escapeHtml(p.name).replace(/'/g, "\\'")}', ${p.lat}, ${p.lon})" role="button" tabindex="0">
          <div class="icon-chip accent"><svg viewBox="0 0 24 24"><use href="#ic-pin"></use></svg></div>
          <div class="text"><div class="t1">${escapeHtml(p.name)}</div><div class="t2">${escapeHtml(p.address || '주소 정보 없음')}</div></div>
          ${p.phone ? `<a href="tel:${escapeHtml(p.phone)}" onclick="event.stopPropagation()" style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:var(--accent-soft);color:var(--accent-strong);display:flex;align-items:center;justify-content:center;" aria-label="전화하기"><svg style="width:16px;height:16px;" viewBox="0 0 24 24"><use href="#ic-phone"></use></svg></a>` : ''}
        </div>
      `).join('');

      renderWelfareMap(mapEl, latitude, longitude, places);
    } catch (err) {
      statusEl.textContent = '주변 시설 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.';
    }
  }, () => {
    statusEl.textContent = '위치 권한이 필요해요. 기기 설정에서 위치 권한을 허용해주세요.';
  });
}

function renderWelfareMap(el, lat, lon, places){
  if (typeof L === 'undefined') return;
  el.style.display = 'block';
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: false }).setView([lat, lon], 14);
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
  updateHomeRecent();
}

function updateHomeRecent(){
  const el = document.getElementById('homeRecentList');
  if (appState.history.length === 0) {
    el.innerHTML = '<div class="row"><div class="text t2" style="color:var(--ink-faint);">아직 기록이 없습니다</div></div>';
    return;
  }
  el.innerHTML = appState.history.slice(0, 3).map(h => `
    <div class="row">
      <div class="icon-chip"><svg viewBox="0 0 24 24"><use href="#ic-clock"></use></svg></div>
      <div class="text"><div class="t1">${escapeHtml(h.title)}</div><div class="t2">${escapeHtml(h.result)}</div></div>
    </div>
  `).join('');
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
const coachSteps = [
  { screen: 'screen-home', target: '#screen-home .feature-card[onclick*="screen-doc-choice"]',
    title: '문서를 촬영해보세요', desc: '이 카드를 누르면 문서를 찍어 AI에게 분석을 맡길 수 있어요.', voice: '문서 촬영 카드를 눌러보세요.' },
  { screen: 'screen-doc-choice', target: '#screen-doc-choice .feature-card[onclick*="screen-doc-capture"]',
    title: '직접 촬영해볼게요', desc: '카메라로 문서를 찍어보세요.', voice: '직접 촬영하기를 눌러보세요.' },
  { screen: 'screen-doc-capture', target: '#screen-doc-capture .camera-shutter',
    title: '촬영 버튼을 눌러주세요', desc: '문서가 화면 가운데 오도록 맞추고 눌러주세요.', voice: '촬영 버튼을 눌러주세요.', advance: 'click' },
  { screen: 'screen-home', target: '#screen-home .feature-card[onclick*="screen-sms-phone"]',
    title: '문자도 확인해보세요', desc: '받은 문자가 안전한지도 확인할 수 있어요.', voice: '문자 내용 요약 카드를 눌러보세요.' },
  { screen: 'screen-sms-phone', target: '#screen-sms-phone .app-icon.msg',
    title: '문자 앱을 눌러보세요', desc: '문자 앱을 열어볼게요.', voice: '문자 앱을 눌러보세요.' },
  { screen: 'screen-tutorial-sms-mock', target: '#screen-tutorial-sms-mock .compose-box',
    title: '문자를 길게 눌러 복사해보세요', desc: '실제로는 확인하고 싶은 문자를 길게 눌러 복사하면 돼요.', voice: '문자를 길게 눌러 복사해보세요.' },
  { screen: 'screen-sms-switch', target: '#screen-sms-switch .primary-btn',
    title: '다시 이 앱으로 돌아와주세요', desc: '복사했다면 이 버튼을 눌러 앱으로 돌아오세요.', voice: '앱 열기 버튼을 눌러주세요.' },
  { screen: 'screen-sms-paste', target: '#smsPasteInput',
    title: '길게 눌러 붙여넣어보세요', desc: '이 칸을 길게 눌러 붙여넣기를 선택하세요.', voice: '붙여넣기 칸을 눌러보세요.', advance: 'input' },
  { screen: 'screen-sms-paste', target: '#screen-sms-paste .primary-btn',
    title: '확인을 눌러주세요', desc: '붙여넣기가 끝나면 확인을 눌러주세요.', voice: '확인 버튼을 눌러주세요.' },
  { screen: 'screen-sms-filled', target: '#screen-sms-filled .primary-btn',
    title: '확인을 눌러 결과를 보세요', desc: '이 버튼을 누르면 AI가 문자를 확인해드려요.', voice: '확인 버튼을 눌러 결과를 확인하세요.' },
  { screen: 'screen-home', target: '#screen-home .icon-square-btn[onclick*="openHistory"]',
    title: '최근 기록도 볼 수 있어요', desc: '지금까지 확인한 문서와 문자 기록을 모아볼 수 있어요.', voice: '최근 기록 버튼을 눌러보세요.' },
  { screen: 'screen-history', target: '#screen-history .nav-btn',
    title: '다시 홈으로 돌아가볼게요', desc: '← 홈으로 버튼을 누르면 언제든 돌아갈 수 있어요.', voice: '홈으로 버튼을 눌러 돌아가보세요.' },
  { screen: 'screen-home', target: '#publicInfoList .row:first-child',
    title: '알아두면 좋은 정보도 있어요', desc: '기초연금, 건강검진 같은 유용한 정보를 안내해드려요.', voice: '알아두면 좋은 정보를 눌러보세요.' },
  { screen: 'screen-info-pension', target: '#screen-info-pension .primary-btn',
    title: '다 보셨으면 홈으로 돌아가요', desc: '홈으로 돌아가기 버튼을 눌러주세요.', voice: '홈으로 돌아가기 버튼을 눌러주세요.' },
  { screen: 'screen-home', target: '#screen-home .feature-card[onclick*="screen-welfare-nearby"]',
    title: '주변 복지센터도 찾아드려요', desc: '내 위치 주변의 복지센터·주민센터 위치를 알려드려요.', voice: '주변 복지센터 알아보기를 눌러보세요.' },
  { screen: 'screen-welfare-nearby', target: '#screen-welfare-nearby .secondary-btn[onclick*="screen-home"]',
    title: '홈 화면으로 돌아가볼게요', desc: '홈 화면으로 돌아가기 버튼을 눌러주세요.', voice: '홈 화면으로 돌아가기 버튼을 눌러주세요.' },
  { screen: 'screen-home', target: '#screen-home .topbar [data-replay]',
    title: '음성으로 안내받을 수도 있어요', desc: '이 버튼을 누르면 화면 안내를 다시 들을 수 있어요.', voice: '음성으로 안내받기 버튼을 눌러보세요.', advance: 'click' },
  { screen: 'screen-home', target: '#emergencyFab',
    title: '긴급할 땐 이 버튼을 누르세요', desc: '보호자나 119·112·118로 바로 연락할 수 있어요.', voice: '도움 버튼을 눌러보세요.', advance: 'click' },
  { screen: 'screen-home', target: '#screen-home .icon-square-btn[onclick*="screen-settings"]',
    title: '설정도 살펴볼게요', desc: '글자 크기, 음성 속도, 보호자 정보를 바꿀 수 있어요.', voice: '설정 버튼을 눌러보세요.' },
  { screen: 'screen-settings', target: '#fontScaleGroup',
    title: '글자 크기를 바꿔보세요', desc: '보통, 크게, 아주 크게 중에서 골라보세요.', voice: '글자 크기를 눌러보세요.', advance: 'click' },
  { screen: 'screen-settings', target: '#voiceRateGroup',
    title: '음성 속도도 바꿀 수 있어요', desc: '읽어주는 속도를 편한 대로 골라보세요.', voice: '음성 읽기 속도를 눌러보세요.', advance: 'click' },
  { screen: 'screen-settings', target: '#guardianName',
    title: '보호자 정보를 등록해보세요', desc: '위험한 문자를 발견하면 보호자에게 바로 알릴 수 있어요.', voice: '보호자 이름을 입력해보세요.', advance: 'input' },
  { screen: 'screen-settings', target: '#screen-settings .settings-link-row[onclick*="screen-help"]',
    title: '사용 방법 안내도 있어요', desc: '헷갈릴 때 언제든 다시 볼 수 있어요.', voice: '사용 방법 안내를 눌러보세요.' },
  { screen: 'screen-help', target: '#screen-help .nav-btn',
    title: '뒤로 가서 마무리할게요', desc: '← 뒤로 버튼을 눌러주세요.', voice: '뒤로 버튼을 눌러주세요.' },
  { screen: 'screen-settings', target: '#screen-settings .topbar .nav-btn',
    title: '이제 홈으로 돌아가면 끝이에요', desc: '← 홈으로 버튼을 눌러 안내를 마쳐요.', voice: '홈으로 버튼을 눌러 안내를 마쳐요.', advance: 'click' }
];
let coachIndex = -1;
let coachActive = false;

function startCoachmark(){
  coachActive = true;
  coachIndex = 0;
  goTo('screen-home'); // goTo가 coachOnNavigate를 호출해 1단계를 띄워줌
}

function stopCoachmark(silent){
  coachActive = false;
  coachIndex = -1;
  const overlay = document.getElementById('coachOverlay');
  if (overlay) overlay.style.display = 'none';
  if (activeScreenEl) document.body.classList.toggle('in-onboarding', onboardScreens.has(activeScreenEl.id));
  if (!silent) {
    speak('안내가 끝났습니다. 이제 실제로 사용해보세요.');
    showGlobalToast('튜토리얼이 끝났습니다.');
  }
}

/** 진행 중인 코치마크의 "튜토리얼 건너뛰기": 첫 화면 건너뛰기와 같은 문구로 한 번 더 확인 */
function confirmSkipCoachmark(){
  if (confirm('튜토리얼을 건너뛸까요?')) { stopCoachmark(true); goTo('screen-home'); }
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
  if (nextStep && id === nextStep.screen) {
    coachIndex++;
    setTimeout(showCoachStep, 200);
  } else if (id === step.screen) {
    setTimeout(showCoachStep, 200);
  } else {
    // ponytail: 분석 중/결과 화면처럼 성공·실패로 갈라지는 중간 화면은 그냥 지나쳐 보내고(오버레이만 숨김),
    // 다음 단계가 기다리는 화면(예: 홈)으로 실제로 돌아왔을 때 위 분기에서 자연스럽게 이어받는다
    const overlay = document.getElementById('coachOverlay');
    if (overlay) overlay.style.display = 'none';
  }
}

function showCoachStep(){
  const step = coachSteps[coachIndex];
  const overlay = document.getElementById('coachOverlay');
  if (!step) { stopCoachmark(); return; }
  if (!activeScreenEl || activeScreenEl.id !== step.screen) { overlay.style.display = 'none'; return; }

  const el = document.querySelector(step.target);
  if (!el) { overlay.style.display = 'none'; return; }

  // 화면이 길어 대상 버튼이 화면 아래에 있으면 구멍이 뷰포트 밖에 생겨 화면 전체가 어둡게 보이므로, 강조하기 전에 보이는 위치로 스크롤한다
  el.scrollIntoView({ block: 'center' });
  positionCoachStep(el, step);
  overlay.style.display = 'block';
  speak(step.voice);

  if (step.advance) {
    el.addEventListener(step.advance, () => {
      coachIndex++;
      setTimeout(showCoachStep, 300);
    }, { once: true });
  }
}

/** 화면 방향 전환 등으로 크기가 바뀌면 스포트라이트 위치도 다시 계산한다 */
window.addEventListener('resize', () => {
  if (!coachActive) return;
  const overlay = document.getElementById('coachOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  const step = coachSteps[coachIndex];
  if (!step) return;
  const el = document.querySelector(step.target);
  if (el) positionCoachStep(el, step);
});

function positionCoachStep(el, step){
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const hole = document.getElementById('coachHole');
  hole.style.top = (rect.top - pad) + 'px';
  hole.style.left = (rect.left - pad) + 'px';
  hole.style.width = (rect.width + pad * 2) + 'px';
  hole.style.height = (rect.height + pad * 2) + 'px';

  document.getElementById('coachTipStep').textContent = `${coachIndex + 1} / ${coachSteps.length}`;
  document.getElementById('coachTipTitle').textContent = step.title;
  document.getElementById('coachTipDesc').textContent = step.desc;

  const tip = document.getElementById('coachTip');
  const spaceBelow = window.innerHeight - rect.bottom;
  const putBelow = spaceBelow > 180 || rect.top < 180;
  tip.style.top = putBelow ? (rect.bottom + pad + 10) + 'px' : '';
  tip.style.bottom = putBelow ? '' : (window.innerHeight - rect.top + pad + 10) + 'px';
  tip.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - 300)) + 'px';
}

/* ---------------------------------------------------------
   7-1. 실제 카메라 / 갤러리 연동 (Capacitor)
   --------------------------------------------------------- */
const AI_WORKER_URL = 'https://ansim-doumi-ai.kke88084.workers.dev';

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
   8. AI에게 질문하기 (FAQ + 자유 입력)
   --------------------------------------------------------- */
const faqAnswers = {
  doc: {
    '언제까지 해야 하나요?': '올해 12월 31일까지 건강검진을 받으시면 됩니다.',
    '왜 해야 하나요?': '정기적인 건강검진은 질병을 미리 발견하고 예방하는 데 도움이 됩니다. 받지 않으면 건강보험료가 할증될 수 있어요.',
    '준비물이 있나요?': '신분증만 챙기시면 됩니다. 공복이 필요한 검사 항목은 검진기관에서 별도로 안내해드려요.',
    '비용이 드나요?': '국가 건강검진은 대부분 무료이며, 추가로 선택하는 검사 항목만 본인 부담일 수 있습니다.',
    '어디로 가야 하나요?': '집에서 가까운 건강검진기관 아무 곳이나 방문하시면 됩니다. 길찾기 버튼을 눌러 가까운 곳을 찾아보세요.'
  }
};

function askFaq(question, category){
  const answer = (faqAnswers[category] && faqAnswers[category][question]) || '죄송해요, 아직 답변을 준비하지 못했어요.';
  showQaAnswer(category, answer);
}

/** 자유 입력 질문에 대해 키워드 기반으로 가장 가까운 FAQ 답변을 찾아줌 (실제 AI API 미연결, 예시 로직) */
function askFreeText(inputId, category){
  const input = document.getElementById(inputId);
  const text = input.value.trim();
  if (!text) { showQaAnswer(category, '궁금한 내용을 입력한 뒤 질문해주세요.'); return; }

  const keywordMap = [
    { keys: ['언제', '기한', '날짜'], q: '언제까지 해야 하나요?' },
    { keys: ['왜', '이유'], q: '왜 해야 하나요?' },
    { keys: ['준비물', '챙길', '필요한 것'], q: '준비물이 있나요?' },
    { keys: ['비용', '돈', '얼마'], q: '비용이 드나요?' },
    { keys: ['어디', '장소', '위치'], q: '어디로 가야 하나요?' }
  ];
  const matched = keywordMap.find(k => k.keys.some(key => text.includes(key)));
  if (matched) {
    askFaq(matched.q, category);
  } else {
    showQaAnswer(category, '정확한 답변을 위해서는 보호자나 관련 기관에 직접 확인해보시는 것을 추천드려요.');
  }
  input.value = '';
}

function showQaAnswer(category, answer){
  const answerId = category === 'doc' ? 'docQaAnswer' : 'smsQaAnswer';
  const el = document.getElementById(answerId);
  el.textContent = answer;
  el.style.display = 'block';
  speak(answer);
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

/** 저시력 사용자를 위한 고대비 테마: CSS 변수(--ink/--line/--accent 등)를 진하게 덮어써서 대부분의 화면에 그대로 적용된다 */
function toggleHighContrast(){
  const checked = document.getElementById('highContrastToggle').checked;
  appState.settings.highContrast = checked;
  document.body.classList.toggle('high-contrast', checked);
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
    'home.recentRecords': '최근 기록',
    'home.settings': '설정',
    'home.noRecords': '아직 기록이 없습니다',
    'home.disclaimer': '본 서비스는 AI 분석 결과로 참고용이며,<br>중요 문서는 전문가와 상담하시기 바랍니다.',
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
    'settings.supportCenter': '고객센터 연결'
  },
  zh: {
    'home.sectionTitle': '需要什么帮助？',
    'home.docTitle': '拍摄文件',
    'home.docDesc': '拍摄文件后为您总结内容',
    'home.smsTitle': '短信内容摘要',
    'home.smsDesc': '判断短信真伪并为您总结',
    'home.recentRecords': '最近记录',
    'home.settings': '设置',
    'home.noRecords': '还没有记录',
    'home.disclaimer': '本服务为AI分析结果，仅供参考，<br>重要文件请咨询专业人士。',
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
    'settings.supportCenter': '联系客服中心'
  },
  vi: {
    'home.sectionTitle': 'Bạn cần giúp gì?',
    'home.docTitle': 'Chụp tài liệu',
    'home.docDesc': 'Chụp tài liệu để được tóm tắt nội dung',
    'home.smsTitle': 'Tóm tắt tin nhắn',
    'home.smsDesc': 'Kiểm tra tin nhắn thật hay giả và tóm tắt',
    'home.recentRecords': 'Lịch sử gần đây',
    'home.settings': 'Cài đặt',
    'home.noRecords': 'Chưa có lịch sử nào',
    'home.disclaimer': 'Dịch vụ này chỉ mang tính tham khảo (kết quả phân tích AI),<br>hãy hỏi chuyên gia với tài liệu quan trọng.',
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
    'settings.supportCenter': 'Kết nối trung tâm hỗ trợ'
  },
  th: {
    'home.sectionTitle': 'ต้องการความช่วยเหลือเรื่องอะไร?',
    'home.docTitle': 'ถ่ายภาพเอกสาร',
    'home.docDesc': 'ถ่ายภาพเอกสารแล้วเราจะสรุปเนื้อหาให้',
    'home.smsTitle': 'สรุปข้อความ',
    'home.smsDesc': 'ตรวจสอบว่าข้อความจริงหรือปลอมแล้วสรุปให้',
    'home.recentRecords': 'ประวัติล่าสุด',
    'home.settings': 'ตั้งค่า',
    'home.noRecords': 'ยังไม่มีประวัติ',
    'home.disclaimer': 'บริการนี้เป็นผลวิเคราะห์จาก AI เพื่อการอ้างอิงเท่านั้น<br>เอกสารสำคัญกรุณาปรึกษาผู้เชี่ยวชาญ',
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
    'settings.supportCenter': 'ติดต่อศูนย์บริการลูกค้า'
  },
  uz: {
    'home.sectionTitle': 'Sizga qanday yordam kerak?',
    'home.docTitle': 'Hujjatni suratga olish',
    'home.docDesc': 'Hujjatni suratga olsangiz, mazmunini xulosalab beramiz',
    'home.smsTitle': 'SMS xulosasi',
    'home.smsDesc': "SMS xabarining haqiqiyligini tekshirib, xulosa beramiz",
    'home.recentRecords': "So'nggi tarix",
    'home.settings': 'Sozlamalar',
    'home.noRecords': "Hali tarix yo'q",
    'home.disclaimer': "Bu xizmat AI tahlili natijasi bo'lib, faqat ma'lumot uchundir.<br>Muhim hujjatlar uchun mutaxassisga murojaat qiling.",
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
    'settings.supportCenter': "Mijozlarga xizmat ko'rsatish markazi bilan bog'lanish"
  }
};

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
  document.getElementById('highContrastToggle').checked = appState.settings.highContrast;
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
    const hasLocal = appState.profile.name || appState.profile.gender || appState.profile.ageBand || appState.profile.region;
    if (!hasLocal && data && (data.name || data.gender || data.ageBand || data.region)) {
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
  syncToggleGroupString('profileAgeBandGroup', appState.profile.ageBand);
  syncToggleGroupString('profileAgeBandGroupSettings', appState.profile.ageBand);
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

  const { name, gender, ageBand } = appState.profile;
  const who = name ? `${name}님` : ((ageBand || gender) ? `${ageBand}${gender ? ' ' + gender : ''} 어르신` : '');
  const greeting = who ? `${who}을 위한 정보` : '알아두면 좋은 정보';
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

  const first = document.getElementById('screen-greet');
  document.getElementById('liveRegion').textContent = first.getAttribute('data-voice');

  document.documentElement.style.setProperty('--scale', appState.settings.fontScale);
  document.body.classList.toggle('high-contrast', appState.settings.highContrast);
  syncSettingsUI();

  document.querySelectorAll('.schedule-check').forEach(bindScheduleCheckbox);

  attachRippleEffect();
  renderHomeDashboard();
  loadProfileFromServer();
});
