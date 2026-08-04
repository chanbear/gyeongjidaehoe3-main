(() => {
  'use strict';

  const ELDER_STATE_KEY = 'ai_helper_state_v1';
  const ELDER_AUTH_KEY = 'ai_helper_auth_v1';
  const GUARDIAN_SESSION_KEY = 'ondam_guardian_session_v1';
  const GUARDIAN_STATE_KEY = 'ondam_guardian_state_v1';
  const AI_WORKER_URL = 'https://ondam-ai.kke88084.workers.dev';
  const DEMO_STATE = {
    profile: { name: '김온담', gender: '여성', age: 72, region: '경기도 안산시' },
    guardian: { name: '김민수', phone: '010-1234-5678' },
    history: [
      { title: '📱 택배 사칭 의심 문자', status: '🔴 위험', createdAt: new Date().toISOString(), analysis: { status: 'danger', headline: '개인정보를 요구하는 위험한 문자예요', summary: '출처가 불분명한 링크가 포함되어 있어 누르지 않는 것이 안전합니다.' } },
      { title: '📄 건강검진 안내', status: '🔵 확인', createdAt: new Date(Date.now() - 86400000).toISOString(), photoPreview: 'assets/demo-health-check.jpg', analysis: { status: 'normal', headline: '건강검진 예약 안내', summary: '가까운 검진기관에 예약하고 신분증을 준비해주세요.', checklist: ['검진기관에 예약하기', '검진 당일 신분증 준비하기'], dueDate: dateOffset(12), amount: 0 } },
      { title: '💬 병원 예약 안내 문자', status: '🟢 정상', createdAt: new Date(Date.now() - 129600000).toISOString(), analysis: { status: 'normal', headline: '병원 진료 예약 안내예요', summary: '내일 오전 10시 진료 예약을 알려주는 정상적인 안내 문자입니다.', originalText: '[온담병원] 내일 오전 10시 내과 진료가 예약되어 있습니다. 방문 시 신분증을 지참해주세요.', checklist: ['예약 시간 10분 전에 도착하기', '신분증 챙기기'] } },
      { title: '📄 도시가스 고지서', status: '🔵 확인', createdAt: new Date(Date.now() - 172800000).toISOString(), analysis: { status: 'normal', headline: '도시가스 요금 안내', summary: '납부기한 전까지 요금을 납부해주세요.', dueDate: dateOffset(7), amount: 34800 } },
      { title: '💬 기초연금 안내 문자', status: '⚪ 정보', createdAt: new Date(Date.now() - 259200000).toISOString(), analysis: { status: 'info', headline: '기초연금 신청 안내예요', summary: '주민센터에서 기초연금 상담을 받을 수 있다는 공공 안내 문자입니다.', originalText: '[복지 안내] 만 65세 이상 어르신은 주소지 주민센터에서 기초연금 상담을 받을 수 있습니다.', checklist: ['신분증을 준비하기', '주소지 주민센터에 문의하기'] } }
    ],
    schedule: [
      { text: '건강검진 예약하기', source: '건강검진 안내', date: dateOffset(3), time: '10:00', done: false },
      { text: '도시가스 요금 납부', source: '도시가스 고지서', date: dateOffset(7), time: '09:00', done: false },
      { text: '신분증 준비하기', source: '건강검진 안내', date: dateOffset(-1), time: '18:00', done: true }
    ],
    guardianInbox: [
      { id: 'demo-message-1', kind: 'message', action: '보호자에게 알리기', sentAt: Date.now(), read: false,
        analysis: { status: 'danger', headline: '개인정보를 요구하는 위험한 문자예요', summary: '출처가 불분명한 링크가 포함되어 있어 누르지 않는 것이 안전합니다.', originalText: '[택배안내] 주소 오류로 배송이 중단되었습니다. 아래 링크에서 주소와 카드 정보를 다시 입력해주세요. http://example.invalid', checklist: ['링크를 누르지 않기', '발신 기관에 직접 전화해 확인하기'] } },
      { id: 'demo-document-1', kind: 'document', action: '자녀에게 보내기', sentAt: Date.now() - 3600000, read: false,
        image: 'assets/demo-health-check.jpg',
        analysis: { status: 'normal', headline: '건강검진 예약 안내', summary: '건강검진 대상 안내문입니다. 검진기관에 예약하고 신분증을 준비해주세요.', checklist: ['검진기관에 예약하기', '검진 당일 신분증 준비하기'], dueDate: dateOffset(12), category: '안내문' } },
      { id: 'demo-message-2', kind: 'message', action: '자녀에게 보내기', sentAt: Date.now() - 7200000, read: true,
        analysis: { status: 'normal', headline: '병원 진료 예약 안내예요', summary: '내일 오전 10시 진료 예약을 알려주는 정상적인 안내 문자입니다.', originalText: '[온담병원] 내일 오전 10시 내과 진료가 예약되어 있습니다. 방문 시 신분증을 지참해주세요.', checklist: ['예약 시간 10분 전에 도착하기', '신분증 챙기기'] } },
      { id: 'demo-message-3', kind: 'message', action: '보호자에게 알리기', sentAt: Date.now() - 86400000, read: true,
        analysis: { status: 'info', headline: '기초연금 신청 안내예요', summary: '주민센터에서 기초연금 상담을 받을 수 있다는 공공 안내 문자입니다.', originalText: '[복지 안내] 만 65세 이상 어르신은 주소지 주민센터에서 기초연금 상담을 받을 수 있습니다.', checklist: ['신분증을 준비하기', '주소지 주민센터에 문의하기'] } }
    ]
  };

  let state = null;
  let isDemo = false;
  let historyFilter = 'all';

  const $ = (id) => document.getElementById(id);
  const phoneDigits = (value) => String(value || '').replace(/\D/g, '');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  function dateOffset(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function readElderState() {
    try {
      const raw = localStorage.getItem(ELDER_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function readElderAccount() {
    try {
      const raw = localStorage.getItem(ELDER_AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function fetchGuardianState(phone) {
    // 로컬에서 어르신 앱과 보호자 앱을 함께 시험할 때는 같은 브라우저의 가입 정보를 먼저 쓴다.
    // 이렇게 하면 Cloudflare Worker의 localhost CORS 허용 여부와 관계없이 실제로 가입한 번호로 연결할 수 있다.
    const entered = phoneDigits(phone);
    const localAccount = readElderAccount();
    const localPhone = phoneDigits(localAccount && localAccount.phone);
    const localState = readElderState();
    if (localAccount && localState && localPhone && localPhone === entered) {
      return localState;
    }

    const response = await fetch(`${AI_WORKER_URL}/guardian-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'connect_failed');
    return data.state;
  }

  async function connect(phone) {
    const entered = phoneDigits(phone);
    if (entered.length < 9) return showConnectError('어르신 전화번호를 정확히 입력해주세요.');
    $('connectError').textContent = '어르신 계정을 확인하고 있어요.';
    let elder;
    try {
      elder = await fetchGuardianState(entered);
    } catch (error) {
      if (error.message === 'not_found') return showConnectError('해당 전화번호로 가입한 어르신 계정을 찾지 못했어요.');
      return showConnectError('서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.');
    }
    localStorage.setItem(GUARDIAN_SESSION_KEY, JSON.stringify({ elderPhone: entered, connectedAt: Date.now() }));
    localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(elder));
    state = elder;
    isDemo = false;
    openApp();
  }

  function showConnectError(message) {
    $('connectError').textContent = message;
    $('guardianPhoneLogin').focus();
  }

  function openDemo() {
    state = JSON.parse(JSON.stringify(DEMO_STATE));
    isDemo = true;
    openApp();
  }

  function addTestMessage() {
    if (!isDemo) return;
    state.guardianInbox.unshift({
      id: `test-${Date.now()}`,
      kind: 'message',
      action: '보호자에게 알리기',
      sentAt: Date.now(),
      read: false,
      analysis: {
        status: 'danger',
        headline: '결제를 요구하는 의심 문자예요',
        summary: '갑자기 결제를 요구하고 낯선 링크를 보내 주의가 필요합니다.',
        originalText: '[긴급 결제 안내] 미납 요금이 있습니다. 오늘 안에 아래 링크에서 카드번호를 입력해주세요. http://example.invalid/pay',
        checklist: ['링크를 누르지 않기', '카드번호를 입력하지 않기', '보호자와 함께 발신 기관에 확인하기']
      }
    });
    renderAll();
    switchView('inbox');
    toast('새 위험 연락이 도착했어요.');
  }

  function resetTestData() {
    state = JSON.parse(JSON.stringify(DEMO_STATE));
    isDemo = true;
    renderAll();
    switchView('home');
    toast('테스트 자료를 다시 채웠어요.');
  }

  function openApp() {
    $('connectScreen').hidden = true;
    $('guardianApp').hidden = false;
    window.scrollTo({ top: 0 });
    renderAll();
  }

  async function refreshState(showMessage = false) {
    if (!isDemo) {
      const session = JSON.parse(localStorage.getItem(GUARDIAN_SESSION_KEY) || 'null');
      try {
        const next = await fetchGuardianState(session && session.elderPhone);
        if (next) {
          state = next;
          localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(next));
        }
      } catch {}
    }
    renderAll();
    if (showMessage) toast('최신 정보를 불러왔어요.');
  }

  function renderAll() {
    const profile = state.profile || {};
    const guardian = state.guardian || {};
    const name = profile.name || '부모님';
    $('guardianGreeting').textContent = `${guardian.name || '보호자'}님, 안녕하세요`;
    $('profileButton').textContent = (guardian.name || '보').trim().charAt(0);
    $('seniorName').textContent = `${name} 어르신`;
    $('seniorAvatar').textContent = name.trim().charAt(0) || '온';
    $('seniorMeta').textContent = [profile.age ? `${profile.age}세` : '', profile.region || '지역 미등록'].filter(Boolean).join(' · ');
    $('connectionText').textContent = isDemo ? '미리보기 데이터' : '부모님 앱과 연결됨';
    $('testControls').hidden = !isDemo;
    $('lastUpdatedText').textContent = formatUpdated(new Date());
    const elderAccount = readElderAccount();
    const elderPhone = phoneDigits(elderAccount && elderAccount.phone);
    $('guardianCallLink').href = elderPhone ? `tel:${elderPhone}` : 'index.html';
    renderStatus();
    renderActivities();
    renderInbox();
    renderSchedules();
    renderStats();
  }

  function getStatus(entry) {
    return (entry && entry.analysis && entry.analysis.status) || (/위험/.test(entry && entry.status || '') ? 'danger' : 'normal');
  }

  function renderStatus() {
    const danger = (state.history || []).find((item) => getStatus(item) === 'danger');
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
    const image = item.photoPreview;
    return `<button type="button" class="activity-item" data-history-index="${index}">
      <div class="activity-badge ${danger ? 'danger' : ''} ${image ? 'has-image' : ''}">${image ? `<img src="${escapeHtml(image)}" alt="">` : danger ? '!' : kind === 'message' ? '✉' : '▤'}</div>
      <div class="activity-content">
        <strong>${escapeHtml(analysis.headline || item.title || '분석 기록')}</strong>
        <p class="${danger ? 'danger-text' : ''}">${escapeHtml(analysis.summary || (danger ? '보호자 확인이 필요합니다.' : '확인 완료'))}</p>
      </div>
      <div class="activity-meta">${formatActivityDate(item.createdAt || item.ts)}</div>
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

  function renderInbox() {
    const messages = state.guardianInbox || [];
    const unread = messages.filter((message) => !message.read).length;
    $('unreadMessageCount').textContent = unread;
    $('inboxBadge').textContent = unread;
    $('inboxBadge').hidden = unread === 0;
    $('inboxList').innerHTML = messages.length ? messages.map((message) => {
      const analysis = message.analysis || {};
      const danger = analysis.status === 'danger';
      return `<button type="button" class="activity-item inbox-item ${message.read ? '' : 'unread'}" data-message-id="${escapeHtml(message.id)}">
        <div class="activity-badge ${danger ? 'danger' : ''} ${message.image ? 'has-image' : ''}">${message.image ? `<img src="${escapeHtml(message.image)}" alt="">` : danger ? '!' : message.kind === 'document' ? '▤' : '✉'}</div>
        <div class="activity-content">
          <strong>${escapeHtml(analysis.headline || '부모님이 확인 결과를 보냈어요')}</strong>
          <p class="${danger ? 'danger-text' : ''}">${escapeHtml(message.action || '보호자에게 알리기')} · ${escapeHtml(analysis.summary || message.body || '내용을 확인해주세요.')}</p>
        </div>
        <div class="activity-meta">${formatActivityDate(message.sentAt)}</div>
      </button>`;
    }).join('') : emptyHtml('아직 부모님에게 받은 연락이 없어요. 부모님이 분석 결과에서 보호자에게 알리기를 누르면 여기에 표시됩니다.');
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
    $('detailType').textContent = meta && meta.type || '분석 결과';
    $('detailTitle').textContent = analysis.headline || '확인 내용';
    $('detailStatus').textContent = danger ? '⚠ 위험 감지' : analysis.status === 'info' ? '정보 확인' : '안전 확인';
    $('detailStatus').classList.toggle('danger', danger);
    $('detailSummary').textContent = analysis.summary || '저장된 요약 내용이 없습니다.';
    const originalText = String(analysis.originalText || '').trim();
    $('detailOriginalSection').hidden = !originalText;
    $('detailOriginalText').textContent = originalText;
    const detailImage = meta && meta.image;
    $('detailPhotoWrap').hidden = !detailImage;
    $('detailPhoto').classList.remove('zoomed');
    if (detailImage) $('detailPhoto').src = detailImage;
    else $('detailPhoto').removeAttribute('src');

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
    openAnalysisDetail(item.analysis, {
      type: activityKind(item) === 'message' ? '문자 분석 기록' : '문서 분석 기록',
      image: item.photoPreview || (item.analysis && item.analysis.photoPreview)
    });
  }

  function openInboxDetail(id) {
    const message = (state.guardianInbox || []).find((item) => String(item.id) === String(id));
    if (!message) return;
    message.read = true;
    if (!isDemo) localStorage.setItem(ELDER_STATE_KEY, JSON.stringify(state));
    renderInbox();
    openAnalysisDetail(message.analysis, {
      type: message.kind === 'document' ? '부모님이 보낸 문서' : '부모님이 보낸 문자',
      image: message.image
    });
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

  function openGuide() { $('guideModal').hidden = false; }
  function closeGuide() { $('guideModal').hidden = true; }

  $('connectForm').addEventListener('submit', (event) => {
    event.preventDefault();
    connect($('guardianPhoneLogin').value);
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
  $('addTestMessageButton').addEventListener('click', addTestMessage);
  $('resetTestDataButton').addEventListener('click', resetTestData);
  $('connectionGuideButton').addEventListener('click', openGuide);
  $('profileButton').addEventListener('click', () => switchView('more'));
  $('closeGuideButton').addEventListener('click', closeGuide);
  $('confirmGuideButton').addEventListener('click', closeGuide);
  $('guideModal').addEventListener('click', (event) => { if (event.target === $('guideModal')) closeGuide(); });
  $('closeDetailButton').addEventListener('click', closeDetail);
  $('confirmDetailButton').addEventListener('click', closeDetail);
  $('detailModal').addEventListener('click', (event) => { if (event.target === $('detailModal')) closeDetail(); });
  $('detailPhoto').addEventListener('click', () => $('detailPhoto').classList.toggle('zoomed'));
  $('notificationToggle').addEventListener('click', () => {
    const toggle = $('notificationToggle').querySelector('.toggle');
    toggle.classList.toggle('on');
    $('notificationState').textContent = toggle.classList.contains('on') ? '새 위험 문자가 있으면 알려드려요' : '위험 알림이 꺼져 있어요';
    toast(toggle.classList.contains('on') ? '위험 알림을 켰어요.' : '위험 알림을 껐어요.');
  });
  $('disconnectButton').addEventListener('click', () => {
    localStorage.removeItem(GUARDIAN_SESSION_KEY);
    localStorage.removeItem(GUARDIAN_STATE_KEY);
    sessionStorage.removeItem('ondam_guardian_demo');
    location.href = 'guardian.html';
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== ELDER_STATE_KEY || isDemo) return;
    const beforeUnread = (state && state.guardianInbox || []).filter((message) => !message.read).length;
    refreshState(false);
    const afterUnread = (state.guardianInbox || []).filter((message) => !message.read).length;
    if (afterUnread > beforeUnread) toast('부모님에게 새 연락이 도착했어요.');
  });

  try {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') {
      openDemo();
      return;
    }
    const session = JSON.parse(localStorage.getItem(GUARDIAN_SESSION_KEY) || 'null');
    const elder = JSON.parse(localStorage.getItem(GUARDIAN_STATE_KEY) || 'null');
    const savedElderPhone = phoneDigits(session && (session.elderPhone || session.phone));
    if (session && elder && savedElderPhone) {
      state = elder;
      openApp();
      refreshState(false);
    }
  } catch {}
})();
