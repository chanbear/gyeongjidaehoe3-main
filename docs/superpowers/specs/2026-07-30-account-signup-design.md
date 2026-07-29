# 회원가입(계정) 기능 설계

## 배경

지금 앱은 로그인이 없다. `appState`(기록·일정·설정·보호자 정보)는 `js/script.js:23`의 전역 객체로 존재하고
`saveState()`(`js/script.js:44`)가 `localStorage`(`ai_helper_state_v1`)에만 저장한다. 유일하게 서버(Cloudflare
D1)에 저장되는 건 `appState.profile`(이름/성별/나이/지역)뿐이고, 그마저도 로그인이 아니라 기기별 임의
`deviceId`(`getDeviceId()`, `js/script.js:3093`)로 구분한다(`js/script.js:3108-3139`의
`saveProfileToServer()`/`loadProfileFromServer()`). 기기를 바꾸면 기록·일정·설정은 그냥 사라진다.

이번 설계는 이걸 "진짜 계정"으로 바꾼다: 전화번호+PIN으로 가입/로그인하고, 로그인해야만 앱을 쓸 수 있게
하며, `appState` 전체(기록·일정·설정·프로필·보호자 정보)를 계정에 묶어 기기 간 동기화한다.

## 1. 데이터 모델 (Worker/D1)

`worker/schema.sql`에 두 테이블을 추가한다. 기존 `profiles` 테이블과 관련 코드(`getDeviceId`,
`saveProfileToServer`, `loadProfileFromServer`, `/profile` 엔드포인트)는 삭제한다 — 프로필 데이터는 이제
`user_state.state_json` 안에 자연히 포함되므로 별도 테이블이 필요 없다.

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  name TEXT DEFAULT '',
  token TEXT,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TEXT,
  otp_hash TEXT,
  otp_expires_at TEXT,
  otp_attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

`pin_hash`는 `SHA-256(pin_salt + pin)`을 hex로 인코딩한 값이다(Worker 내장 `crypto.subtle.digest`, 새 npm
의존성 없음). `pin_salt`는 가입 시 `crypto.getRandomValues`로 만든 16바이트 랜덤 값(hex). PIN이 4자리
숫자뿐이라 해시 알고리즘의 강도는 큰 의미가 없고, 실제 방어선은 아래의 로그인 시도 제한이다.

## 2. 인증 흐름 (Worker 엔드포인트)

모든 새 엔드포인트는 `worker/src/index.js`에 `/signup`, `/login`, `/request-pin-reset-otp`,
`/verify-pin-reset-otp`, `GET /state`, `POST /state` 라우트로 추가한다. 기존 `/profile` GET/POST 라우트
(`worker/src/index.js:350-388`)는 제거한다.

### `POST /signup { phone, pin, name }`
- `phone`은 숫자만 남겨서(`replace(/\D/g,'')`) 9자리 이상인지 확인 — 클라이언트의 `guardianPhoneDigits()`
  (`js/script.js:1896`)와 동일한 기준을 서버에서도 검사한다.
- `pin`은 정확히 4자리 숫자(`/^\d{4}$/`).
- `phone` 중복이면 409와 `{ error: 'phone_exists' }` 반환.
- salt 생성 → 해시 계산 → `users`에 insert → 32바이트 랜덤 토큰 생성(`crypto.getRandomValues`, hex) →
  `token` 컬럼에 저장 → `{ userId, token, name }` 200 반환.
- 가입 직후 클라이언트가 현재 로컬 `appState`(로그인 전이라 기본값)를 그대로 `POST /state`로 올려 최초
  스냅샷을 만든다(4번 섹션 참고).

### `POST /login { phone, pin }`
- `users`에서 `phone`으로 조회. 없으면 로그인 실패 응답(아래와 동일 문구)으로 처리(존재 여부를 노출하지
  않기 위해 없음/틀림을 구분하지 않는다).
- `locked_until`이 현재 시각보다 미래면 423과 `{ error: 'locked' }` 반환.
- PIN 해시가 일치하지 않으면 `failed_attempts += 1`, 5회 도달 시 `locked_until = now + 15분` 설정 후
  401과 `{ error: 'invalid' }` 반환.
- 성공하면 `failed_attempts = 0`, 새 토큰 발급(로그인마다 재발급 — 리프레시 토큰 없이 단순하게) →
  `{ userId, token, name }` 200 반환.

### `POST /request-pin-reset-otp { phone, name }`
- `phone`+`name`이 정확히 일치하는 `users` 행이 있는지 확인.
- 일치하면: 6자리 숫자 OTP 생성 → salt 없이 단순 SHA-256 해시로 `otp_hash` 저장, `otp_expires_at = now +
  5분`, `otp_attempts = 0` → 알리고(Aligo) SMS API(`https://apis.aligo.in/send/`)로 실제 발송.
- 일치하지 않으면 아무것도 저장/발송하지 않는다.
- **두 경우 모두 동일하게** `{ ok: true }` 200 반환 — 계정 존재 여부를 노출하지 않기 위함. 단, 알리고
  호출 자체가 실패(네트워크 오류 등)한 경우는 진짜 오류이므로 502와 `{ error: 'sms_failed' }`를 반환한다.
- 알리고 자격 증명은 `wrangler secret put`으로 저장하는 `ALIGO_API_KEY`, `ALIGO_USER_ID`, `ALIGO_SENDER`
  (발신번호, 사전 등록 필요) 세 개의 Worker 시크릿으로 받는다. 코드에는 값이 들어가지 않는다 — 이 세
  시크릿은 사용자가 알리고에 직접 가입하고 발신번호를 등록한 뒤 넣어줘야 한다(내가 대신 만들 수 없음).

### `POST /verify-pin-reset-otp { phone, otp, newPin }`
- `otp_expires_at`이 지났으면 410과 `{ error: 'otp_expired' }`.
- `otp_attempts >= 5`면 429와 `{ error: 'otp_locked' }`.
- 해시 불일치면 `otp_attempts += 1`, 401과 `{ error: 'otp_invalid', attemptsLeft }`.
- 일치하면 새 `pin_salt`/`pin_hash` 계산해 교체, `otp_hash`/`otp_expires_at`/`otp_attempts` 초기화,
  `{ ok: true }` 200 반환.

### 인증 헤더
`/state` GET/POST는 보호된 엔드포인트다. 클라이언트는 매 요청에 `X-User-Id`, `X-Auth-Token` 헤더를
실어 보내고, Worker는 `users.id`+`users.token`이 일치하는지 확인한 뒤에만 처리한다. 불일치 시 401.

## 3. 동기화 (`GET /state` / `POST /state`)

### `GET /state` (헤더 인증)
`user_state.state_json`을 그대로 반환(없으면 `null`).

### `POST /state { state }` (헤더 인증)
`state`를 그대로 `user_state.state_json`에 upsert. 서버는 내용을 해석하지 않고 통짜 JSON으로 저장한다.

### 클라이언트 쪽 (`js/script.js`)
- 인증 토큰은 `appState`와 별도의 `localStorage` 키(`ai_helper_auth_v1`, `{ userId, token, name, phone }`)
  에 저장한다 — `saveState()`가 저장하는 JSON 안에 토큰이 섞이면 안 된다(서버로 그대로 전송되는 것이므로).
- `saveState()`(`js/script.js:44`)가 지금 쓰는 것과 같은 키 목록(`history, schedule, settings, guardian,
  profile, onboardingDone`)을 동기화 대상으로 삼는다. **`avatarPhoto`는 제외** — 원래 주석대로
  (`js/script.js:31-33`) 로컬 전용 사진이라 서버로 보내지 않는다.
- `saveState()` 끝에 `queueStateSync()`를 호출해 1.5초 디바운스 후 로그인 상태일 때만 `POST /state`를
  보낸다(`queueProfileSave()`/`saveProfileToServer()`의 디바운스 패턴과 동일한 방식, `js/script.js:3102-
  3119`를 대체).
- 로그인/자동 로그인 성공 직후 `GET /state`를 호출해 `state_json`이 있으면 `appState`의 해당 필드들을
  그 값으로 **덮어쓴다**(기존 `loadProfileFromServer()`의 "로컬 우선" 규칙과 다르다 — 여러 기기 동기화가
  목적이므로 마지막 로그인 기기의 서버 값이 항상 이긴다). 없으면(첫 가입) 현재 로컬 값을 그대로 올린다.
- 네트워크 실패는 사용자에게 노출하지 않고 조용히 넘어간다. 로컬은 항상 최신이므로 데이터 유실은 없고
  다음 `saveState()` 시점에 다시 시도된다.

## 4. 화면 흐름 (`index.html` / `js/script.js`)

### 부팅 분기 (`window.addEventListener('load', ...)`, `js/script.js:3700-3730`)
지금은 `appState.onboardingDone`으로 첫 화면을 정한다(`js/script.js:3709`). 이걸 "유효한 인증 토큰이
있는가"로 바꾼다:
- `ai_helper_auth_v1`에 토큰이 있으면 → `GET /state`를 시도하며 `screen-home`으로 바로 진입. 서버가
  401을 주면(토큰 무효화) 토큰을 지우고 `screen-login`으로 보낸다.
- 토큰이 없으면 → `screen-greet`.
`loadProfileFromServer()` 호출(`js/script.js:3729`)은 제거하고 위 로직으로 대체한다.

### 신규 화면
- **`screen-signup`**: 이름/전화번호/PIN(4자리)/PIN 확인 입력, "가입하기" 버튼. 하단에 "이미 계정이
  있으신가요? 로그인하기" 링크(`screen-login`). `screen-greet`의 "시작하기" 버튼(`index.html:73`)이
  기존 `goTo('screen-profile')` 대신 여기로 연결된다.
- **`screen-login`**: 전화번호/PIN 입력, "로그인" 버튼. "계정이 없으신가요? 회원가입" 링크
  (`screen-signup`), "PIN을 잊으셨나요?" 링크(`screen-reset-pin`).
- **`screen-reset-pin`**: 이름/전화번호 입력 → "인증번호 받기" 버튼 → 성공 시 6자리 OTP 입력칸과 새
  PIN/새 PIN 확인 입력칸이 나타남 → "재설정하기" 버튼 → 완료 후 `screen-login`으로.

가입/로그인 성공 후에는 지금처럼 `screen-profile`(`index.html:78`) → `screen-guardian-profile`
(`index.html:122`) → `startCoachmark()` 순서를 그대로 따른다 — 이 두 화면은 선택 입력이라는 성격이
바뀌지 않는다.

### 설정 화면 통합 (`screen-settings`, `index.html:945` 부근)
기존 "내 정보" 섹션(`index.html:979`) 위에 "계정" 섹션을 추가한다: 이름/전화번호(가운데 4자리를
`****`로 가린 표시) + "로그아웃" 버튼. 로그아웃은 `ai_helper_auth_v1`만 지우고 `screen-login`으로
이동한다(로컬 `appState`는 그대로 둔다 — 다음 로그인 때 서버 값으로 덮어써지므로 남아있어도 무방).

## 5. 에러 처리

| 화면 | 상황 | 문구 |
|---|---|---|
| screen-signup | 전화번호 9자리 미만 | "전화번호를 다시 확인해주세요" |
| screen-signup | PIN이 4자리 숫자 아님 | "PIN은 숫자 4자리로 입력해주세요" |
| screen-signup | PIN/PIN 확인 불일치 | "입력하신 PIN이 서로 달라요" |
| screen-signup | 이미 가입된 번호(409) | "이미 가입된 전화번호예요. 로그인해주세요" + 로그인 바로가기 |
| screen-login | 실패(401) | "전화번호 또는 PIN이 올바르지 않습니다" |
| screen-login | 잠금(423) | "너무 여러 번 틀렸어요. 15분 후 다시 시도해주세요" |
| screen-reset-pin | OTP 요청(항상 200) | "인증번호를 보냈습니다" |
| screen-reset-pin | Aligo 발송 실패(502) | "문자 발송에 실패했어요. 잠시 후 다시 시도해주세요" |
| screen-reset-pin | OTP 틀림(401) | "인증번호가 올바르지 않습니다 (N회 남음)" |
| screen-reset-pin | OTP 만료(410) | "인증번호가 만료됐어요. 다시 받아주세요" |
| (백그라운드) | `/state` 조회·전송 실패 | 사용자에게 노출하지 않음, 조용히 다음 기회에 재시도 |

## 범위 밖 (이번에 안 하는 것)

- PIN 변경(로그인된 상태에서 설정 화면에서 PIN만 바꾸는 기능) — 필요해지면 별도 요청.
- 회원 탈퇴(계정 삭제) 기능.
- 리프레시 토큰/토큰 만료 정책 — 토큰은 로그인마다 재발급될 뿐 자체 만료 시간은 없다(서버가 무효화하지
  않는 한 계속 유효).
