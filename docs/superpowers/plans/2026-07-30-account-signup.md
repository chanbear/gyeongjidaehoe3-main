# 회원가입(계정) 기능 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전화번호+PIN 회원가입/로그인을 도입하고, 로그인해야만 앱을 쓸 수 있게 하며, `appState` 전체(기록·일정·설정·프로필·보호자 정보)를 계정에 묶어 기기 간 동기화한다.

**Architecture:** Cloudflare Worker에 `/signup`, `/login`, `/request-pin-reset-otp`, `/verify-pin-reset-otp`, `GET/POST /state` 엔드포인트를 추가하고 D1에 `users`/`user_state` 테이블을 둔다. 클라이언트는 로그인 성공 시 받은 토큰을 별도 localStorage 키에 저장하고, 기존 `saveState()`(localStorage 저장)에 서버 동기화를 얹는다. 기존 `deviceId` 기반 `/profile` 저장 방식은 제거한다.

**Tech Stack:** Cloudflare Workers + D1(SQLite), Web Crypto API(`crypto.subtle`, `crypto.getRandomValues`) — 새 npm 의존성 없음. SMS 발송은 알리고(Aligo) HTTP API.

## Global Constraints

- 순수 HTML/CSS/JS 구조를 유지한다 — 프레임워크·번들러·빌드 스크립트를 새로 들이지 않는다.
- 루트(`index.html`/`js/script.js`/`css/styles.css`)를 고친 태스크는 반드시 `www/` 아래 동일 경로도 같이 고친다(`diff`로 두 트리가 일치하는지 확인).
- Worker 변경은 각 태스크에서 `npm run dev`(로컬) + `curl`로 직접 검증한다. **`npm run deploy`는 절대 실행하지 않는다** — 이 프로젝트는 배포를 사용자가 직접 승인한 뒤에만 한다.
- D1 스키마 확인은 `--remote`가 아니라 `npx wrangler d1 execute ansim_doumi_db --local --file=./schema.sql`로 로컬 사본에만 적용한다(worker/ 안에서 실행). 절대 `--remote`를 쓰지 않는다.
- PIN/OTP 해시는 `crypto.subtle.digest('SHA-256', ...)`로 계산한다. 평문 PIN·OTP를 로그에 남기거나 응답 바디에 그대로 담지 않는다.
- 알리고(Aligo) 자격 증명(`ALIGO_API_KEY`, `ALIGO_USER_ID`, `ALIGO_SENDER`)은 코드에 절대 하드코딩하지 않는다 — `env.ALIGO_API_KEY` 등으로만 참조한다. 로컬 테스트 시 이 시크릿이 없으면 발송 자체는 실패해도 되지만(502 응답), 그 앞단(OTP 생성/저장/응답 형식)까지는 검증한다.
- 새 화면(`screen-signup`/`screen-login`/`screen-reset-pin`)에는 반드시 `data-voice`(한국어 원문)와 `data-voice-i18n`(새 i18n 키)을 함께 단다 — 프로젝트의 동적 번역(`translateUiIfNeeded`)이 `I18N.ko`에 있는 키를 기준으로 자동 번역하므로, **`I18N.ko` 블록에만** 새 키를 추가하면 되고 zh/vi/th/uz 블록에는 추가하지 않는다(추가하면 오히려 그 언어만 API 번역을 못 받고 고정 문구로 굳어버린다).
- 인증 토큰(`ai_helper_auth_v1`)은 서버로 동기화되는 `appState` JSON과 절대 같은 곳에 섞이지 않는다.

---

### Task 1: D1 스키마 추가 + 크립토 헬퍼 함수

**Files:**
- Modify: `worker/schema.sql`
- Modify: `worker/src/index.js` (파일 상단, `RELAY_URL` 선언 부근에 헬퍼 함수 추가)

**Interfaces:**
- Produces: `randomHex(bytes)` — `crypto.getRandomValues`로 만든 랜덤 hex 문자열(토큰·salt용).
  `sha256Hex(text)` — 문자열을 SHA-256 해시해 hex로 반환하는 비동기 함수.
  `generateOtp()` — "123456" 형식의 6자리 숫자 문자열 하나를 반환.

- [ ] **Step 1: `worker/schema.sql`에 두 테이블 추가**

파일 끝에 이어서 추가한다(기존 `profiles`/`senior_centers` 테이블은 그대로 둔다 — 삭제하지 않는다):

```sql
-- 회원가입 계정(전화번호+PIN). PIN은 salt+SHA-256 해시로만 저장한다.
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

-- appState 전체(기록·일정·설정·프로필·보호자 정보)를 통짜 JSON으로 저장한다.
-- 서버는 내용을 해석하지 않고 그대로 저장/반환만 한다.
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: 로컬 D1에 스키마 반영**

`worker/` 안에서 실행:
```
npx wrangler d1 execute ansim_doumi_db --local --file=./schema.sql
```
Expected: `users`, `user_state` 테이블이 에러 없이 생성됨(이미 있던 `profiles`/`senior_centers`는 `IF NOT EXISTS`라 영향 없음).

- [ ] **Step 3: 크립토 헬퍼 함수 작성**

`worker/src/index.js`의 `const RELAY_URL = ...` 줄 위에 추가:

```js
/** 토큰·salt용 랜덤 hex 문자열. bytes=16이면 32자 hex. */
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 해시를 hex 문자열로. PIN/OTP는 평문으로 저장하지 않고 항상 이걸 거친다. */
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "123456" 형식의 6자리 숫자 OTP 하나를 만든다. */
function generateOtp() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}
```

- [ ] **Step 4: 문법 확인**

Run: `cd worker && node -c src/index.js`
Expected: 에러 없음(구문 오류만 잡는 용도 — Worker 런타임 API인 `crypto`는 Node에도 전역으로 있어 이 단계에서는 통과함).

- [ ] **Step 5: 커밋**

```bash
git add worker/schema.sql worker/src/index.js
git commit -m "회원가입용 D1 테이블(users/user_state)과 해시/토큰 헬퍼 함수 추가"
```

---

### Task 2: `/signup`, `/login` 엔드포인트

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: Task 1의 `randomHex`, `sha256Hex`, `json(data, status)`(기존 함수, `worker/src/index.js:149`).
- Produces: `POST /signup { phone, pin, name }` → `{ userId, token, name }` 또는 에러.
  `POST /login { phone, pin }` → `{ userId, token, name }` 또는 에러.
  이후 태스크(3, 4)가 같은 파일의 라우트 디스패치 구간에 이어붙이므로, 새 라우트는 기존 `/ask` 라우트(`worker/src/index.js:308` 부근) 바로 다음, `/profile` 라우트 바로 앞에 추가한다.

- [ ] **Step 1: `/signup` 라우트 작성**

`worker/src/index.js`의 `/profile` POST 라우트(`if (url.pathname === '/profile' && request.method === 'POST') {` 부근) 바로 위에 추가:

```js
if (url.pathname === '/signup' && request.method === 'POST') {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }
  const { phone, pin, name } = body || {};
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  if (phoneDigits.length < 9) return json({ error: 'invalid_phone' }, 400);
  if (!/^\d{4}$/.test(String(pin || ''))) return json({ error: 'invalid_pin' }, 400);

  try {
    const existing = await env.ansim_doumi_db.prepare(
      `SELECT id FROM users WHERE phone = ?`
    ).bind(phoneDigits).first();
    if (existing) return json({ error: 'phone_exists' }, 409);

    const pinSalt = randomHex(16);
    const pinHash = await sha256Hex(pinSalt + pin);
    const token = randomHex(32);

    const inserted = await env.ansim_doumi_db.prepare(
      `INSERT INTO users (phone, pin_hash, pin_salt, name, token)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(phoneDigits, pinHash, pinSalt, name || '', token).run();

    const userId = inserted.meta.last_row_id;
    return json({ userId, token, name: name || '' }, 200);
  } catch (err) {
    return json({ error: '가입에 실패했습니다.', detail: String(err && err.message || err) }, 502);
  }
}
```

- [ ] **Step 2: `/login` 라우트 작성**

바로 이어서 추가:

```js
if (url.pathname === '/login' && request.method === 'POST') {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }
  const { phone, pin } = body || {};
  const phoneDigits = String(phone || '').replace(/\D/g, '');

  try {
    const user = await env.ansim_doumi_db.prepare(
      `SELECT id, pin_hash, pin_salt, name, failed_attempts, locked_until FROM users WHERE phone = ?`
    ).bind(phoneDigits).first();

    if (!user) return json({ error: 'invalid' }, 401);

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return json({ error: 'locked' }, 423);
    }

    const pinHash = await sha256Hex(user.pin_salt + String(pin || ''));
    if (pinHash !== user.pin_hash) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lockedUntil = attempts >= 5
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
        : null;
      await env.ansim_doumi_db.prepare(
        `UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`
      ).bind(attempts, lockedUntil, user.id).run();
      return json({ error: lockedUntil ? 'locked' : 'invalid' }, lockedUntil ? 423 : 401);
    }

    const token = randomHex(32);
    await env.ansim_doumi_db.prepare(
      `UPDATE users SET token = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?`
    ).bind(token, user.id).run();

    return json({ userId: user.id, token, name: user.name || '' }, 200);
  } catch (err) {
    return json({ error: '로그인에 실패했습니다.', detail: String(err && err.message || err) }, 502);
  }
}
```

- [ ] **Step 3: 로컬 서버로 수동 검증**

`worker/` 안에서 `npm run dev`로 실행한 뒤, 다른 터미널에서(또는 `run_in_background`로 dev 서버를 띄운 뒤):

```
curl -s -X POST http://localhost:8787/signup -H "Content-Type: application/json" -d "{\"phone\":\"01099998888\",\"pin\":\"1234\",\"name\":\"테스트\"}"
```
Expected: `{"userId":1,"token":"...","name":"테스트"}` (200)

```
curl -s -X POST http://localhost:8787/signup -H "Content-Type: application/json" -d "{\"phone\":\"01099998888\",\"pin\":\"1234\",\"name\":\"테스트\"}"
```
Expected: `{"error":"phone_exists"}` (409, 중복 가입 차단 확인)

```
curl -s -X POST http://localhost:8787/login -H "Content-Type: application/json" -d "{\"phone\":\"01099998888\",\"pin\":\"9999\"}"
```
Expected: `{"error":"invalid"}` (401, PIN 틀림)

```
curl -s -X POST http://localhost:8787/login -H "Content-Type: application/json" -d "{\"phone\":\"01099998888\",\"pin\":\"1234\"}"
```
Expected: `{"userId":1,"token":"...","name":"테스트"}` (200, 로그인 성공 — Step 3에서 발급한 토큰과 다른 새 토큰인지 확인)

- [ ] **Step 4: 5회 실패 잠금 확인**

틀린 PIN으로 로그인을 5번 연달아 호출한 뒤 6번째 호출:
Expected: 5번째 호출부터 `{"error":"locked"}` (423) 반환.

- [ ] **Step 5: 커밋**

```bash
git add worker/src/index.js
git commit -m "회원가입/로그인 엔드포인트(/signup, /login) 추가: PIN 해시, 5회 실패 잠금"
```

---

### Task 3: PIN 재설정 OTP 엔드포인트 (알리고 연동)

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: Task 1의 `randomHex`, `sha256Hex`, `generateOtp`.
- Produces: `sendAligoSms(env, phoneDigits, message)` — Aligo 발송 헬퍼(성공 시 `true`, 실패 시 `false` 반환, throw하지 않음).
  `POST /request-pin-reset-otp { phone, name }` → 항상 `{ ok: true }`(계정 없어도 동일), 단 Aligo 호출 자체가 실패하면 502.
  `POST /verify-pin-reset-otp { phone, otp, newPin }` → `{ ok: true }` 또는 에러.

- [ ] **Step 1: 알리고 발송 헬퍼 작성**

`worker/src/index.js`의 `generateOtp` 함수 바로 아래(Task 1에서 추가한 위치)에 이어서 추가:

```js
/** 알리고(Aligo) SMS 발송. 자격 증명이 없거나 호출이 실패하면 false만 반환한다(throw하지 않음) —
 *  호출부가 "OTP를 만들었는지"와 "실제로 보내졌는지"를 구분해 처리할 수 있게 하기 위함. */
async function sendAligoSms(env, phoneDigits, message) {
  if (!env.ALIGO_API_KEY || !env.ALIGO_USER_ID || !env.ALIGO_SENDER) return false;
  try {
    const form = new URLSearchParams({
      key: env.ALIGO_API_KEY,
      user_id: env.ALIGO_USER_ID,
      sender: env.ALIGO_SENDER,
      receiver: phoneDigits,
      msg: message,
    });
    const res = await fetch('https://apis.aligo.in/send/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) return false;
    const data = await res.json();
    // 알리고는 HTTP 200이어도 result_code가 음수면 실패다.
    return Number(data.result_code) >= 0;
  } catch (err) {
    console.warn('알리고 발송 실패:', err && err.message || err);
    return false;
  }
}
```

- [ ] **Step 2: `/request-pin-reset-otp` 라우트 작성**

`/login` 라우트 바로 다음에 추가:

```js
if (url.pathname === '/request-pin-reset-otp' && request.method === 'POST') {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }
  const { phone, name } = body || {};
  const phoneDigits = String(phone || '').replace(/\D/g, '');

  try {
    const user = await env.ansim_doumi_db.prepare(
      `SELECT id FROM users WHERE phone = ? AND name = ?`
    ).bind(phoneDigits, String(name || '')).first();

    // 계정 존재 여부를 노출하지 않기 위해, 일치하지 않아도 여기서 바로 성공 응답을 준비한다(아래서 return).
    if (user) {
      const otp = generateOtp();
      const otpHash = await sha256Hex(otp);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await env.ansim_doumi_db.prepare(
        `UPDATE users SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0 WHERE id = ?`
      ).bind(otpHash, expiresAt, user.id).run();

      const sent = await sendAligoSms(env, phoneDigits, `[온담] 인증번호는 ${otp}입니다. 5분 이내에 입력해주세요.`);
      if (!sent) return json({ error: 'sms_failed' }, 502);
    }

    return json({ ok: true }, 200);
  } catch (err) {
    return json({ error: '요청 처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
  }
}
```

- [ ] **Step 3: `/verify-pin-reset-otp` 라우트 작성**

바로 이어서 추가:

```js
if (url.pathname === '/verify-pin-reset-otp' && request.method === 'POST') {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }
  const { phone, otp, newPin } = body || {};
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(String(newPin || ''))) return json({ error: 'invalid_pin' }, 400);

  try {
    const user = await env.ansim_doumi_db.prepare(
      `SELECT id, otp_hash, otp_expires_at, otp_attempts FROM users WHERE phone = ?`
    ).bind(phoneDigits).first();
    if (!user || !user.otp_hash) return json({ error: 'otp_invalid', attemptsLeft: 0 }, 401);

    if (new Date(user.otp_expires_at).getTime() < Date.now()) {
      return json({ error: 'otp_expired' }, 410);
    }
    if ((user.otp_attempts || 0) >= 5) {
      return json({ error: 'otp_locked' }, 429);
    }

    const otpHash = await sha256Hex(String(otp || ''));
    if (otpHash !== user.otp_hash) {
      const attempts = (user.otp_attempts || 0) + 1;
      await env.ansim_doumi_db.prepare(
        `UPDATE users SET otp_attempts = ? WHERE id = ?`
      ).bind(attempts, user.id).run();
      return json({ error: 'otp_invalid', attemptsLeft: 5 - attempts }, 401);
    }

    const pinSalt = randomHex(16);
    const pinHash = await sha256Hex(pinSalt + String(newPin));
    await env.ansim_doumi_db.prepare(
      `UPDATE users SET pin_hash = ?, pin_salt = ?, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = ?`
    ).bind(pinHash, pinSalt, user.id).run();

    return json({ ok: true }, 200);
  } catch (err) {
    return json({ error: '재설정에 실패했습니다.', detail: String(err && err.message || err) }, 502);
  }
}
```

- [ ] **Step 4: 로컬 서버로 수동 검증**

알리고 시크릿을 로컬에 설정하지 않은 상태로 검증한다(자격 증명 없이도 앞단 로직은 확인 가능):

```
curl -s -X POST http://localhost:8787/request-pin-reset-otp -H "Content-Type: application/json" -d "{\"phone\":\"01099998888\",\"name\":\"테스트\"}"
```
Expected: `{"error":"sms_failed"}` (502) — 이름/전화번호는 일치하지만 `ALIGO_API_KEY`가 없어 발송 자체가 실패하는 것이 정상. `user_state`가 아니라 `users.otp_hash`에 값이 채워졌는지는 아래 커맨드로 직접 확인:
```
npx wrangler d1 execute ansim_doumi_db --local --command "SELECT phone, otp_hash, otp_expires_at FROM users WHERE phone='01099998888'"
```
Expected: `otp_hash`/`otp_expires_at`가 채워져 있음(발송 실패와 무관하게 OTP 자체는 생성·저장됨).

```
curl -s -X POST http://localhost:8787/request-pin-reset-otp -H "Content-Type: application/json" -d "{\"phone\":\"01099998888\",\"name\":\"엉뚱한이름\"}"
```
Expected: `{"ok":true}` (200) — 이름이 안 맞아도 동일하게 성공 응답(계정 존재 노출 방지). 위 SQL로 `otp_hash`가 그대로(안 바뀜)인지 확인.

- [ ] **Step 5: 커밋**

```bash
git add worker/src/index.js
git commit -m "PIN 재설정 OTP 엔드포인트(/request-pin-reset-otp, /verify-pin-reset-otp) 추가, 알리고 SMS 연동"
```

---

### Task 4: `GET/POST /state` 엔드포인트 + 인증 헤더 검증 + 기존 `/profile` 제거

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `json()`, D1 바인딩(`env.ansim_doumi_db`).
- Produces: `GET /state`(헤더 `X-User-Id`/`X-Auth-Token`) → `{ state: <저장된 JSON> | null }`.
  `POST /state { state }`(같은 헤더) → `{ ok: true }`.
  두 엔드포인트 모두 토큰 불일치 시 401.

- [ ] **Step 1: CORS 헤더에 커스텀 인증 헤더 허용 추가**

`worker/src/index.js:24-28`의 `CORS_HEADERS`를 수정:

```js
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token',
};
```

- [ ] **Step 2: GET 허용 목록에 `/state` 추가**

`worker/src/index.js:240`을 수정:

```js
const isAllowedGet = request.method === 'GET' && (url.pathname === '/state' || url.pathname === '/region-info');
```
(`/profile`은 이 태스크에서 제거하므로 목록에서 뺀다.)

- [ ] **Step 3: 인증 검증 헬퍼 작성**

Task 3에서 추가한 `sendAligoSms` 함수 바로 아래에 추가:

```js
/** X-User-Id/X-Auth-Token 헤더가 실제 발급된 토큰과 일치하는 유저인지 확인한다.
 *  일치하면 유저 id(숫자)를, 아니면 null을 반환한다 — throw하지 않아 호출부가 항상 401 처리로 통일할 수 있다. */
async function authenticateRequest(env, request) {
  const userId = Number(request.headers.get('X-User-Id'));
  const token = request.headers.get('X-Auth-Token');
  if (!userId || !token) return null;
  const row = await env.ansim_doumi_db.prepare(
    `SELECT id FROM users WHERE id = ? AND token = ?`
  ).bind(userId, token).first();
  return row ? row.id : null;
}
```

- [ ] **Step 4: `GET/POST /state` 라우트 작성**

기존 `/profile` GET/POST 라우트(`worker/src/index.js:350-388`)를 통째로 아래 코드로 교체한다:

```js
if (url.pathname === '/state' && request.method === 'GET') {
  const userId = await authenticateRequest(env, request);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  try {
    const row = await env.ansim_doumi_db.prepare(
      `SELECT state_json FROM user_state WHERE user_id = ?`
    ).bind(userId).first();
    return json({ state: row ? JSON.parse(row.state_json) : null }, 200);
  } catch (err) {
    return json({ error: '불러오기에 실패했습니다.', detail: String(err && err.message || err) }, 502);
  }
}

if (url.pathname === '/state' && request.method === 'POST') {
  const userId = await authenticateRequest(env, request);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }
  try {
    await env.ansim_doumi_db.prepare(
      `INSERT INTO user_state (user_id, state_json, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         state_json = excluded.state_json, updated_at = excluded.updated_at`
    ).bind(userId, JSON.stringify(body.state || {})).run();
    return json({ ok: true }, 200);
  } catch (err) {
    return json({ error: '저장에 실패했습니다.', detail: String(err && err.message || err) }, 502);
  }
}
```

- [ ] **Step 5: 로컬 서버로 수동 검증**

Task 2에서 로그인해 받은 `userId`/`token`을 그대로 써서:

```
curl -s http://localhost:8787/state -H "X-User-Id: 1" -H "X-Auth-Token: <로그인 응답의 token>"
```
Expected: `{"state":null}` (200, 아직 아무것도 안 올렸으므로)

```
curl -s -X POST http://localhost:8787/state -H "Content-Type: application/json" -H "X-User-Id: 1" -H "X-Auth-Token: <token>" -d "{\"state\":{\"hello\":\"world\"}}"
```
Expected: `{"ok":true}` (200)

```
curl -s http://localhost:8787/state -H "X-User-Id: 1" -H "X-Auth-Token: <token>"
```
Expected: `{"state":{"hello":"world"}}` (200, 방금 저장한 값이 그대로 돌아옴)

```
curl -s http://localhost:8787/state -H "X-User-Id: 1" -H "X-Auth-Token: 틀린토큰"
```
Expected: `{"error":"unauthorized"}` (401)

```
curl -s http://localhost:8787/profile
```
Expected: 404(엔드포인트가 삭제되어 더 이상 존재하지 않음을 확인).

- [ ] **Step 6: 커밋**

```bash
git add worker/src/index.js
git commit -m "appState 전체 동기화용 /state 엔드포인트 추가, 인증 헤더 검증, 기존 /profile 엔드포인트 제거"
```

---

### Task 5: 프론트엔드 인증/동기화 클라이언트 함수

**Files:**
- Modify: `js/script.js`

**Interfaces:**
- Consumes: `AI_WORKER_URL`(`js/script.js:1157`), `appState`, `saveState()`(`js/script.js:44`).
- Produces: `getAuth()` → `{userId, token, name, phone} | null`. `setAuth(auth)`. `clearAuth()`.
  `async function signupRequest(phone, pin, name)` → `{ ok: true, ... } | { ok: false, error }`.
  `async function loginRequest(phone, pin)` → 위와 동일한 형태.
  `async function requestPinResetOtp(phone, name)`, `async function verifyPinResetOtp(phone, otp, newPin)`.
  `queueStateSync()` — 디바운스 후 `POST /state` 호출.
  `async function pullStateFromServer()` — 로그인 직후 1회 호출, 서버 값으로 `appState` 필드를 덮어씀.

이 태스크는 화면 UI 없이 함수만 추가한다(태스크 6이 화면에 연결한다). 검증은 브라우저 콘솔에서 함수를 직접 호출해 확인한다.

- [ ] **Step 1: 인증 저장소 함수 작성**

`js/script.js`의 `DEVICE_ID_KEY`/`getDeviceId()` 정의(`js/script.js:3092-3100`)를 아래 코드로 교체(deviceId 개념 자체를 없앤다):

```js
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
```

- [ ] **Step 2: 회원가입/로그인/PIN 재설정 요청 함수 작성**

바로 이어서 추가:

```js
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
```

- [ ] **Step 3: 상태 동기화 함수 작성, `saveState()`에 연결**

`js/script.js:44-58`의 `saveState()`를 아래로 교체(끝에 `queueStateSync()` 호출 추가):

```js
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
```

같은 구역에 이어서 추가(동기화 대상에서 `avatarPhoto`는 제외 — 로컬 전용 사진이므로):

```js
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
```

- [ ] **Step 4: `setProfileField()`의 중복 서버 저장 호출 제거**

`js/script.js:3056-3065`의 `setProfileField()`에서 `queueProfileSave();` 줄을 삭제한다(이제 `saveState()`가 이미 `queueStateSync()`를 호출하므로 중복). 그리고 기존 `queueProfileSave()`/`saveProfileToServer()`/`loadProfileFromServer()` 함수 정의(`js/script.js:3102-3139` 부근, `getDeviceId` 다음)를 통째로 삭제한다.

- [ ] **Step 5: 문법 확인**

Run: `node -c js/script.js`
Expected: 에러 없음.

- [ ] **Step 6: 브라우저 콘솔로 수동 검증**

`worker/`에서 `npm run dev`를 띄운 상태로 앱을 브라우저에서 열고(로컬 정적 서버), 콘솔에서:

```js
await signupRequest('01099997777', '1234', '테스트유저')
getAuth() // { userId, token, name: '테스트유저', phone: '01099997777' } 형태인지 확인
appState.schedule.push({ id: 'x', text: 'test' }); saveState();
// 1.5초 뒤 Network 탭에서 POST /state 요청이 실제로 나가는지 확인
```
Expected: `signupRequest` 결과 `{ok:true}`, `getAuth()`가 올바른 값을 반환, `saveState()` 호출 1.5초 후 `/state` POST가 실제로 전송됨.

- [ ] **Step 7: 커밋**

```bash
git add js/script.js
git commit -m "회원가입/로그인/PIN재설정 클라이언트 함수와 appState 전체 서버 동기화(queueStateSync/pullStateFromServer) 추가"
```

---

### Task 6: `screen-signup` / `screen-login` / `screen-reset-pin` 화면

**Files:**
- Modify: `index.html` (screen-greet 다음, screen-profile 앞에 세 화면 삽입)
- Modify: `js/script.js` (화면 핸들러 함수 + `I18N.ko`에 새 키 추가)

**Interfaces:**
- Consumes: Task 5의 `signupRequest`, `loginRequest`, `requestPinResetOtp`, `verifyPinResetOtp`, `pullStateFromServer`, `getAuth`.
- Produces: `handleSignupSubmit()`, `handleLoginSubmit()`, `handleRequestResetOtp()`, `handleVerifyResetOtp()` — 모두 `index.html`의 버튼 `onclick`에서 호출.

- [ ] **Step 1: `index.html`에 `screen-signup` 추가**

`index.html:75`(`screen-greet`의 닫는 `</section>`) 바로 다음, `screen-profile`(`index.html:78`) 바로 앞에 삽입:

```html
<!-- 회원가입: 전화번호+PIN 계정을 만든다. 로그인해야만 앱을 쓸 수 있다. -->
<section class="screen" id="screen-signup" data-voice="이름과 전화번호, 4자리 숫자 PIN을 입력해서 가입해주세요." data-voice-i18n="onboard.signup.voice">
  <div class="topbar"><span></span><button class="replay-btn" data-replay aria-label="음성 다시 듣기"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-speaker"></use></svg><span data-i18n="onboard.replay">다시 듣기</span></button></div>
  <h1 data-i18n="onboard.signup.title">회원가입</h1>
  <p class="desc" data-i18n="onboard.signup.desc">전화번호와 PIN 번호로 계정을 만들어요.<br>이 계정으로 다른 기기에서도 내 정보를 이어서 쓸 수 있어요.</p>

  <div class="settings-section">
    <h2 data-i18n="settings.nameLabel">이름</h2>
    <div class="field-row">
      <input type="text" id="signupName" placeholder="예: 홍길동" data-i18n-placeholder="settings.namePlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
  </div>

  <div class="settings-section">
    <h2 data-i18n="settings.guardianPhoneLabel">전화번호</h2>
    <div class="field-row">
      <input type="tel" id="signupPhone" placeholder="예: 010-1234-5678" data-i18n-placeholder="settings.guardianPhonePlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
  </div>

  <div class="settings-section">
    <h2 data-i18n="onboard.signup.pinLabel">PIN 번호 (숫자 4자리)</h2>
    <div class="field-row">
      <input type="password" inputmode="numeric" maxlength="4" id="signupPin" placeholder="예: 1234" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
    <div class="field-row" style="margin-top:10px;">
      <input type="password" inputmode="numeric" maxlength="4" id="signupPinConfirm" placeholder="PIN 다시 입력" data-i18n-placeholder="onboard.signup.pinConfirmPlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
  </div>

  <p class="settings-save-note" id="signupError" style="display:none;color:var(--danger-strong,#c0392b);"></p>

  <button class="primary-btn" onclick="handleSignupSubmit()" data-i18n="onboard.signup.submit">가입하기</button>
  <button class="nav-btn" style="align-self:center;color:var(--ink-faint);" onclick="goTo('screen-login')" data-i18n="onboard.signup.toLogin">이미 계정이 있으신가요? 로그인하기</button>
</section>

<!-- 로그인 -->
<section class="screen" id="screen-login" data-voice="전화번호와 PIN 번호를 입력해서 로그인해주세요." data-voice-i18n="onboard.login.voice">
  <div class="topbar"><span></span><button class="replay-btn" data-replay aria-label="음성 다시 듣기"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-speaker"></use></svg><span data-i18n="onboard.replay">다시 듣기</span></button></div>
  <h1 data-i18n="onboard.login.title">로그인</h1>
  <p class="desc" data-i18n="onboard.login.desc">가입할 때 쓴 전화번호와 PIN 번호를 입력해주세요.</p>

  <div class="settings-section">
    <h2 data-i18n="settings.guardianPhoneLabel">전화번호</h2>
    <div class="field-row">
      <input type="tel" id="loginPhone" placeholder="예: 010-1234-5678" data-i18n-placeholder="settings.guardianPhonePlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
  </div>

  <div class="settings-section">
    <h2 data-i18n="onboard.signup.pinLabel">PIN 번호 (숫자 4자리)</h2>
    <div class="field-row">
      <input type="password" inputmode="numeric" maxlength="4" id="loginPin" placeholder="예: 1234" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
  </div>

  <p class="settings-save-note" id="loginError" style="display:none;color:var(--danger-strong,#c0392b);"></p>

  <button class="primary-btn" onclick="handleLoginSubmit()" data-i18n="onboard.login.submit">로그인</button>
  <button class="nav-btn" style="align-self:center;color:var(--ink-faint);" onclick="goTo('screen-signup')" data-i18n="onboard.login.toSignup">계정이 없으신가요? 회원가입</button>
  <button class="nav-btn" style="align-self:center;color:var(--ink-faint);" onclick="goTo('screen-reset-pin')" data-i18n="onboard.login.forgotPin">PIN을 잊으셨나요?</button>
</section>

<!-- PIN 재설정: 알리고 OTP 인증 -->
<section class="screen" id="screen-reset-pin" data-voice="이름과 전화번호를 입력하면 인증번호를 문자로 보내드려요." data-voice-i18n="onboard.resetPin.voice">
  <div class="topbar"><button class="nav-btn" onclick="goTo('screen-login')" data-i18n="onboard.login.title">← 로그인</button><span></span></div>
  <h1 data-i18n="onboard.resetPin.title">PIN 재설정</h1>
  <p class="desc" data-i18n="onboard.resetPin.desc">가입할 때 쓴 이름과 전화번호를 입력하면 인증번호를 문자로 보내드려요.</p>

  <div class="settings-section" id="resetPinStep1">
    <h2 data-i18n="settings.nameLabel">이름</h2>
    <div class="field-row">
      <input type="text" id="resetPinName" placeholder="예: 홍길동" data-i18n-placeholder="settings.namePlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
    <div class="field-row" style="margin-top:10px;">
      <input type="tel" id="resetPinPhone" placeholder="예: 010-1234-5678" data-i18n-placeholder="settings.guardianPhonePlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
    <button class="secondary-btn" style="margin-top:12px;" onclick="handleRequestResetOtp()" data-i18n="onboard.resetPin.requestOtp">인증번호 받기</button>
  </div>

  <div class="settings-section" id="resetPinStep2" style="display:none;">
    <h2 data-i18n="onboard.resetPin.otpLabel">인증번호 (6자리)</h2>
    <div class="field-row">
      <input type="text" inputmode="numeric" maxlength="6" id="resetPinOtp" placeholder="예: 123456" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
    <h2 style="margin-top:16px;" data-i18n="onboard.signup.pinLabel">PIN 번호 (숫자 4자리)</h2>
    <div class="field-row">
      <input type="password" inputmode="numeric" maxlength="4" id="resetPinNewPin" placeholder="예: 1234" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
    <div class="field-row" style="margin-top:10px;">
      <input type="password" inputmode="numeric" maxlength="4" id="resetPinNewPinConfirm" placeholder="PIN 다시 입력" data-i18n-placeholder="onboard.signup.pinConfirmPlaceholder" style="min-height:56px;border:2px solid var(--line);border-radius:var(--radius-md);padding:0 16px;font-size:18px;color:var(--ink);font-family:inherit;">
    </div>
    <button class="primary-btn" style="margin-top:12px;" onclick="handleVerifyResetOtp()" data-i18n="onboard.resetPin.submit">재설정하기</button>
  </div>

  <p class="settings-save-note" id="resetPinError" style="display:none;color:var(--danger-strong,#c0392b);"></p>
  <p class="settings-save-note" id="resetPinNotice" style="display:none;"></p>
</section>
```

- [ ] **Step 2: `js/script.js`에 화면 핸들러 함수 작성**

Task 5에서 추가한 함수들 바로 아래에 추가:

```js
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

  if (guardianPhoneDigits(phone).length < 9) return showFieldError('signupError', t('onboard.signup.errorPhone'));
  if (!/^\d{4}$/.test(pin)) return showFieldError('signupError', t('onboard.signup.errorPinFormat'));
  if (pin !== pinConfirm) return showFieldError('signupError', t('onboard.signup.errorPinMismatch'));

  showFieldError('signupError', '');
  const result = await signupRequest(phone, pin, name);
  if (!result.ok) {
    if (result.error === 'phone_exists') return showFieldError('signupError', t('onboard.signup.errorPhoneExists'));
    return showFieldError('signupError', t('onboard.signup.errorGeneric'));
  }
  appState.profile.name = name;
  saveState();
  goTo('screen-profile');
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
  goTo('screen-login');
}
```

- [ ] **Step 3: `I18N.ko`에 새 키 추가**

`I18N` 객체의 `ko` 블록(다른 `onboard.*`/`settings.*` 키들이 있는 곳) 안에 이어서 추가:

```js
'onboard.signup.title': '회원가입', 'onboard.signup.desc': '전화번호와 PIN 번호로 계정을 만들어요.<br>이 계정으로 다른 기기에서도 내 정보를 이어서 쓸 수 있어요.',
'onboard.signup.pinLabel': 'PIN 번호 (숫자 4자리)', 'onboard.signup.pinConfirmPlaceholder': 'PIN 다시 입력',
'onboard.signup.submit': '가입하기', 'onboard.signup.toLogin': '이미 계정이 있으신가요? 로그인하기',
'onboard.signup.errorPhone': '전화번호를 다시 확인해주세요', 'onboard.signup.errorPinFormat': 'PIN은 숫자 4자리로 입력해주세요',
'onboard.signup.errorPinMismatch': '입력하신 PIN이 서로 달라요', 'onboard.signup.errorPhoneExists': '이미 가입된 전화번호예요. 로그인해주세요',
'onboard.signup.errorGeneric': '가입에 실패했어요. 잠시 후 다시 시도해주세요',
'onboard.login.title': '로그인', 'onboard.login.desc': '가입할 때 쓴 전화번호와 PIN 번호를 입력해주세요.',
'onboard.login.submit': '로그인', 'onboard.login.toSignup': '계정이 없으신가요? 회원가입', 'onboard.login.forgotPin': 'PIN을 잊으셨나요?',
'onboard.login.errorInvalid': '전화번호 또는 PIN이 올바르지 않습니다', 'onboard.login.errorLocked': '너무 여러 번 틀렸어요. 15분 후 다시 시도해주세요',
'onboard.resetPin.title': 'PIN 재설정', 'onboard.resetPin.desc': '가입할 때 쓴 이름과 전화번호를 입력하면 인증번호를 문자로 보내드려요.',
'onboard.resetPin.requestOtp': '인증번호 받기', 'onboard.resetPin.otpLabel': '인증번호 (6자리)', 'onboard.resetPin.submit': '재설정하기',
'onboard.resetPin.otpSentNotice': '인증번호를 보냈습니다', 'onboard.resetPin.errorSmsFailed': '문자 발송에 실패했어요. 잠시 후 다시 시도해주세요',
'onboard.resetPin.errorOtpExpired': '인증번호가 만료됐어요. 다시 받아주세요', 'onboard.resetPin.errorOtpLocked': '너무 여러 번 틀렸어요. 처음부터 다시 시도해주세요',
'onboard.resetPin.errorOtpInvalid': '인증번호가 올바르지 않습니다 ({n}회 남음)',
'onboard.signup.voice': '이름과 전화번호, 4자리 숫자 PIN을 입력해서 가입해주세요.',
'onboard.login.voice': '전화번호와 PIN 번호를 입력해서 로그인해주세요.',
'onboard.resetPin.voice': '이름과 전화번호를 입력하면 인증번호를 문자로 보내드려요.',
```

- [ ] **Step 4: `screen-greet`의 "시작하기" 버튼을 `screen-signup`으로 연결**

`index.html:73`을 수정:
```html
<button class="primary-btn" onclick="goTo('screen-signup')" data-i18n="onboard.greet.start">시작하기</button>
```

- [ ] **Step 5: 문법 확인 + 브라우저 수동 검증**

Run: `node -c js/script.js`

브라우저에서 `screen-greet` → "시작하기" → `screen-signup`으로 새 이름/전화번호/PIN을 입력해 "가입하기" → `screen-profile`로 넘어가는지 확인. `screen-login`에서 방금 가입한 계정으로 로그인해 `screen-home`으로 가는지 확인. `screen-reset-pin`에서 "인증번호 받기"를 눌러(알리고 시크릿이 없어 발송은 실패하지만) `otp_hash`가 DB에 채워지는지는 Task 3에서 이미 확인했으므로, 여기서는 에러 문구가 화면에 뜨는지("문자 발송에 실패했어요")만 확인.

- [ ] **Step 6: root → www 동기화**

```bash
cp index.html www/index.html
cp js/script.js www/js/script.js
diff index.html www/index.html && diff js/script.js www/js/script.js && echo SYNCED_OK
```

- [ ] **Step 7: 커밋**

```bash
git add index.html js/script.js www/index.html www/js/script.js
git commit -m "회원가입/로그인/PIN재설정 화면(screen-signup/screen-login/screen-reset-pin) 추가"
```

---

### Task 7: 부팅 분기를 로그인 여부로 교체 + 기존 deviceId 코드 잔재 정리

**Files:**
- Modify: `js/script.js`

**Interfaces:**
- Consumes: Task 5의 `getAuth()`, `pullStateFromServer()`, `clearAuth()`.

- [ ] **Step 1: `window.addEventListener('load', ...)` 부팅 로직 교체**

`js/script.js:3700-3730`을 아래로 교체:

```js
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
```

- [ ] **Step 2: `onboardScreens`에 새 화면 추가 여부 확인**

`js/script.js:144`의 `onboardScreens`는 `screen-greet`/`screen-profile`/`screen-guardian-profile`/`screen-tutorial-ai-notice`를 포함한다. `screen-signup`/`screen-login`/`screen-reset-pin`도 온보딩과 같은 성격(긴급 도움 FAB 숨김 등)이므로 이 Set에 추가한다:

```js
const onboardScreens = new Set(['screen-greet', 'screen-signup', 'screen-login', 'screen-reset-pin', 'screen-profile', 'screen-guardian-profile', 'screen-tutorial-ai-notice']);
```

- [ ] **Step 3: 문법 확인**

Run: `node -c js/script.js`

- [ ] **Step 4: 브라우저 수동 검증**

`localStorage`를 비우고(시크릿 창 또는 `localStorage.clear()`) 새로고침 → `screen-greet`에서 시작하는지 확인. Task 6에서 가입한 계정으로 로그인 → 새로고침 → 토큰이 있으므로 `screen-greet`를 건너뛰고 바로 `screen-home`으로 가는지 확인. `localStorage`에서 `ai_helper_auth_v1`의 `token` 값을 임의로 깨뜨린 뒤 새로고침 → 401을 받아 `screen-login`으로 가는지 확인.

- [ ] **Step 5: root → www 동기화**

```bash
cp js/script.js www/js/script.js
diff js/script.js www/js/script.js && echo SYNCED_OK
```

- [ ] **Step 6: 커밋**

```bash
git add js/script.js www/js/script.js
git commit -m "부팅 분기를 onboardingDone에서 로그인 토큰 유효성으로 교체"
```

---

### Task 8: 설정 화면 "계정" 섹션(로그아웃) 통합

**Files:**
- Modify: `index.html` (screen-settings)
- Modify: `js/script.js`

**Interfaces:**
- Consumes: Task 5의 `getAuth()`, `clearAuth()`.

- [ ] **Step 1: `index.html`의 "내 정보" 섹션 위에 "계정" 섹션 추가**

`index.html:978`(`<div class="settings-section">` — "내 정보" 섹션 시작) 바로 위에 삽입:

```html
<div class="settings-section">
  <h2><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-user"></use></svg><span data-i18n="settings.accountTitle">계정</span></h2>
  <p class="settings-save-note" style="text-align:left;" id="accountInfoLine"></p>
  <button class="secondary-btn" style="margin-top:10px;" onclick="handleLogout()" data-i18n="settings.logout">로그아웃</button>
</div>
```

- [ ] **Step 2: 계정 정보 표시 + 로그아웃 함수 작성**

`js/script.js:3038`의 `function syncSettingsUI(){` 정의 안, 끝부분(`applyLanguage();` 줄 바로 앞)에 계정 정보 표시 로직을 추가한다:

```js
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
```

이어서 로그아웃 함수를 추가:

```js
function handleLogout(){
  clearAuth();
  goTo('screen-login');
}
```

- [ ] **Step 3: `I18N.ko`에 새 키 추가**

```js
'settings.accountTitle': '계정', 'settings.logout': '로그아웃',
```

- [ ] **Step 4: 문법 확인 + 브라우저 수동 검증**

Run: `node -c js/script.js`

로그인된 상태에서 설정 화면을 열어 "계정" 섹션에 이름·마스킹된 전화번호가 보이는지 확인. "로그아웃"을 눌러 `screen-login`으로 이동하는지, 새로고침해도 로그인 화면에 머무는지(토큰이 지워졌으므로) 확인.

- [ ] **Step 5: root → www 동기화**

```bash
cp index.html www/index.html
cp js/script.js www/js/script.js
diff index.html www/index.html && diff js/script.js www/js/script.js && echo SYNCED_OK
```

- [ ] **Step 6: 커밋**

```bash
git add index.html js/script.js www/index.html www/js/script.js
git commit -m "설정 화면에 계정 섹션(이름/전화번호 표시, 로그아웃) 추가"
```

---

### Task 9: 전체 흐름 통합 테스트 + CLAUDE.md 갱신

**Files:**
- Modify: `CLAUDE.md` (8번 항목 갱신 — deviceId 기반 프로필 저장 설명을 계정 기반 동기화로 교체)

**Interfaces:**
- 없음(통합 검증 + 문서 갱신).

- [ ] **Step 1: 전체 시나리오 브라우저 수동 테스트**

`worker/`에서 `npm run dev`를 띄운 채로:
1. `localStorage.clear()` 후 새로고침 → `screen-greet` → "시작하기" → `screen-signup`에서 새 계정 가입 → `screen-profile`(성별/나이/지역 입력) → `screen-guardian-profile`(보호자 정보 입력) → 코치마크 튜토리얼 진입까지 확인.
2. 튜토리얼을 마치고 홈에서 일정을 하나 추가 → 설정에서 로그아웃 → 다시 로그인 → 방금 추가한 일정과 입력한 프로필/보호자 정보가 그대로 남아있는지 확인(서버 동기화가 실제로 됐는지의 핵심 검증).
3. 잘못된 PIN으로 5회 로그인 시도 → 잠금 문구 확인.
4. "PIN을 잊으셨나요?" → 이름/전화번호 입력 → "인증번호 받기"(알리고 시크릿이 없으면 "문자 발송에 실패했어요" 문구까지만 확인 — 실제 문자 수신 테스트는 알리고 자격 증명을 넣은 뒤 사용자가 직접 확인).
5. 콘솔에 에러가 없는지 확인.

- [ ] **Step 2: `CLAUDE.md` 8번 항목 갱신**

기존 "`appState.profile`... D1... deviceId..." 설명 문단을, 이번에 만든 계정 기반 동기화(회원가입/로그인, `users`/`user_state` 테이블, `/state` 엔드포인트, 로그인 필수)로 바꿔 쓴다. 알리고(Aligo) 시크릿 3종(`ALIGO_API_KEY`/`ALIGO_USER_ID`/`ALIGO_SENDER`)이 `wrangler secret put`으로 필요하다는 점도 9번 문단 근처의 "필요한 시크릿" 설명에 추가한다.

- [ ] **Step 3: 커밋**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md 갱신: 회원가입/로그인 기반 계정 동기화로 8번 항목 재작성"
```
