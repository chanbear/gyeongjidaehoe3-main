(() => {
  'use strict';

  const GUARDIAN_SESSION_KEY = 'ondam_guardian_session_v1';
  const GUARDIAN_STATE_KEY = 'ondam_guardian_state_v1';
  const AUTH_KEY = 'ai_helper_auth_v1';
  const AI_WORKER_URL = 'https://ondam-ai.kke88084.workers.dev';

  let state = null;
  let pendingCandidate = null;
  let historyFilter = 'all';
  let refreshTimer = null;

  const $ = (id) => document.getElementById(id);
  const phoneDigits = (value) => String(value || '').replace(/\D/g, '');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function readGuardianSession() {
    try {
      const raw = localStorage.getItem(GUARDIAN_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function readAccount() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function accountHeaders(account) {
    return {
      'Content-Type': 'application/json',
      'X-User-Id': String(account && account.userId || ''),
      'X-Auth-Token': account && account.token || '',
    };
  }

  function guardianHeaders(session) {
    return {
      'Content-Type': 'application/json',
      'X-Guardian-Token': session && session.token || '',
    };
  }

  async function fetchGuardianState(session) {
    if (!session || !session.token) throw new Error('unauthorized');
    const response = await fetch(`${AI_WORKER_URL}/guardian-state`, {
      method: 'GET',
      headers: guardianHeaders(session),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'connect_failed');
    return data.state;
  }

  function showElderLookupForm() {
    $('guardianMatchLookup').hidden = false;
    $('guardianMatchLoading').hidden = true;
    $('guardianMatchQuestion').hidden = true;
    $('guardianMatchEmpty').hidden = true;
    $('connectError').textContent = '';
  }

  async function submitElderLookup() {
    const account = readAccount();
    const name = $('elderLookupName').value.trim();
    const phone = $('elderLookupPhone').value;
    $('connectError').textContent = '';
    if (!name) return showConnectError('어르신 이름을 입력해주세요.', 'elderLookupName');
    if (phoneDigits(phone).length < 9) return showConnectError('어르신 전화번호를 정확히 입력해주세요.', 'elderLookupPhone');
    $('guardianMatchLookup').hidden = true;
    await loadGuardianCandidates(account, name, phone);
  }

  async function loadGuardianCandidates(account, seniorName, seniorPhone) {
    $('guardianMatchLookup').hidden = true;
    $('guardianMatchLoading').hidden = false;
    $('guardianMatchQuestion').hidden = true;
    $('guardianMatchEmpty').hidden = true;
    $('connectError').textContent = '';
    pendingCandidate = null;
    try {
      const response = await fetch(`${AI_WORKER_URL}/guardian-candidates`, {
        method: 'POST',
        headers: accountHeaders(account),
        body: JSON.stringify({ seniorName, seniorPhone }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || 'guardian_candidates_failed');
        error.status = response.status;
        throw error;
      }
      pendingCandidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
      $('guardianMatchLoading').hidden = true;
      if (!pendingCandidate) {
        $('guardianMatchEmpty').hidden = false;
        return;
      }
      $('guardianCandidateName').textContent = `${pendingCandidate.seniorName || '어르신'} 어르신`;
      $('guardianMatchQuestion').hidden = false;
    } catch (error) {
      $('guardianMatchLoading').hidden = true;
      $('guardianMatchEmpty').hidden = false;
      if (error && (error.status === 401 || error.message === 'guardian_only')) {
        logoutGuardian();
        return;
      }
      showConnectError('연결 정보를 불러오지 못했어요. 잠시 후 다시 확인해주세요.');
    }
  }

  async function confirmGuardianCandidate() {
    const account = readAccount();
    if (!account || !pendingCandidate) return;
    const button = $('confirmGuardianButton');
    button.disabled = true;
    button.textContent = '연결하고 있어요…';
    $('connectError').textContent = '';
    try {
      const response = await fetch(`${AI_WORKER_URL}/guardian-confirm-link`, {
        method: 'POST',
        headers: accountHeaders(account),
        body: JSON.stringify({ seniorUserId: pendingCandidate.seniorUserId, confirmed: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'guardian_confirm_failed');
      localStorage.setItem(GUARDIAN_SESSION_KEY, JSON.stringify(data.session));
      localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(data.state));
      state = data.state;
      openApp();
    } catch (error) {
      if (error.message === 'guardian_information_mismatch' || error.message === 'not_found') {
        return showConnectError('어르신이 저장한 보호자 정보가 변경됐어요. 다시 확인해주세요.');
      }
      showConnectError('연결하지 못했어요. 잠시 후 다시 시도해주세요.');
    } finally {
      button.disabled = false;
      button.textContent = '예, 맞습니다';
    }
  }

  function rejectGuardianCandidate() {
    pendingCandidate = null;
    $('guardianMatchQuestion').hidden = true;
    $('guardianMatchEmpty').hidden = false;
    $('guardianMatchEmpty').querySelector('strong').textContent = '이 어르신과 연결하지 않았어요';
    $('guardianMatchEmpty').querySelector('p').textContent = '어르신 앱의 보호자 정보를 확인한 뒤 다시 확인해주세요.';
  }

  function showConnectError(message, focusId) {
    $('connectError').textContent = message;
    const target = $(focusId);
    if (target) target.focus();
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
    const session = readGuardianSession();
    try {
      const beforeIds = new Set(((state && state.guardianInbox) || []).map((message) => String(message.id)));
      const next = await fetchGuardianState(session);
      if (next) {
        state = next;
        localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(next));
        const newDanger = (next.guardianInbox || []).find((message) =>
          !beforeIds.has(String(message.id)) && message.analysis && message.analysis.status === 'danger'
        );
        if (newDanger) notifyNewDanger(newDanger);
      }
    } catch (error) {
      refreshed = false;
      if (error && error.message === 'unauthorized') disconnectLocal();
      else if (showMessage) toast('서버 연결을 확인해주세요.');
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
    const guardian = state.guardian || {};
    const name = profile.name || '부모님';
    $('guardianGreeting').textContent = `${guardian.name || '보호자'}님, 안녕하세요`;
    $('profileButton').textContent = (guardian.name || '보').trim().charAt(0);
    $('seniorName').textContent = `${name} 어르신`;
    $('seniorAvatar').textContent = name.trim().charAt(0) || '온';
    $('seniorMeta').textContent = [profile.age ? `${profile.age}세` : '', profile.region || '지역 미등록'].filter(Boolean).join(' · ');
    $('connectionText').textContent = '부모님 앱과 연결됨';
    const updatedValue = state.updatedAt && String(state.updatedAt).replace(' ', 'T') + (String(state.updatedAt).includes('Z') ? '' : 'Z');
    const updatedDate = new Date(updatedValue || Date.now());
    $('lastUpdatedText').textContent = formatUpdated(Number.isNaN(updatedDate.getTime()) ? new Date() : updatedDate);
    const elderPhone = phoneDigits(state.senior && state.senior.phone);
    $('guardianCallLink').href = elderPhone ? `tel:${elderPhone}` : '#';
    $('guardianCallLink').classList.toggle('disabled', !elderPhone);
    const notificationEnabled = state.guardian && state.guardian.notificationEnabled !== false;
    const notificationToggle = $('notificationToggle').querySelector('.toggle');
    notificationToggle.classList.toggle('on', notificationEnabled);
    $('notificationState').textContent = notificationEnabled ? '새 위험 문자가 있으면 알려드려요' : '위험 알림이 꺼져 있어요';
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
    const unreadDanger = (state.guardianInbox || []).find((item) =>
      !item.read && item.analysis && item.analysis.status === 'danger'
    );
    const recentDanger = (state.history || []).find((item) => {
      if (getStatus(item) !== 'danger') return false;
      const timestamp = new Date(item.createdAt || item.ts || 0).getTime();
      return timestamp && Date.now() - timestamp < 24 * 60 * 60 * 1000;
    });
    const danger = unreadDanger || recentDanger;
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

  async function openInboxDetail(id) {
    const message = (state.guardianInbox || []).find((item) => String(item.id) === String(id));
    if (!message) return;
    message.read = true;
    localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(state));
    const session = readGuardianSession();
    fetch(`${AI_WORKER_URL}/guardian-message-read`, {
      method: 'POST',
      headers: guardianHeaders(session),
      body: JSON.stringify({ messageId: String(id) }),
    }).catch(() => { });
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

  function notifyNewDanger(message) {
    toast('부모님에게 새 위험 연락이 도착했어요.');
    const enabled = state && state.guardian && state.guardian.notificationEnabled !== false;
    if (!enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const analysis = message && message.analysis || {};
    new Notification('온담 보호자 · 위험 확인 필요', {
      body: analysis.headline || analysis.summary || '부모님이 위험한 문자를 공유했습니다.',
      tag: `ondam-danger-${message.id || Date.now()}`,
    });
  }

  function disconnectLocal() {
    clearInterval(refreshTimer);
    localStorage.removeItem(GUARDIAN_SESSION_KEY);
    localStorage.removeItem(GUARDIAN_STATE_KEY);
    location.href = 'guardian.html';
  }

  function logoutGuardian() {
    clearInterval(refreshTimer);
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(GUARDIAN_SESSION_KEY);
    localStorage.removeItem(GUARDIAN_STATE_KEY);
    location.replace('index.html');
  }

  async function resumeGuardianAccount(account) {
    const response = await fetch(`${AI_WORKER_URL}/guardian-resume`, {
      method: 'POST',
      headers: accountHeaders(account),
      body: '{}',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'guardian_resume_failed');
      error.status = response.status;
      throw error;
    }
    localStorage.setItem(GUARDIAN_SESSION_KEY, JSON.stringify(data.session));
    localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(data.state));
    return data.state;
  }

  function renderGuardianAccount(account) {
    $('guardianAccountCard').hidden = false;
    $('guardianAccountName').textContent = `${account.name || '보호자'}님`;
    const digits = phoneDigits(account.phone);
    $('guardianAccountPhone').textContent = digits.length >= 8
      ? `${digits.slice(0, 3)}-${digits.slice(3, -4)}-${digits.slice(-4)}`
      : digits;
  }

  function openGuide() { $('guideModal').hidden = false; }
  function closeGuide() { $('guideModal').hidden = true; }

  $('confirmGuardianButton').addEventListener('click', confirmGuardianCandidate);
  $('rejectGuardianButton').addEventListener('click', rejectGuardianCandidate);
  $('elderLookupButton').addEventListener('click', submitElderLookup);
  $('retryGuardianButton').addEventListener('click', showElderLookupForm);
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
  $('detailPhoto').addEventListener('click', () => $('detailPhoto').classList.toggle('zoomed'));
  $('notificationToggle').addEventListener('click', async () => {
    const toggle = $('notificationToggle').querySelector('.toggle');
    const nextEnabled = !toggle.classList.contains('on');
    if (nextEnabled && 'Notification' in window && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission === 'denied') toast('기기 알림 권한은 꺼져 있지만 앱 안의 새 연락 표시는 유지됩니다.');
    }
    toggle.classList.toggle('on', nextEnabled);
    if (state.guardian) state.guardian.notificationEnabled = nextEnabled;
    $('notificationState').textContent = nextEnabled ? '새 위험 문자가 있으면 알려드려요' : '위험 알림이 꺼져 있어요';
    const session = readGuardianSession();
    try {
      const response = await fetch(`${AI_WORKER_URL}/guardian-settings`, {
        method: 'POST',
        headers: guardianHeaders(session),
        body: JSON.stringify({ notificationEnabled: nextEnabled }),
      });
      if (!response.ok) throw new Error('settings_failed');
    } catch {
      toggle.classList.toggle('on', !nextEnabled);
      if (state.guardian) state.guardian.notificationEnabled = !nextEnabled;
      return toast('알림 설정을 저장하지 못했어요.');
    }
    localStorage.setItem(GUARDIAN_STATE_KEY, JSON.stringify(state));
    toast(nextEnabled ? '위험 알림을 켰어요.' : '위험 알림을 껐어요.');
  });
  $('disconnectButton').addEventListener('click', async () => {
    const session = readGuardianSession();
    await fetch(`${AI_WORKER_URL}/guardian-disconnect`, {
      method: 'POST',
      headers: guardianHeaders(session),
      body: '{}',
    }).catch(() => { });
    disconnectLocal();
  });
  $('guardianLogoutButton').addEventListener('click', logoutGuardian);
  $('connectLogoutButton').addEventListener('click', logoutGuardian);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state) refreshState(false);
  });

  async function bootstrapGuardian() {
    const account = readAccount();
    if (!account || account.role !== 'guardian') {
      location.replace('index.html');
      return;
    }
    renderGuardianAccount(account);
    const session = readGuardianSession();
    const elder = JSON.parse(localStorage.getItem(GUARDIAN_STATE_KEY) || 'null');
    if (session && session.token && elder) {
      state = elder;
      openApp();
      refreshState(false);
    } else if (session) {
      localStorage.removeItem(GUARDIAN_SESSION_KEY);
      localStorage.removeItem(GUARDIAN_STATE_KEY);
    }
    if (!state) {
      try {
        state = await resumeGuardianAccount(account);
        openApp();
      } catch (error) {
        if (error && error.status === 401) {
          logoutGuardian();
          return;
        }
        if (!error || error.message !== 'no_guardian_link') {
          showConnectError('연결 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
          return;
        }
        showElderLookupForm();
      }
    }
  }
  bootstrapGuardian().catch(() => showConnectError('보호자 화면을 시작하지 못했어요.'));
})();
