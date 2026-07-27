# 온담 프런트엔드 React + Vite 이전 설계

작성일: 2026-07-27

## 배경과 목적

현재 프런트엔드는 프레임워크·번들러 없는 순수 HTML/CSS/JS다.

| 파일 | 줄 수 |
|---|---|
| `js/script.js` | 2,080 |
| `index.html` | 996 (화면 34개) |
| `css/styles.css` | 632 |

`js/script.js` 파일 하나가 화면 전환, 상태 관리, TTS, 카메라, 지도, 다국어, AI 호출을 모두 담고 있어 유지보수가 어렵다. **이 이전의 목적은 코드 구조를 화면 단위로 쪼개 관리 가능하게 만드는 것이며, 기능 추가·동작 변경은 목적이 아니다.**

> ⚠️ 이 설계는 `CLAUDE.md`의 작업 규칙 3번("프레임워크·번들러·빌드 스크립트를 새로 들이지 않는다")을 의도적으로 뒤집는다. 이전 완료 시점에 해당 규칙과 1번 규칙(root ↔ `www/` 수동 동기화)을 함께 갱신해야 한다.

## 확정된 선택

| 항목 | 선택 | 이유 |
|---|---|---|
| 프레임워크 | React + Vite | 사용자 지정 |
| 언어 | TypeScript | 사용자 지정 |
| 이전 방식 | 단계적(화면별) | 이전 도중에도 앱이 계속 동작해야 함 |
| 라우팅 | React Router 미사용 | 아래 참고 |
| 상태 관리 | Context + useReducer (라이브러리 미도입) | 아래 참고 |

## 아키텍처

### 1. 디렉터리 구조

```
/                         # 기존 vanilla 트리 — 이전 완료까지 그대로 유지
  index.html
  js/script.js
  css/styles.css
  www/                    # Capacitor가 현재 읽는 곳 (webDir)
app/                      # 신규 React 프로젝트
  src/
    screens/              # 화면 1개 = 파일 1개 (34개)
    state/                # appState 대체
    lib/                  # tts, camera, worker API, i18n 등 공용 로직
    App.tsx
  dist/                   # 빌드 산출물 (www/ 와 분리)
  vite.config.ts
  package.json
```

**핵심 원칙: 이전 기간 동안 `www/`는 건드리지 않는다.**

React 빌드 결과를 `www/`로 바로 내보내면, 아직 이전되지 않은 vanilla 화면들을 위해 root → `www/`를 수동 복사하는 기존 방식과 같은 폴더에서 충돌한다("`www/`의 주인이 누구인가"가 모호해짐). 따라서 이전 기간에는:

- vanilla 쪽: 지금처럼 root 수정 → `www/` 수동 복사 (기존 규칙 유지)
- React 쪽: `app/`에서 개발, 빌드 산출물은 `app/dist/`

`capacitor.config.json`의 `webDir`은 이전 기간 내내 `www` 그대로 두고, **모든 화면 이전이 끝나는 시점에 딱 한 번** `app/dist`로 전환한다.

### 2. 화면 전환 — React Router 미사용

현재 구조는 URL이 없다. `index.html` 안에 `<section class="screen" id="screen-xxx">` 34개가 모두 존재하고, `goTo(id)`가 `.active` 클래스만 옮긴다. 뒤로 가기는 각 화면의 버튼이 `goTo()`를 호출하는 방식이라 브라우저 히스토리와 무관하다.

React Router를 도입하면 URL·히스토리 개념이 새로 생겨 현재 동작과 달라지고, 기능 이전이 아닌 동작 변경이 섞여 리스크가 커진다. 대신 현재 패턴을 그대로 재현한다:

```
useScreen()  →  { current: string, goTo: (id: string) => void }
```

`App.tsx`가 `current`에 해당하는 화면 컴포넌트 하나만 렌더링한다.

**부수 효과 처리**: 현재 `goTo()`는 화면 전환과 함께 여러 부수 효과를 실행한다.

- `data-voice` 문구 TTS 읽기 (단, 코치마크가 읽을 예정이면 건너뜀)
- `body.in-onboarding` 클래스 토글 (온보딩 중 긴급 FAB 숨김)
- 화면별 초기화 호출 (`renderHomeDashboard`, `syncSettingsUI`, `renderDocResult` 등)
- 로딩 화면 진행바 시작

React에서는 이를 각 화면 컴포넌트의 `useEffect`로 분산한다. 특히 `data-voice`는 정적 문구가 아니라 화면별 책임이므로, 각 컴포넌트가 자신의 안내 문구를 결정해 읽는다(문서 결과 화면처럼 AI 분석 결과를 읽어야 하는 경우 포함).

### 3. 상태 관리 — Context + useReducer

현재 `appState`는 객체 하나이며 `localStorage`(키 `ai_helper_state_v1`)에 저장된다.

```js
{
  history: [],
  schedule: [],
  settings: { fontScale, voiceRate, voiceEnabled, language },
  guardian:  { name, phone, autoNotify },
  profile:   { name, gender, age, region }
}
```

이 규모에는 Redux/Zustand가 과하다. `AppStateContext` 하나 + `useReducer`로 충분하며, 새 의존성이 늘지 않는다.

**`profile`의 서버 동기화는 기존 동작을 그대로 유지한다** — 변경 시 800ms 디바운스 후 Worker `POST /profile`, 앱 로드 시 `GET /profile`(단, 로컬에 값이 있으면 서버 값으로 덮어쓰지 않음). 이 로직은 `lib/`의 별도 모듈로 분리한다.

### 4. 공용 로직 분리 (`app/src/lib/`)

`js/script.js`에 섞여 있던 관심사를 모듈로 나눈다.

| 모듈 | 책임 |
|---|---|
| `tts.ts` | `speak()`, 언어별 TTS lang 결정, 음성 on/off |
| `worker.ts` | `AI_WORKER_URL` 호출 (`/analyze-doc`, `/analyze-text`, `/profile`, `/region-info`) |
| `camera.ts` | Capacitor Camera 플러그인 / 웹 `<input type="file">` 양쪽 경로 |
| `storage.ts` | localStorage 저장·로드, `deviceId` |
| `i18n.ts` | 기존 `I18N` 객체와 `t()` |
| `map.ts` | Leaflet + Nominatim 지오코딩 |

## 이전 순서

의존성이 적은 화면부터, 매 단계마다 동작을 확인하며 진행한다.

1. **기반 구축** — Vite + React + TS 프로젝트 생성, `styles.css` 그대로 가져오기, `useScreen()`·`AppStateContext` 구현, 34개 화면 전체를 빈 스텁으로 생성
2. **`lib/` 모듈 이전** — 화면과 무관한 공용 로직 먼저 (TTS, worker, storage, i18n)
3. **단순 정적 화면** — `screen-help-*`(8개), `screen-info-*`(3개), 온보딩/안내 화면
4. **핵심 플로우** — 문서(`screen-doc-*` → `screen-loading-doc` → `screen-result-doc`), 문자(`screen-sms-*` → `screen-result-text`)
5. **상태 의존 화면** — `screen-home`(대시보드·일정·지도), `screen-history`, `screen-settings`, `screen-profile`
6. **전환** — `capacitor.config.json`의 `webDir`을 `app/dist`로 변경, root/`www`의 vanilla 파일 정리, `CLAUDE.md` 규칙 1·3번 갱신

## 검증

이 프로젝트에는 테스트 프레임워크가 없고(`package.json`의 `test`는 항상 실패하는 더미), 이번 이전에서도 도입하지 않는다. 검증은 기존 방식대로 **브라우저에서 직접 눌러보고 콘솔 오류를 확인**한다.

화면 하나를 이전할 때마다:

1. `app/`에서 `npm run dev`로 해당 화면 진입·조작
2. 브라우저 콘솔 오류 없음 확인
3. 기존 vanilla 화면과 동작 비교 (TTS 안내 문구, 버튼 동작, 상태 저장)

AI 분석처럼 실제 네트워크가 필요한 흐름은 배포된 Worker(`ondam-ai`)를 그대로 호출해 확인한다.

## 배포 정책

**이전 작업 중 자동 배포하지 않는다.** 사용자가 명시적으로 반영을 요청할 때까지 Cloudflare Pages / Worker 배포를 실행하지 않으며, 로컬 수정과 배포는 별개 단계로 취급한다.

## 범위 밖

- 기능 추가·UI 변경 (이전은 동작 동일성이 목표)
- 테스트 프레임워크 도입
- Worker(`worker/`) 코드 변경
- `android/` 수동 편집 (`npx cap sync android`로 생성되는 사본)
