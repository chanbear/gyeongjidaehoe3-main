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
  created_at TEXT DEFAULT (datetime('now'))
);

-- appState 전체(기록·일정·설정·프로필·보호자 정보)를 통짜 JSON으로 저장한다.
-- 서버는 내용을 해석하지 않고 그대로 저장/반환만 한다.
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 어르신이 직접 발급한 6자리 연결번호. 평문은 저장하지 않고 해시와 만료 시각만 보관한다.
CREATE TABLE IF NOT EXISTS guardian_pair_codes (
  senior_user_id INTEGER PRIMARY KEY REFERENCES users(id),
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failed_attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 보호자별 연결 세션. 보호자 토큰 역시 평문 대신 SHA-256 해시로 저장한다.
CREATE TABLE IF NOT EXISTS guardian_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  senior_user_id INTEGER NOT NULL REFERENCES users(id),
  guardian_user_id INTEGER REFERENCES users(id),
  guardian_name TEXT DEFAULT '',
  guardian_phone TEXT DEFAULT '',
  token_hash TEXT UNIQUE NOT NULL,
  notification_enabled INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  UNIQUE(senior_user_id, guardian_phone)
);

-- 같은 어르신에게 여러 보호자가 연결될 수 있으므로 읽음 상태는 연결별로 분리한다.
CREATE TABLE IF NOT EXISTS guardian_message_reads (
  link_id INTEGER NOT NULL REFERENCES guardian_links(id),
  message_id TEXT NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(link_id, message_id)
);
