-- 사용자가 온보딩/설정에서 입력한 맞춤 안내용 프로필. 로그인이 없으므로 device_id(브라우저에 저장된 임의 식별자)로 구분한다.
CREATE TABLE IF NOT EXISTS profiles (
  device_id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  age_band TEXT DEFAULT '',
  region TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 경기데이터드림 "경로당 현황"(SenircentFaclt) Open API에서 가져온 실제 데이터의 스냅샷.
-- Cloudflare Workers가 openapi.gg.go.kr를 해외 IP로 인식해 직접 호출하지 못해(WAF 차단),
-- 로컬 PC에서 미리 내려받아 저장해두고 이 테이블로 서빙한다. 데이터 자체는 seed_senior_centers.sql 참고.
CREATE TABLE IF NOT EXISTS senior_centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sigun_nm TEXT,
  name TEXT,
  phone TEXT,
  address TEXT
);

-- 회원가입 계정(전화번호+PIN). PIN은 salt+SHA-256 해시로만 저장한다.
-- guardian_phone: 어르신이 설정 화면에 입력한 보호자 전화번호를 검색 가능한 컬럼으로도 복제해둔 것
-- (appState.guardian.phone 자체는 여전히 user_state의 JSON 통짜 안에 있다 — /state POST 처리 중 이 컬럼에도 동기화).
-- 보호자 앱이 "이 전화번호를 보호자로 등록해둔 어르신"을 찾을 때 이 컬럼으로 조회한다.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'senior' CHECK(role IN ('senior', 'guardian')),
  token TEXT,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TEXT,
  otp_hash TEXT,
  otp_expires_at TEXT,
  otp_attempts INTEGER DEFAULT 0,
  guardian_phone TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_guardian_phone ON users(guardian_phone);

-- appState 전체(기록·일정·설정·프로필·보호자 정보)를 통짜 JSON으로 저장한다.
-- 서버는 내용을 해석하지 않고 그대로 저장/반환만 한다.
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 보호자 본인 확인용 OTP. 아직 계정이 없는 전화번호이므로 users.otp_hash 대신 별도 테이블에 보관한다.
-- 평문 OTP는 저장하지 않고 해시와 만료 시각만 보관한다(PIN 재설정 OTP와 동일한 방식).
CREATE TABLE IF NOT EXISTS guardian_otp_requests (
  phone TEXT PRIMARY KEY,
  otp_hash TEXT NOT NULL,
  otp_expires_at TEXT NOT NULL,
  otp_attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 보호자별 연결 세션. 보호자는 별도 계정(users 행) 없이 전화번호+OTP 인증만으로 연결되므로
-- guardian_user_id는 두지 않는다. 보호자 한 명이 여러 어르신과 연결될 수 있어 token_hash는
-- (한 번의 인증에서 발급된) 같은 값이 여러 행에 걸쳐 나타날 수 있다 — UNIQUE 제약을 두지 않고
-- 조회용 인덱스만 둔다. 토큰 자체는 평문 대신 SHA-256 해시로 저장한다.
CREATE TABLE IF NOT EXISTS guardian_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  senior_user_id INTEGER NOT NULL REFERENCES users(id),
  guardian_phone TEXT NOT NULL,
  guardian_name TEXT DEFAULT '',
  token_hash TEXT NOT NULL,
  notification_enabled INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  UNIQUE(senior_user_id, guardian_phone)
);
CREATE INDEX IF NOT EXISTS idx_guardian_links_token ON guardian_links(token_hash);

-- 같은 어르신에게 여러 보호자가 연결될 수 있으므로 읽음 상태는 연결별로 분리한다.
CREATE TABLE IF NOT EXISTS guardian_message_reads (
  link_id INTEGER NOT NULL REFERENCES guardian_links(id),
  message_id TEXT NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(link_id, message_id)
);
