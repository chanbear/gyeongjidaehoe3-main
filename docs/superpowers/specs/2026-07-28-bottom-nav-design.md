# 하단 네비게이션 바 도입 및 홈 화면 정리

날짜: 2026-07-28

## 배경

홈 화면이 혼잡하다는 문제 제기에서 출발했다. iPhone 15 뷰포트(393×852)에서 실측한 결과:

| 항목 | 값 |
|---|---|
| `screen-home` 전체 높이 | 1,752px = **2.06 화면분** |
| 누를 수 있는 요소 | 16개 |
| 섹션 제목 | 4개 |

높이 배분을 보면 문제가 분명하다.

| 블록 | 높이 | 비중 |
|---|---|---|
| 기능 카드 3개 (문서·문자·주변) | 353px | 20% |
| 오늘 해야 할 일 | 168px | 10% |
| 어르신을 위한 정보 | 376px | 21% |
| 근처 경로당 | 357px | 20% |
| 아이콘 2개 그리드 (기록·설정) | 90px | 5% |
| 최근 기록 | 72px | 4% |
| 면책 배너 | 70px | 4% |

**읽을거리가 41%를 차지하고, 앱을 여는 이유인 기능 카드는 20%뿐이다.** 게다가 "오늘 할 일이 없습니다", "아직 기록이 없습니다"처럼 비어 있는데도 240px을 차지하는 카드가 있다.

근본 원인은 홈이 성격이 다른 두 가지를 한 장에 담고 있다는 점이다 — **"무언가를 한다"**(촬영·문자 확인)와 **"무언가를 읽는다"**(정보·경로당·기록). 고령층 대상이라 글자가 커서 이 혼재가 다른 앱보다 심하게 드러나고, 스크롤 자체가 부담이다.

## 목표

1. 하단 네비게이션 바를 추가해 최상위 이동 경로를 항상 보이게 한다.
2. 홈에서 읽을거리를 걷어내 **스크롤 없이 한 화면**에 들어오게 한다.

목표가 아닌 것: 기능 추가, 시각 디자인 전면 개편, 프레임워크 도입.

## 결정 사항

| 항목 | 결정 |
|---|---|
| 탭 구성 | **4탭 — 홈 / 정보 / 기록 / 설정** |
| 홈 정리 | 네비바 추가와 **함께** 진행 |
| 긴급 도움 FAB | 없애지 않고 **네비바 위로 올림** |
| 네비바 표시 범위 | **4개 탭 화면에서만**, 흐름 중간 화면에서는 숨김 |
| 최근 기록 카드 | 홈에서 제거, 기록 탭으로 흡수 |

"네비바가 보이면 출발점, 안 보이면 진행 중"이라는 규칙이 생겨 현재 위치를 헷갈리지 않고, 분석 도중 실수로 빠져나가는 것도 막는다.

## 설계

### 1. 네비게이션 바

`.screen-stack` 밖, `<body>` 직속에 **하나만** 둔다. 화면마다 복제하지 않는다.

```html
<nav class="bottom-nav" id="bottomNav">
  <button type="button" data-tab="screen-home" onclick="goTo('screen-home')">
    <svg class="nav-icon" viewBox="0 0 24 24"><use href="#ic-home"></use></svg>
    <span data-i18n="nav.home">홈</span>
  </button>
  <!-- 정보 / 기록 / 설정 동일 구조 -->
</nav>
```

아이콘은 기존 SVG 스프라이트(`index.html` 상단 `<symbol>` 정의)를 재사용한다. 다만 **`ic-home`은 스프라이트에 없으므로 새로 추가해야 한다.**

| 탭 | 심볼 | 상태 |
|---|---|---|
| 홈 | `#ic-home` | **신규 추가 필요** (집 모양, 기존 심볼들과 같은 24×24 stroke 스타일) |
| 정보 | `#ic-info` | 기존 |
| 기록 | `#ic-clock` | 기존 — 홈의 "최근 기록" 버튼(`index.html:188`)과 동일 |
| 설정 | `#ic-gear` | 기존 — 홈의 "설정" 버튼(`index.html:189`)과 동일 |

기록·설정은 사용자가 홈에서 보던 아이콘을 그대로 쓰므로 위치만 바뀌고 모양은 낯설지 않다.

- `position:fixed; left:0; right:0; bottom:0; z-index:70`
- 높이 64px + `padding-bottom: env(safe-area-inset-bottom)` (아이폰 홈 인디케이터)
- **아이콘과 글자 라벨을 함께** 쓴다. CLAUDE.md 디자인 가이드의 "아이콘만 사용 금지"를 따른다.
- 활성 탭에 `.is-active`(파란색)와 `aria-current="page"`를 함께 부여한다.

z-index 정리 — 기존 값과 충돌하지 않도록 아래 순서를 지킨다.

| 요소 | z-index |
|---|---|
| `.bottom-nav` | 70 |
| `.emergency-fab` | 80 (기존) |
| `.sheet-backdrop` | 85 (기존) |
| `#skipConfirmBackdrop` / `Sheet` | 600 / 610 (기존) |
| `.coach-overlay` | 500 (기존) |

### 2. 기존 요소와의 충돌 해소

`.screen`은 `position:absolute; inset:0; overflow-y:auto`로 각자 스크롤한다. 네비바가 마지막 콘텐츠를 가리므로:

```css
body.has-bottom-nav .screen.active { padding-bottom: calc(64px + env(safe-area-inset-bottom) + 24px); }
.emergency-fab { bottom: 28px; }
body.has-bottom-nav .emergency-fab { bottom: calc(64px + env(safe-area-inset-bottom) + 16px); }
```

### 3. 새 화면 `screen-info`

홈에 있던 `#publicInfoCard`와 `#regionInfoCard` **DOM 블록을 통째로 옮긴다.**

`renderPublicInfoCard()`(`js/script.js:2036`)와 `renderRegionInfoCard()`(`js/script.js:272`)는 `getElementById`로 요소를 찾으므로 **함수 본문은 수정하지 않는다.** 호출 지점만 바뀐다.

```js
function renderHomeDashboard(){
  renderTodayTasks();
  renderUpcomingSchedule();
  // renderPublicInfoCard(), renderRegionInfoCard() 는 renderInfoTab() 으로 이동
  // updateHomeRecent() 는 삭제 (아래 참고)
}

function renderInfoTab(){
  renderPublicInfoCard();
  renderRegionInfoCard();
}
```

### 3-1. `updateHomeRecent()` 제거 (주의 필요)

홈의 최근 기록 카드는 `updateHomeRecent()`(`js/script.js:624`)가 `#homeRecentList`에 그린다. 이 함수에는 **null 가드가 없다** — `js/script.js:625`에서 요소를 찾은 뒤 곧바로 `el.innerHTML`에 접근한다. 따라서 DOM 블록만 지우고 함수를 남겨두면 **TypeError가 발생한다.**

호출 지점이 두 곳이므로 함께 정리한다.

| 위치 | 처리 |
|---|---|
| `js/script.js:240` (`renderHomeDashboard` 안) | 호출 제거 |
| `js/script.js:621` (`addHistory` 끝) | 호출 제거 |
| `js/script.js:624`~`636` (함수 본문) | 함수 삭제 |
| `index.html`의 `#homeRecentList` 블록 | 삭제 |

기록 탭은 이미 `renderHistory()`(`js/script.js:638`)가 전체 목록을 그리고, `goTo()`에 `screen-history` 분기가 이미 있으므로 대체 구현이 필요 없다. 홈에서 보던 최근 3건 대신 기록 탭에서 전체를 보게 된다.

아래 3개 i18n 키는 제거되는 블록에서만 쓰이므로(전수 확인 완료) 고아가 된다. 5개 언어 모두에서 함께 지운다.

| 키 | 사용처 (모두 제거 대상) |
|---|---|
| `home.recentRecords` | `index.html:188`, `index.html:193` |
| `home.settings` | `index.html:189` — 네비바의 `nav.settings`가 대체 |
| `home.noRecords` | `index.html:195`, `js/script.js:627` |

`goTo()`의 화면별 갱신 분기에 `if (id === 'screen-info') renderInfoTab();`을 추가한다.

`screen-info`에는 `data-voice`를 반드시 부여한다(CLAUDE.md 작업 규칙 7번). 문구: "어르신께 도움이 되는 정보를 모았어요."

### 4. 홈에 남는 것

| 남김 | 옮김 |
|---|---|
| 큰 제목 "무엇을 도와드릴까요?" | 어르신 정보 카드 → 정보 탭 |
| 기능 카드 3개 (문서·문자·주변) | 근처 경로당 카드 → 정보 탭 |
| 오늘 해야 할 일 | 최근 기록 카드 → 기록 탭 |
| 면책 배너 | 아이콘 2개 그리드 → 네비바가 대체 |

예상 높이 **1,752px → 약 660px.** 스크롤 없이 한 화면에 들어온다.

### 5. 탭 전환

네비바 버튼은 기존 `goTo()`를 그대로 호출한다. 별도의 `goToTab()` 래퍼는 두지 않는다 — 표시 갱신을 `goTo()` 안에서 처리하므로 래퍼가 하는 일이 없다.

```js
const TAB_SCREENS = new Set(['screen-home', 'screen-info', 'screen-history', 'screen-settings']);

function syncBottomNav(id){
  document.querySelectorAll('#bottomNav [data-tab]').forEach(btn => {
    const on = btn.dataset.tab === id;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}
```

`goTo()` 안에서 표시 여부와 활성 표시를 함께 갱신한다.

```js
document.body.classList.toggle('has-bottom-nav', TAB_SCREENS.has(id) && !coachActive);
syncBottomNav(id);
```

코치마크 진행 중에는 `coachActive`가 참이므로 자동으로 숨는다. 온보딩 화면은 `TAB_SCREENS`에 없으므로 별도 처리가 필요 없다.

### 6. 코치마크 투어 수정 (필수)

`fullCoachSteps`(`js/script.js:777`)의 여러 단계가 홈 요소를 CSS 셀렉터로 직접 지목한다. 홈에서 요소를 빼면 **투어가 중간에 멈춘다.** 특히 `firstRunHelpStep`은 첫 실행 안내의 마지막 단계라 모든 신규 사용자가 겪는다.

| 위치 | 현재 타겟 | 변경 후 |
|---|---|---|
| `js/script.js:788` | `#screen-home .icon-square-btn[onclick*="openHistory"]` | `#bottomNav [data-tab="screen-history"]` |
| `js/script.js:796` | `#screen-home .icon-square-btn[onclick*="screen-settings"]` | `#bottomNav [data-tab="screen-settings"]` |
| `js/script.js:822` | 같은 설정 아이콘 (`firstRunHelpStep`) | `#bottomNav` 전체를 가리키도록 변경 |
| `js/script.js:790` | `screen: 'screen-home'`, 타겟 `#publicInfoList .row:first-child` | `screen: 'screen-info'`로 변경 (타겟은 유지) |

`firstRunHelpStep`은 원래 "나머지 사용법은 설정 → 사용 방법 안내에 있어요"라는 안내였다. 네비바가 생기면 그 자체가 안내 역할을 하므로 문구를 바꾼다.

- `coach.moreHelp.title`: "여기서 다른 기능도 볼 수 있어요"
- `coach.moreHelp.desc`: "아래 정보·기록·설정을 눌러 보세요."
- `coach.moreHelp.voice`: "아래쪽 메뉴에서 다른 기능도 볼 수 있어요."

네비바를 가리키는 단계이므로 `screen`은 `screen-home`을 유지한다.

### 7. 다국어

`nav.home` / `nav.info` / `nav.history` / `nav.settings` **4키 × 5개 언어(ko·zh·vi·th·uz) = 20개**를 추가한다. 변경되는 `coach.moreHelp.*` 3키도 5개 언어 모두 갱신한다.

현재 I18N은 언어당 167키가 5개 언어 전부 일치하는 상태다. 이 원칙을 유지한다 — 작업 후 대조로 검증한다.

**언어당 키 수: 167 → 168** (`nav.*` 4개 추가, 3-1절의 고아 키 3개 제거)

용어는 각 언어에 이미 있는 표현을 재사용한다.

| 키 | ko | zh | vi | th | uz |
|---|---|---|---|---|---|
| `nav.home` | 홈 | 主页 | Trang chủ | หน้าแรก | Bosh sahifa |
| `nav.info` | 정보 | 信息 | Thông tin | ข้อมูล | Ma'lumot |
| `nav.history` | 기록 | 记录 | Lịch sử | ประวัติ | Tarix |
| `nav.settings` | 설정 | 设置 | Cài đặt | ตั้งค่า | Sozlamalar |

`nav.info` / `nav.history` / `nav.settings`는 기존 `coach.cat.*` 값과 동일하다. 별도 키로 두는 이유는 네비바 라벨과 코치마크 카테고리 라벨이 앞으로 갈라질 수 있기 때문이다.

## 영향 범위

| 파일 | 변경 |
|---|---|
| `index.html` | `<nav id="bottomNav">` 추가, `screen-info` 신설, 홈에서 4개 블록 이동/제거 |
| `css/styles.css` | `.bottom-nav` 계열 신규, `.screen`/`.emergency-fab` 여백 보정 |
| `js/script.js` | `TAB_SCREENS`·`syncBottomNav`·`renderInfoTab` 추가, `goTo`/`renderHomeDashboard` 수정, `updateHomeRecent` 삭제(호출 2곳 포함), 코치마크 4단계 수정, I18N 키 정리 |
| `www/` 하위 동일 파일 | **루트와 동일하게 반영** (CLAUDE.md 작업 규칙 2번) |

`worker/`와 `android/` 소스는 건드리지 않는다.

## 검증

1. `node --check js/script.js` — 루트와 `www/` 양쪽 구문 검사
2. 루트와 `www/` 파일 해시 일치 확인
3. I18N 5개 언어 키 개수·이름 완전 일치 확인 (언어당 167 → 168키, 누락·잉여 0)
4. 브라우저에서 실제 확인:
   - 홈이 스크롤 없이 한 화면에 들어오는지 (`scrollHeight <= 852`)
   - 4개 탭 이동이 모두 동작하고 활성 표시가 맞는지
   - 흐름 중간 화면(촬영·로딩·결과)에서 네비바가 숨는지
   - 긴급 FAB이 네비바에 가리지 않는지
   - **첫 실행 안내 11단계가 끝까지 진행되는지** (코치마크 수정의 핵심 검증)
   - 콘솔 오류 0건
5. 언어를 베트남어·태국어·우즈베크어로 바꿔 네비바 라벨이 나오는지 확인

## 배포

**배포하지 않는다.** 이 프로젝트는 사용자가 직접 배포를 관리한다. 코드 변경과 커밋까지만 수행하고, 대회 제출 링크(`ondam-app.pages.dev`)는 건드리지 않는다.
