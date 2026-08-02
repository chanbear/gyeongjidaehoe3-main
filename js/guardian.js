(() => {
  'use strict';

  /* ---------------------------------------------------------
     온담 보호자 앱 — 전화번호 + OTP 자동 연동
     어르신 쪽은 손댈 게 없다: 어르신이 설정에서 이미 입력해둔 보호자 전화번호가
     곧 "연결 허용 목록" 역할을 한다. 보호자는 본인 전화번호를 OTP로 인증하면,
     그 번호를 보호자로 등록해둔 어르신 계정을 서버가 자동으로 찾아 연결해준다
     (worker/src/index.js의 /guardian/request-otp, /guardian/verify-otp,
     /guardian/seniors, /guardian/state, /guardian/mark-read 참고).
     --------------------------------------------------------- */

  const GUARDIAN_SESSION_KEY = 'ondam_guardian_session_v1';
  const AI_WORKER_URL = 'https://ondam-ai.kke88084.workers.dev';

  const DEMO_STATE = {
    profile: { name: '김온담', gender: '여성', age: 72, region: '경기도 안산시' },
    history: [
      { messageId: 'demo-1', title: '📱 택배 사칭 의심 문자', createdAt: new Date().toISOString(), analysis: { status: 'danger', headline: '개인정보를 요구하는 위험한 문자예요', summary: '출처가 불분명한 링크가 포함되어 있어 누르지 않는 것이 안전합니다.', checklist: ['링크를 누르지 않기', '발신 기관에 직접 전화해 확인하기'] } },
      { messageId: 'demo-2', title: '📄 건강검진 안내', createdAt: new Date(Date.now() - 86400000).toISOString(), analysis: { status: 'normal', headline: '건강검진 예약 안내', summary: '가까운 검진기관에 예약하고 신분증을 준비해주세요.', checklist: ['검진기관에 예약하기', '검진 당일 신분증 준비하기'], dueDate: dateOffset(12), amount: 0 } },
      { messageId: 'demo-3', title: '💬 병원 예약 안내 문자', createdAt: new Date(Date.now() - 129600000).toISOString(), analysis: { status: 'normal', headline: '병원 진료 예약 안내예요', summary: '내일 오전 10시 진료 예약을 알려주는 정상적인 안내 문자입니다.', checklist: ['예약 시간 10분 전에 도착하기', '신분증 챙기기'] } },
      { messageId: 'demo-4', title: '📄 도시가스 고지서', createdAt: new Date(Date.now() - 172800000).toISOString(), analysis: { status: 'normal', headline: '도시가스 요금 안내', summary: '납부기한 전까지 요금을 납부해주세요.', dueDate: dateOffset(7), amount: 34800 } },
      { messageId: 'demo-5', title: '💬 기초연금 안내 문자', createdAt: new Date(Date.now() - 259200000).toISOString(), analysis: { status: 'info', headline: '기초연금 신청 안내예요', summary: '주민센터에서 기초연금 상담을 받을 수 있다는 공공 안내 문자입니다.', checklist: ['신분증을 준비하기', '주소지 주민센터에 문의하기'] } }
    ],
    schedule: [
      { text: '건강검진 예약하기', source: '건강검진 안내', date: dateOffset(3), time: '10:00', done: false },
      { text: '도시가스 요금 납부', source: '도시가스 고지서', date: dateOffset(7), time: '09:00', done: false },
      { text: '신분증 준비하기', source: '건강검진 안내', date: dateOffset(-1), time: '18:00', done: true }
    ]
  };

  let state = null;
  let isDemo = false;
  let historyFilter = 'all';
  let refreshTimer = null;
  const readThisSession = new Set(); // 서버에 읽음 상태를 조회하는 API는 없어 세션 내에서만 추적한다

  const $ = (id) => document.getElementById(id);
  const phoneDigits = (value) => String(value || '').replace(/\D/g, '');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  function dateOffset(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(GUARDIAN_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem(GUARDIAN_SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(GUARDIAN_SESSION_KEY);
  }

  function guardianHeaders(session) {
    return {
      'Content-Type': 'application/json',
      'X-Guardian-Phone': (session && session.guardianPhone) || '',
      'X-Guardian-Token': (session && session.token) || '',
    };
  }

  /* ---- 1단계: 본인 전화번호로 인증번호 요청 ---- */
  async function requestOtp() {
    const phone = $('guardianPhoneInput').value;
    const digits = phoneDigits(phone);
    if (!/^010\d{7,8}$/.test(digits)) return showConnectError('휴대폰 번호를 정확히 입력해주세요.', 'guardianPhoneInput');
    const button = $('requestOtpButton');
    button.disabled = true;
    button.textContent = '전송 중…';
    $('connectError').textContent = '';
    try {
      const response = await fetch(`${AI_WORKER_URL}/guardian/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.error === 'sms_failed') return showConnectError('인증번호 문자 발송에 실패했어요. 잠시 후 다시 시도해주세요.');
        return showConnectError('휴대폰 번호를 확인해주세요.', 'guardianPhoneInput');
      }
      pendingPhone = digits;
      $('otpTargetPhone').textContent = formatPhone(digits);
      showStep('otp');
      $('guardianOtpInput').focus();
    } catch {
      showConnectError('서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.');
    } finally {
      button.disabled = false;
      button.textContent = '인증번호 받기';
    }
  }

  let pendingPhone = '';

  /* ---- 2단계: 인증번호 확인 → 이 번호를 보호자로 등록해둔 어르신 계정을 자동으로 찾아 연결 ---- */
  async function verifyOtp() {
    const otp = $('guardianOtpInput').value.trim();
    if (!/^\d{6}$/.test(otp)) return showConnectError('인증번호 6자리를 입력해주세요.', 'guardianOtpInput');
    const button = $('verifyOtpButton');
    button.disabled = true;
    button.textContent = '확인 중…';
    $('connectError').textContent = '';
    try {
      const response = await fetch(`${AI_WORKER_URL}/guardian/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: pendingPhone, otp, guardianName: $('guardianNameInput').value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.error === 'otp_expired') return showConnectError('인증번호가 만료됐어요. 다시 받아주세요.');
        if (data.error === 'otp_locked') return showConnectError('너무 많이 틀렸어요. 잠시 후 다시 시도해주세요.');
        return showConnectError('인증번호가 올바르지 않아요.', 'guardianOtpInput');
      }
      const seniors = Array.isArray(data.seniors) ? data.seniors : [];
      if (seniors.length === 0) {
        return showConnectError('이 번호를 보호자로 등록해둔 어르신 계정을 찾지 못했어요. 어르신 설정 화면에 등록된 보호자 전화번호와 같은지 확인해주세요.');
      }
      const session = { guardianPhone: pendingPhone, guardianName: $('guardianNameInput').value.trim(), token: data.token, seniors, currentSeniorId: seniors.length === 1 ? seniors[0].id : null };
      saveSession(session);
      if (seniors.length > 1) {
        showSeniorSelect(seniors);
      } else {
        await loadSeniorState(session);
      }
    } catch {
      showConnectError('서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.');
    } finally {
      button.disabled = false;
      button.textContent = '확인';
    }
  }

  function showSeniorSelect(seniors) {
    $('seniorSelectList').innerHTML = seniors.map((s) => `
      <button type="button" class="senior-option" data-senior-id="${s.id}">${escapeHtml(s.name || '어르신')}</button>
    `).join('');
    showStep('select');
  }

  async function chooseSenior(seniorId) {
    const session = readSession();
    if (!session) return;
    session.currentSeniorId = Number(seniorId);
    saveSession(session);
    await loadSeniorState(session);
  }

  async function loadSeniorState(session) {
    try {
      const next = await fetchGuardianState(session);
      state = next;
      isDemo = false;
      openApp();
    } catch {
      showConnectError('연결 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
    }
  }

  async function fetchGuardianState(session) {
    if (!session || !session.token || !session.currentSeniorId) throw new Error('unauthorized');
    const response = await fetch(`${AI_WORKER_URL}/guardian/state?seniorId=${session.currentSeniorId}`, {
      method: 'GET',
      headers: guardianHeaders(session),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'connect_failed');
    return data;
  }

  function showConnectError(message, focusId) {
    $('connectError').textContent = message;
    const target = focusId && $(focusId);
    if (target) target.focus();
  }

  function showStep(name) {
    ['phone', 'otp', 'select'].forEach((step) => {
      $(`connectStep-${step}`).hidden = step !== name;
    });
    $('connectError').textContent = '';
  }

  function formatPhone(digits) {
    return digits.length >= 8 ? `${digits.slice(0, 3)}-${digits.slice(3, -4)}-${digits.slice(-4)}` : digits;
  }

  function openDemo() {
    state = JSON.parse(JSON.stringify(DEMO_STATE));
    isDemo = true;
    openApp();
  }

  function openApp() {
    $('connectScreen').hidden = true;
    $('guardianApp').hidden = false;
    window.scrollTo({ top: 0 });
    renderAll();
    startAutoRefresh();
  }

  async function refreshState(showMessage = false) {
    let refreshed = true;
    if (isDemo) {
      renderAll();
      if (showMessage) toast('미리보기 데이터입니다.');
      return;
    }
    const session = readSession();
    try {
      const beforeDanger = new Set((state && state.history || []).filter((h) => h.analysis && h.analysis.status === 'danger').map((h) => h.messageId));
      const next = await fetchGuardianState(session);
      state = next;
      const newDanger = (next.history || []).find((h) => h.analysis && h.analysis.status === 'danger' && !beforeDanger.has(h.messageId));
      if (newDanger) notifyNewDanger(newDanger);
    } catch (error) {
      refreshed = false;
      if (error && error.message === 'unauthorized') return disconnectLocal();
      if (showMessage) toast('서버 연결을 확인해주세요.');
    }
    renderAll();
    if (showMessage && refreshed) toast('최신 정보를 불러왔어요.');
  }

  function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshState(false);
    }, 30000);
  }

  function renderAll() {
    const profile = state.profile || {};
    const name = profile.name || '부모님';
    const session = readSession();
    const guardianName = (session && session.guardianName) || $('guardianNameInput').value.trim();
    $('guardianGreeting').textContent = guardianName ? `${guardianName}님, 안녕하세요` : '안녕하세요';
    $('profileButton').textContent = (guardianName || '보').trim().charAt(0) || '보';
    $('seniorName').textContent = `${name} 어르신`;
    $('seniorAvatar').textContent = name.trim().charAt(0) || '온';
    $('seniorMeta').textContent = [profile.age ? `${profile.age}세` : '', profile.region || '지역 미등록'].filter(Boolean).join(' · ');
    $('connectionText').textContent = isDemo ? '미리보기 데이터' : '부모님 앱과 연결됨';
    $('testControls').hidden = !isDemo;
    $('lastUpdatedText').textContent = formatUpdated(new Date());
    $('guardianCallLink').classList.add('disabled'); // 실제 어르신 전화번호는 보호자 화면에 내려주지 않는다(최소 노출 원칙)
    renderStatus();
    renderActivities();
    renderInbox();
    renderSchedules();
    renderStats();
  }

  function getStatus(entry) {
    return (entry && entry.analysis && entry.analysis.status) || 'normal';
  }

  function renderStatus() {
    const history = state.history || [];
    const danger = history.find((item) => getStatus(item) === 'danger');
    const card = $('statusCard');
    card.classList.toggle('danger', Boolean(danger));
    $('statusIcon').textContent = danger ? '!' : '✓';
    $('statusTitle').textContent = danger ? '확인이 필요한 위험 문자가 있어요' : '확인할 위험 알림이 없어요';
    $('statusDescription').textContent = danger
      ? ((danger.analysis && danger.analysis.headline) || danger.title || '내용을 확인하고 부모님께 연락해주세요.')
      : '최근 확인한 문서와 문자는 안전합니다.';
  }

  function activityKind(item) {
    const text = `${item.title || ''} ${item.analysis && item.analysis.headline || ''}`;
    return /📱|💬|문자/.test(text) ? 'message' : 'document';
  }

  function activityHtml(item, index) {
    const danger = getStatus(item) === 'danger';
    const kind = activityKind(item);
    const analysis = item.analysis || {};
    return `<button type="button" class="activity-item" data-history-index="${index}">
      <div class="activity-badge ${danger ? 'danger' : ''}">${danger ? '!' : kind === 'message' ? '✉' : '▤'}</div>
      <div class="activity-content">
        <strong>${escapeHtml(analysis.headline || item.title || '분석 기록')}</strong>
        <p class="${danger ? 'danger-text' : ''}">${escapeHtml(analysis.summary || (danger ? '보호자 확인이 필요합니다.' : '확인 완료'))}</p>
      </div>
      <div class="activity-meta">${formatActivityDate(item.createdAt)}</div>
    </button>`;
  }

  function renderActivities() {
    const history = state.history || [];
    $('homeActivityList').innerHTML = history.length
      ? history.slice(0, 3).map((item, index) => activityHtml(item, index)).join('')
      : emptyHtml('아직 분석 기록이 없어요.');
    const filtered = history.map((item, index) => ({ item, index })).filter(({ item }) => {
      if (historyFilter === 'all') return true;
      if (historyFilter === 'danger') return getStatus(item) === 'danger';
      return activityKind(item) === historyFilter;
    });
    $('historyList').innerHTML = filtered.length
      ? filtered.map(({ item, index }) => activityHtml(item, index)).join('')
      : emptyHtml('조건에 맞는 기록이 없어요.');
  }

  /* "받은 연락"은 별도 발신 데이터가 없어, 위험으로 판정된 기록만 모아 "확인이 필요한 알림함"으로 쓴다. */
  function renderInbox() {
    const messages = (state.history || []).filter((item) => getStatus(item) === 'danger');
    const unread = messages.filter((item) => !readThisSession.has(item.messageId)).length;
    $('unreadMessageCount').textContent = unread;
    $('inboxBadge').textContent = unread;
    $('inboxBadge').hidden = unread === 0;
    $('inboxList').innerHTML = messages.length ? messages.map((item) => {
      const analysis = item.analysis || {};
      const read = readThisSession.has(item.messageId);
      return `<button type="button" class="activity-item inbox-item ${read ? '' : 'unread'}" data-message-id="${escapeHtml(item.messageId)}">
        <div class="activity-badge danger">!</div>
        <div class="activity-content">
          <strong>${escapeHtml(analysis.headline || '위험 문자가 확인됐어요')}</strong>
          <p class="danger-text">${escapeHtml(analysis.summary || '내용을 확인해주세요.')}</p>
        </div>
        <div class="activity-meta">${formatActivityDate(item.createdAt)}</div>
      </button>`;
    }).join('') : emptyHtml('위험으로 확인된 알림이 없어요.');
  }

  function renderSchedules() {
    const schedules = (state.schedule || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    $('homeScheduleList').innerHTML = schedules.length
      ? schedules.slice(0, 4).map((item) => `<article class="schedule-item ${item.done ? 'done' : ''}">
          <div class="schedule-check">${item.done ? '✓' : ''}</div>
          <div class="activity-content"><strong>${escapeHtml(item.text || '할 일')}</strong><p>${escapeHtml(item.source || '')}</p></div>
          <div class="activity-meta">${formatScheduleDate(item.date)}<br>${escapeHtml(item.time || '')}</div>
        </article>`).join('')
      : emptyHtml('등록된 일정이 없어요.');
  }

  function renderStats() {
    const history = state.history || [];
    const schedules = state.schedule || [];
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = history.filter((item) => normalizeDate(item.createdAt).startsWith(month));
    const dangerCount = history.filter((item) => getStatus(item) === 'danger').length;
    const done = schedules.filter((item) => item.done).length;
    $('metricAnalyses').textContent = thisMonth.length || history.length;
    $('metricDanger').textContent = dangerCount;
    $('metricDone').textContent = done;
    $('metricPending').textContent = schedules.length - done;

    const weeks = [3, 2, 1, 0].map((offset) => {
      const end = new Date(); end.setDate(end.getDate() - offset * 7);
      const start = new Date(end); start.setDate(start.getDate() - 6);
      const count = history.filter((item) => {
        const date = new Date(item.createdAt || Date.now());
        return date >= start && date <= end;
      }).length;
      return { label: offset === 0 ? '이번 주' : `${offset + 1}주 전`, count };
    });
    const max = Math.max(1, ...weeks.map((week) => week.count));
    $('activityChart').innerHTML = weeks.map((week) => `<div class="bar-column">
      <div class="bar" style="height:${Math.max(8, week.count / max * 105)}px"><b>${week.count}</b></div>${week.label}
    </div>`).join('');

    const pending = schedules.filter((item) => !item.done).length;
    $('guardianSummary').innerHTML = [
      dangerCount ? `확인이 필요한 위험 문자 ${dangerCount}건이 있습니다.` : '최근 위험 문자 없이 안전하게 이용하고 있습니다.',
      pending ? `앞으로 해야 할 일정 ${pending}건이 남아 있습니다.` : '현재 남아 있는 일정이 없습니다.',
      history.length ? `문서와 문자 총 ${history.length}건을 확인했습니다.` : '첫 분석 기록을 기다리고 있습니다.'
    ].map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  }

  function openAnalysisDetail(analysis, meta) {
    if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0) {
      toast('이전 기록에는 상세 내용이 저장되어 있지 않아요.');
      return;
    }
    const danger = analysis.status === 'danger';
    $('detailType').textContent = (meta && meta.type) || '분석 결과';
    $('detailTitle').textContent = analysis.headline || '확인 내용';
    $('detailStatus').textContent = danger ? '⚠ 위험 감지' : analysis.status === 'info' ? '정보 확인' : '안전 확인';
    $('detailStatus').classList.toggle('danger', danger);
    $('detailSummary').textContent = analysis.summary || '저장된 요약 내용이 없습니다.';
    $('detailOriginalSection').hidden = true;

    const reasonSection = $('detailReasonSection');
    reasonSection.hidden = !danger;
    $('detailReason').textContent = danger
      ? (analysis.summary || '의심스러운 링크나 개인정보 요구가 포함되어 있을 수 있어 확인이 필요합니다.')
      : '';

    const checklist = Array.isArray(analysis.checklist) ? analysis.checklist : [];
    $('detailChecklistSection').hidden = checklist.length === 0;
    $('detailChecklist').innerHTML = checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

    const facts = [];
    if (analysis.category) facts.push(['문서 종류', analysis.category]);
    if (analysis.issuer) facts.push(['보낸 기관', analysis.issuer]);
    if (Number(analysis.amount) > 0) facts.push(['금액', `${Number(analysis.amount).toLocaleString('ko-KR')}원`]);
    if (analysis.dueDate) facts.push(['기한', analysis.dueDate]);
    if (analysis.phone) facts.push(['문의 전화', analysis.phone]);
    if (analysis.website) facts.push(['홈페이지', analysis.website]);
    $('detailFacts').hidden = facts.length === 0;
    $('detailFacts').innerHTML = facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    $('detailModal').hidden = false;
  }

  function closeDetail() {
    $('detailModal').hidden = true;
  }

  function openHistoryDetail(index) {
    const item = (state.history || [])[index];
    if (!item) return;
    openAnalysisDetail(item.analysis, { type: activityKind(item) === 'message' ? '문자 분석 기록' : '문서 분석 기록' });
  }

  function markRead(messageId, session) {
    if (isDemo || !session || !session.currentSeniorId) return;
    fetch(`${AI_WORKER_URL}/guardian/mark-read`, {
      method: 'POST',
      headers: guardianHeaders(session),
      body: JSON.stringify({ seniorId: session.currentSeniorId, messageId }),
    }).catch(() => {});
  }

  function openInboxDetail(id) {
    const item = (state.history || []).find((h) => String(h.messageId) === String(id));
    if (!item) return;
    readThisSession.add(String(id));
    markRead(id, readSession());
    renderInbox();
    openAnalysisDetail(item.analysis, { type: '위험 알림' });
  }

  function switchView(name) {
    document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
    document.querySelectorAll('.guardian-nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    const target = $(`view${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    if (target) target.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function emptyHtml(message) {
    return `<div class="empty-card">${escapeHtml(message)}</div>`;
  }

  function normalizeDate(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }

  function formatActivityDate(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    const diff = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (diff <= 0) return '오늘';
    if (diff === 1) return '어제';
    return `${date.getMonth() + 1}.${date.getDate()}`;
  }

  function formatScheduleDate(value) {
    if (!value) return '날짜 없음';
    const date = new Date(`${value}T00:00:00`);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function formatUpdated(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 업데이트`;
  }

  let toastTimer;
  function toast(message) {
    const element = $('guardianToast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 1800);
  }

  function notifyNewDanger(item) {
    toast('부모님에게 새 위험 알림이 도착했어요.');
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const analysis = item && item.analysis || {};
    new Notification('온담 보호자 · 위험 확인 필요', {
      body: analysis.headline || analysis.summary || '부모님에게 위험한 문서·문자가 확인됐습니다.',
      tag: `ondam-danger-${item.messageId || Date.now()}`,
    });
  }

  function disconnectLocal() {
    clearInterval(refreshTimer);
    clearSession();
    location.href = 'guardian.html';
  }

  function openGuide() { $('guideModal').hidden = false; }
  function closeGuide() { $('guideModal').hidden = true; }

  $('requestOtpButton').addEventListener('click', requestOtp);
  $('verifyOtpButton').addEventListener('click', verifyOtp);
  $('backToPhoneButton').addEventListener('click', () => showStep('phone'));
  $('resendOtpButton').addEventListener('click', requestOtp);
  $('seniorSelectList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-senior-id]');
    if (button) chooseSenior(button.dataset.seniorId);
  });
  $('demoButton').addEventListener('click', openDemo);
  document.querySelectorAll('.guardian-nav button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-view-target]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.viewTarget)));
  $('historyFilters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    historyFilter = button.dataset.filter;
    document.querySelectorAll('#historyFilters button').forEach((item) => item.classList.toggle('active', item === button));
    renderActivities();
  });
  $('homeActivityList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-history-index]');
    if (item) openHistoryDetail(Number(item.dataset.historyIndex));
  });
  $('historyList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-history-index]');
    if (item) openHistoryDetail(Number(item.dataset.historyIndex));
  });
  $('inboxList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-message-id]');
    if (item) openInboxDetail(item.dataset.messageId);
  });
  $('refreshDataButton').addEventListener('click', () => refreshState(true));
  $('connectionGuideButton').addEventListener('click', openGuide);
  $('profileButton').addEventListener('click', () => switchView('more'));
  $('closeGuideButton').addEventListener('click', closeGuide);
  $('confirmGuideButton').addEventListener('click', closeGuide);
  $('guideModal').addEventListener('click', (event) => { if (event.target === $('guideModal')) closeGuide(); });
  $('closeDetailButton').addEventListener('click', closeDetail);
  $('confirmDetailButton').addEventListener('click', closeDetail);
  $('detailModal').addEventListener('click', (event) => { if (event.target === $('detailModal')) closeDetail(); });
  $('notificationToggle').addEventListener('click', async () => {
    const toggle = $('notificationToggle').querySelector('.toggle');
    const nextEnabled = !toggle.classList.contains('on');
    if (nextEnabled && 'Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    toggle.classList.toggle('on', nextEnabled);
    $('notificationState').textContent = nextEnabled ? '새 위험 문자가 있으면 알려드려요' : '위험 알림이 꺼져 있어요';
    toast(nextEnabled ? '위험 알림을 켰어요.' : '위험 알림을 껐어요.');
  });
  $('disconnectButton').addEventListener('click', disconnectLocal);
  $('exitDemoButton').addEventListener('click', () => location.replace(location.pathname));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state) refreshState(false);
  });

  (function bootstrap() {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') return openDemo();

    const session = readSession();
    if (session && session.token && session.currentSeniorId) {
      loadSeniorState(session);
    } else if (session && session.seniors && session.seniors.length > 1) {
      showSeniorSelect(session.seniors);
    }
  })();
})();
