# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

"온담"(AI 디지털 도우미, 온기를 담아 전하는 서비스) — 고령층 대상 문서/문자 사기 판별 및 생활 안내 앱. Capacitor로 웹 앱을 Android 네이티브(APK)로 감싼 하이브리드 앱이며, 문서 이미지 분석을 위한 별도 Cloudflare Worker 백엔드(Anthropic API 연동)를 포함한다.

> 참고: 안드로이드 패키지명(`com.ondam.app`)과 표시 이름은 "온담"으로 바뀌었지만, Worker 배포 주소(`ansim-doumi-ai.kke88084.workers.dev`)·D1 데이터베이스명(`ansim-doumi-db`)·GitHub 저장소명 등 기존에 배포·연동된 식별자는 재배포 부담을 피하기 위해 이전 이름("안심도우미"/`ansimhelper`/`an
sim-doumi`)을 그대로 유지한다. 이 문서와 코드에서 그런 식별자를 볼 수 있는 것은 의도된 것이다.

세 부분이 독립적으로 존재한다:
- **루트 (`/`)**: 프레임워크·번들러 없는 순수 HTML/CSS/JS 프런트엔드
- **`worker/`**: Cloudflare Worker (Anthropic SDK) — 이미지 분석 API
- **`android/`**: Capacitor가 생성한 Android 네이티브 프로젝트

## 자주 쓰는 명령어

프런트엔드(루트)에는 build/lint/test 스크립트가 없다 (`package.json`의 `test`는 항상 실패하는 더미 스크립트). `index.html`, `js/script.js`, `css/styles.css`를 직접 편집하고 브라우저로 열어 확인하는 구조.

Worker (`worker/` 안에서 실행):
```
npm run dev      # wrangler dev (로컬 실행)
npm run deploy   # wrangler deploy (배포)
```
`ANTHROPIC_API_KEY`는 wrangler secret으로 설정되어야 함 (`wrangler.toml`에는 없음).

D1 데이터베이스(`ansim-doumi-db`, 프로필 저장용) 스키마를 바꿨다면:
```
npx wrangler d1 execute ansim-doumi-db --remote --file=./schema.sql   # worker/ 안에서 실행
```


Android 네이티브 빌드/동기화 (Capacitor CLI는 devDependency로 설치되어 있음, 루트에서 실행):
```
npx cap sync android    # www/ 의 웹 자산 + 플러그인을 android/ 프로젝트에 반영
npx cap open android     # Android Studio로 열기
```

## 아키텍처에서 반드시 알아야 할 점

### 1. `www/` 는 `/` 의 수동 복사본이다 (빌드 스크립트 없음)
`capacitor.config.json`의 `webDir`은 `www`이고, Android 앱은 `www/index.html`, `www/js`, `www/css`, `www/assets`만 읽는다. 하지만 이 저장소에는 루트 → `www/`로 자동 복사하는 빌드 스크립트가 없다. **루트의 `index.html` / `js/script.js` / `css/styles.css` / `assets/`를 수정했다면 `www/` 아래 동일 경로도 반드시 함께 수정**해야 앱(APK)에 반영된다. 두 트리가 어긋나면 웹 버전과 APK 버전의 동작이 달라진다.

### 2. 프런트엔드는 SPA가 아니라 "화면(section) 전환" 방식의 단일 파일
`index.html` 안에 `<section class="screen" id="screen-xxx" data-voice="...">` 형태로 수십 개의 화면이 모두 정의되어 있고, `js/script.js`의 `goTo(id)`가 `.active` 클래스를 옮기며 화면을 전환한다. 라우터나 템플릿 엔진은 없음 — 새 화면을 추가하려면 `index.html`에 `<section>`을 추가하고 `goTo()`로 이동시키는 함수를 작성하는 식이다.

`data-voice` 속성은 화면 진입 시 TTS(`speak()`)로 읽어주는 문구다. 화면을 추가/수정할 때 이 속성도 같이 챙겨야 접근성 음성 안내가 끊기지 않는다.

`progressMap` (`js/script.js` 상단)은 "로딩 화면 → 자동으로 다음 화면 이동"을 선언적으로 처리한다. 새로운 로딩/진행 화면을 추가할 때는 여기에 `{ fillId, next, beforeNext? }`를 등록하면 된다.

### 3. 첫 화면 "사용 안내(온보딩)"와 "실사용" 흐름이 공존
최초 실행 시 보여주는 것은 실제 상호작용을 흉내 내는 데모가 아니라 **실제 화면 컴포넌트를 그대로 복제해 강조 표시(`.pulse`)만 얹은 정적 인포그래픽**(`screen-greet` → `screen-onboard-1`~`screen-onboard-5` → `screen-onboard-end`, `js/script.js`의 `onboardScreens` 집합)이다. 이 안내 화면들은 클릭 핸들러가 없는 순수 미리보기(`.onboard-mock`, `pointer-events:none`)이므로 `appState`(일정/기록/설정)에 절대 영향을 주지 않는다 — 안내 화면 동안에는 긴급 도움 FAB도 `body.in-onboarding` 클래스로 숨겨진다.

2026-07 개편으로 문자 확인 흐름의 **가짜 문자함(고정 시나리오 5개, `smsMessages`/`screen-sms-inbox-real` 등)을 완전히 삭제**했다. 이제 문자 확인은 오직 하나의 경로뿐이다: `screen-sms-phone`(휴대폰 홈 모사) → `openRealSmsApp()`로 실제 기기의 문자 앱(`sms:`)을 띄움 → 사용자가 실제 문자를 길게 눌러 복사 → `screen-sms-switch` → `screen-sms-paste`(직접 붙여넣기) → `confirmSmsPaste()` → `analyzeSmsText()`가 Worker `/analyze-text`를 실제로 호출 → `screen-result-text`. 문서 흐름(`screen-doc-*`)도 마찬가지로 실제 카메라/갤러리 사진을 Worker `/analyze-doc`으로 분석한 결과(`lastDocAnalysis`/`lastSmsAnalysis`)만 보여준다 — 분석이 실패했거나 아직 안 끝난 경우에만 `finishDocResult()`의 기본값으로 폴백한다. 하드코딩된 문자 예시나 가짜 판별 결과를 보여주는 화면은 더 이상 존재하지 않는다.

### 4. `worker/`는 배포되어 프런트엔드와 연결되어 있음
`worker/src/index.js`는 `/analyze-doc`, `/analyze-text` 엔드포인트로 이미지·문자를 받아 Anthropic API(`claude-opus-4-8`, `json_schema` 출력)로 분석하고 `{status, headline, summary, checklist}`를 반환하며, `https://ansim-doumi-ai.kke88084.workers.dev`로 배포되어 있다. `js/script.js` 상단의 `AI_WORKER_URL` 상수가 이 주소를 가리키고, `analyzeDocument()`/`analyzeSmsText()`가 사진 촬영·붙여넣기 직후 이 엔드포인트를 호출한다. Worker 코드를 고치면 `worker/` 안에서 `npm run deploy`로 다시 배포해야 실사용 흐름에 반영된다.


### 5. 카메라/갤러리는 네이티브·웹 두 경로를 모두 지원
`getCameraPlugin()`으로 Capacitor의 네이티브 Camera 플러그인 존재 여부를 확인하고, 있으면 그걸 쓰고 없으면(모바일 브라우저·PWA) `<input type="file" capture>` 기반 웹 표준 방식(`pickWebPhoto`)으로 대체한다. 두 경로 모두 `pickPhoto()`를 통해 동일한 후속 흐름(`screen-loading-doc`)으로 합류한다.

### 6. 상태는 기본적으로 `localStorage`, 서버 상태 없음 (단, 프로필은 예외 — 8번 항목 참고)
`appState`(기록/일정/설정/보호자 정보)는 `saveState()`/`loadState()`로 브라우저 `localStorage`(`ai_helper_state_v1` 키)에만 저장된다. 로그인이나 서버 동기화는 없음 — 기기를 바꾸면 이 데이터는 사라진다. `appState.profile`만 예외적으로 Cloudflare D1에도 함께 저장된다(자세한 내용은 8번 항목).

### 7. 일정 항목의 "길찾기 지도"는 위치를 실제로 찾았을 때만 보여준다
`appState.schedule` 항목에 `location`(장소명 문자열)이 있으면 홈의 "오늘 해야 할 일" 목록에 Leaflet + OpenStreetMap Nominatim(`renderScheduleMap`/`geocodePlace`, API 키 불필요)으로 지도를 그린다. `index.html`은 `<head>`에서 Leaflet을 CDN으로 불러오므로 인터넷 연결이 필요하다. Nominatim 지오코딩이 실패하면(추상적인 장소명 등) 지도를 아예 숨긴다 — 잘못된 위치를 실제 장소인 것처럼 보여주지 않기 위함이다. 체크리스트에 `data-location`을 새로 붙일 때는 실제로 검색 가능한 구체적인 장소명(기관명 등)을 쓴다.

### 8. `appState.profile`(이름/성별/연령대/지역)은 AI 분석 참고용일 뿐, 지역별 실제 데이터가 아니다
온보딩(`screen-profile`)과 설정(`screen-settings`의 "내 정보")에서 선택 입력받는 이름/성별/연령대/지역은 전부 선택 사항이며 `setProfileField()`/`syncProfileUI()`로 두 화면(온보딩·설정)에 동시에 반영된다. 지역은 드롭다운이 아니라 자유 텍스트 입력(시/군/구까지 적을 수 있음)이다. 이 값은 `analyzeDocument()`/`analyzeSmsText()`가 Worker 요청 본문에 `profile`로 실어 보내고, `worker/src/index.js`의 `buildProfileNote()`가 프롬프트에 "설명 톤 참고용, 모르는 지역별 기관명·연락처는 지어내지 말 것"이라는 지시와 함께 덧붙인다 — **실제 지역별 공공데이터를 조회하는 기능이 아니다.** 홈 화면의 "알아두면 좋은 정보" 카드(`renderPublicInfoCard()`, `PUBLIC_INFO_ITEMS`)를 누르면 외부 사이트로 바로 나가지 않고 앱 안의 설명 화면(`screen-info-pension`/`screen-info-checkup`/`screen-info-voicephishing`)으로 이동한다 — 지역 무관하게 전국 공통으로 실제 확인된 정보만 담겨 있고, 인사말만 이름/성별/연령대로 맞춤화한다. 이 항목을 손볼 때 "지역 맞춤 혜택"처럼 실제 데이터 없이 지어낸 문구를 넣지 않도록 주의(위 "심사 기준"의 데이터 근거 원칙과 직결).

프로필은 `localStorage`뿐 아니라 **Cloudflare D1**(`worker/schema.sql`의 `profiles` 테이블, `wrangler.toml`의 `ansim_doumi_db` 바인딩)에도 저장된다. 로그인이 없으므로 브라우저에 저장된 임의의 `deviceId`(`getDeviceId()`, localStorage 키 `ai_helper_device_id`)로 기기를 구분한다. `setProfileField()` → 800ms 디바운스 후 `saveProfileToServer()` → Worker `POST /profile`. 앱 로드 시 `loadProfileFromServer()` → `GET /profile?deviceId=...` — 단, **이 기기에 이미 값이 있으면 서버 값으로 덮어쓰지 않는다**(로컬 우선). Worker의 D1/프로필 엔드포인트를 고치면 스키마 변경 시 `npx wrangler d1 execute ansim-doumi-db --remote --file=./schema.sql`을 실행하고, 코드 변경은 여느 때처럼 `npm run deploy`로 재배포해야 한다.

### 9. 언어 설정은 화면 핵심 문구만 번역하고, AI 분석 결과는 항상 한국어다
설정 화면의 언어 전환(`setLanguage()`, `js/script.js`의 `I18N` 객체)은 경기도 거주 외국인주민 통계에서 비중이 높은 4개 언어(중국어·베트남어·태국어·우즈베크어)를 지원한다 — 근거는 행정안전부·경기도여성가족재단 등록외국인 통계이며 정확한 순위는 자료마다 다소 차이가 있어 참고용이다. `data-i18n` 속성이 붙은 요소(홈 화면 인사말·카드·설정 화면 섹션 제목 등 핵심 UI)만 번역되고, `applyLanguage()`가 `I18N[lang]`으로 `innerHTML`을 교체한다. **AI가 생성하는 문서/문자 분석 결과(headline/summary/checklist)는 번역하지 않고 항상 한국어로 유지**한다 — 원문 오역으로 인한 안전 문제를 피하기 위함(공공데이터 원문을 한국어로 유지하는 다른 프로젝트의 관행과 동일한 이유). 새 언어를 추가하거나 문구를 늘릴 때 이 원칙을 유지할 것 — Thai/Uzbek 번역은 초벌 번역이라 실제 사용 전 원어민 검수를 권장.

### 10. "사용 방법 안내"는 온보딩이 아니라 정적 Q&A 화면
설정의 "사용 방법 안내"는 더 이상 `screen-greet`(온보딩 인포그래픽)로 연결되지 않는다. `screen-help`("무엇이 궁금하세요? 사진/문자") → `screen-help-doc` 또는 `screen-help-sms`로 이동하는, 상태를 건드리지 않는 정적 설명 화면이다. 온보딩 인포그래픽 자체는 `screen-onboard-1`~`screen-onboard-6`(총 6단계 — 5단계 "문자 앱에서 복사해 붙여넣기" 포함)로, 설정의 별도 행("화면 안내(첫 실행 안내) 다시 보기")에서만 재진입한다.

### 11. 지역별 맞춤 정보(경로당 현황)는 실제 공공데이터이지만, Worker가 아니라 D1에서 서빙한다
홈 화면의 "우리 지역 정보" 카드(`renderRegionInfoCard()`)는 경기데이터드림(data.gg.go.kr)의 **"노인여가복지시설(경로당) 현황"(SenircentFaclt) Open API**에서 가져온 실제 데이터를 보여준다. **중요한 제약**: `openapi.gg.go.kr`는 Cloudflare Workers의 해외 egress IP를 차단해(WAF) Worker에서 직접 호출하면 HTML 에러 페이지가 돌아온다 — 그래서 로컬 PC(국내 IP)에서 한 번 데이터를 내려받아 D1의 `senior_centers` 테이블에 저장해두고(`worker/seed_senior_centers.sql`, 경기도 31개 시/군 × 5곳), Worker의 `GET /region-info?region=...`는 이 D1 테이블만 조회한다 — 실시간 API 호출이 아니라 스냅샷이다. 프로필의 자유 텍스트 지역 입력을 `GYEONGGI_CITIES`(31개 시/군 목록) 문자열 포함 여부로 매칭하고, 경기도가 아니면(매칭 실패) `matched:false`만 반환해 지어내지 않는다. 데이터를 갱신하거나 다른 지역/데이터셋을 추가하려면: (1) 국내 IP 환경에서 `https://openapi.gg.go.kr/{서비스명}?KEY=...&Type=json&...`을 직접 호출해 데이터를 받고, (2) `seed_senior_centers.sql` 같은 INSERT 스크립트를 만들어 `npx wrangler d1 execute ansim-doumi-db --remote --file=...`로 반영, (3) Worker 코드가 D1을 조회하도록 유지. `GG_DATA_API_KEY`는 `wrangler secret put`으로만 저장되어 있고 코드나 공개 저장소에는 없음(현재는 시드 스크립트 실행 시에만 필요).

## 작업 규칙

1. 큰 범위를 한 번에 바꾸지 않는다 — 기능 하나를 수정·검증한 뒤 다음으로 넘어간다.
2. 루트(`index.html`/`js/script.js`/`css/styles.css`/`assets/`)를 고쳤다면 `www/` 아래 동일 경로도 반드시 같이 고친다(위 1번 항목). 둘 중 하나만 고치고 끝내지 않는다.
3. 프레임워크·번들러·빌드 스크립트를 새로 들이지 않는다 — 순수 HTML/CSS/JS 구조를 유지한다.
4. `worker/src/index.js`를 고쳤다면 로컬 확인(`npm run dev`) 후 반드시 `npm run deploy`까지 마쳐야 실사용 흐름(`AI_WORKER_URL`)에 반영된다. 배포하지 않고 "고쳤다"고 보고하지 않는다.
5. 실제로 분석 결과를 받지 못했거나 실패한 경우를 `finishDocResult()` 기본값 같은 폴백으로 성공한 것처럼 보이게 만들지 않는다 — 실사용 흐름과 튜토리얼 데모 흐름을 혼동하지 않는다(위 3번 항목).
6. Anthropic API 키나 없는 외부 서비스를 실제로 연동된 것처럼 표현하지 않는다.
7. 화면(`screen-*`)을 추가·수정하면 `data-voice`(TTS 안내 문구)와 `progressMap`(로딩→다음 화면 전환) 등록도 함께 챙긴다 — 빠뜨리면 음성 안내가 끊기거나 로딩 화면에서 멈춘다.
8. 변경 후 브라우저에서 직접 열어 콘솔 오류를 확인한다. 루트와 `www/` 양쪽 다 열어봐야 두 트리가 실제로 일치하는지 확인할 수 있다.
9. 확인하지 못한 기능(직접 브라우저에서 눌러보지 않은 기능, 배포하지 않은 Worker 변경 등)은 완료됐다고 보고하지 않는다.

## 요청·오류 보고 템플릿

기능을 만들거나 바꿀 때:
```text
현재 상태:
바꾸고 싶은 점:
유지할 기능:
완료 조건(루트/www 둘 다 반영됐는지 포함):
```

오류가 있을 때:
```text
오류가 발생한 화면/기능:
화면에서 보인 현상:
브라우저 콘솔 오류:
Worker 쪽 문제라면 wrangler dev/deploy 로그:
유지해야 할 기능:
```

## 심사 기준 — 2026 SW미래채움×AI·SW중심대학 연합 경진대회 (AI 서비스톤)

이 프로젝트는 아이디어 기획이 아니라 실제로 구동되는 서비스이므로 "AI 서비스톤" 트랙 기준이 적용된다. 기능/문구를 결정할 때 이 기준에 맞는지 체크한다.

| 평가 항목 | 평가 지표 | 배점 |
|---|---|---|
| 문제 정의 | 해결하고자하는 문제 정의를 명확하고 구체적으로 했는가? | 15 |
| 기대 효과 | 문제가 해결되었을 때 사회에 기여도가 높고 지속가능한가? | 15 |
| 창의성 | 해결 방안이 독창적이고 쉽게 생각할 수 없는가? | 20 |
| 기술구현 및 완성도 | 실제 구동 시 기능이 완결성 있게 작동하는가? | 40 |
| 발표 (*서면 심사 시 제외) | AI서비스 내용 전달과 질문에 대한 답변이 잘 이루어졌는가? | 10 |
| **합계** | | **100** |

"기술구현 및 완성도"가 40점으로 가장 크다 — 위 "작업 규칙"의 www/ 동기화, Worker 실제 배포, 폴백을 성공으로 위장하지 않기 원칙이 이 배점과 직결된다. 정적 인포그래픽 온보딩(`screen-onboard-*`, 위 3번 항목)과 실사용 화면(`screen-doc-*`, `screen-sms-*`)을 구분해 발표·시연할 때, 실제로 동작하는 부분과 안내용 부분을 솔직하게 구분해서 설명해야 한다(구현 범위 및 보완 계획 슬라이드 참고). 문자 확인 흐름은 이제 가짜 시나리오 없이 실제 문자만 분석하므로, 시연 시 실제 기기의 문자 앱에서 실제 문자를 복사해 보여줘야 한다.

### 예선/본선 발표 PPT 권장 구성 (AI 서비스톤, 총 8슬라이드)

1. 타이틀(표지) — 대회명, 트랙명(AI 서비스톤), 팀명, 서비스명, 발표자/팀원 성명
2. 서비스 개요 및 핵심 가치 — 한 줄 소개, 유저에게 제공하는 핵심 가치와 목적
3. 문제 배경 및 타깃 사용자 — 타깃 페르소나, 겪는 불편(Pain Point)
4. 서비스 주요 기능 — 핵심 기능 3가지 이상을 아이콘·타이틀로 정리
5. 사용자 이용 흐름(User Flow) — 접속~문제 해결까지 단계별 UI/UX 흐름 도식화
6. AI·SW 활용 기술 및 서비스 구조 — 프런트/백엔드(Capacitor+Cloudflare Worker) 구조, Anthropic API 연계 방식, 데이터 아키텍처
7. 프로토타입 시연(하이라이트) — 실제 화면 캡처/GIF, 발표 시 브라우저·에뮬레이터로 실시간 시연
8. 구현 범위 및 보완 계획 — 완료된 기능/미구현 기능을 솔직하게 명시, 시연 중 발생 가능한 오류나 제약(네트워크, API 키 등)을 미리 밝히고 향후 고도화 방향 제시

(참고: "AI 아이디어 기획톤" 트랙은 문제 정의 25 / 기대 효과 25 / 창의성 30 / 기술 구현가능성 10 / 발표 10 배점으로 별도 운영되며, 이 프로젝트처럼 실제 서비스가 구현된 경우는 서비스톤 기준을 따른다.)
