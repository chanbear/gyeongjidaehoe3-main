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
