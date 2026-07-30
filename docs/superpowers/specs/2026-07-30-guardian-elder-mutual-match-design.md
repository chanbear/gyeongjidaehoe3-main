# 보호자-어르신 상호 입력 연결 (Mutual Match)

## 배경

현재 보호자 연결은 한쪽 입력만으로 이루어진다: 어르신이 설정에서 보호자 이름+전화번호를 `appState.guardian`에 저장해두면, 보호자가 로그인했을 때 서버(`guardianCandidates()`, `worker/src/index.js`)가 **전체 어르신 계정을 스캔**해 그 안에 저장된 보호자 이름+전화번호가 로그인한 보호자 계정과 일치하는 어르신을 찾아 후보로 보여준다. 보호자는 어떤 어르신인지 아무것도 입력하지 않고 "예, 맞습니다"만 누른다.

문제: 보호자가 실제로 그 어르신을 지목하는 과정이 없어, 동명이인·중복 전화번호로 인한 오매칭 위험이 있다.

## 변경 사항

보호자도 연결 전에 **어르신의 이름 + 전화번호**를 입력하게 하여, 두 정보가 모두 일치할 때만("어르신이 이 보호자 정보를 저장" AND "보호자가 이 어르신 정보를 정확히 입력") 연결 후보가 나오도록 한다.

### 프런트엔드 (`guardian.html`, `js/guardian.js` — 루트/`www/` 양쪽)

- `guardianMatchCard` 안의 `guardianMatchLoading`(스피너, "연결할 어르신을 확인하고 있어요") 앞에 입력 폼 `guardianMatchLookup`을 새로 추가: 어르신 이름 입력, 어르신 전화번호 입력, "확인하기" 버튼. 기본으로 이 폼이 보이고, 스피너는 요청 중에만 보인다(`hidden` 기본값 전환).
- `bootstrapGuardian()`: 기존 연결이 없을 때(`no_guardian_link`) 곧바로 스캔하지 않고 입력 폼을 보여준다.
- "확인하기" 클릭 시 입력값을 검증(이름 비어있지 않음, 전화번호 숫자 9자리 이상)하고 `/guardian-candidates`에 `{ seniorName, seniorPhone }`으로 실어 보낸다.
- `guardianMatchEmpty`의 "다시 확인하기"는 재스캔이 아니라 입력 폼으로 돌아가게 한다(입력값 유지, 수정 가능).
- 이미 연결된 보호자(`guardian-resume` 경로)는 영향 없음 — 최초 연결 시에만 이 절차를 거친다.

### 백엔드 (`worker/src/index.js`)

- `/guardian-candidates` POST body에 `{ seniorName, seniorPhone }`를 받는다. 둘 중 하나라도 유효하지 않으면(이름 비어있음, 전화번호 9자리 미만) `400 invalid_senior_lookup`.
- `guardianCandidates()`를 변경: 전체 스캔 대신 `seniorPhone`으로 `users` 테이블에서 `role='senior'`인 계정을 정확히 한 명 조회한다.
  - 조회된 어르신의 `users.name`이 입력한 `seniorName`과 일치하지 않으면 빈 배열 반환.
  - 일치하면 기존과 동일하게 `guardianMatchesSeniorState(guardianUser, seniorState)`(그 어르신이 저장한 보호자 이름/전화번호가 지금 보호자 계정과 일치하는지)를 확인 — 실패 시 빈 배열.
  - 둘 다 통과해야 후보 1건을 반환.
- 스키마 변경 없음 — 기존 `users.name`/`users.phone` 컬럼만 사용.
- 매치 실패 사유(전화번호 미존재/이름 불일치/보호자 정보 불일치)는 구분해 노출하지 않는다 — 기존과 동일하게 뭉뚱그린 "일치하는 어르신을 찾지 못했어요" 메시지로 통일(계정 존재 여부 유출 방지, `docs/superpowers/specs/2026-07-30-account-signup-design.md`의 트레이드오프와 동일 원칙).

## 범위 밖

- 기존 `guardian_pair_codes` 테이블(6자리 연결번호 방식)은 이번 변경과 무관 — 현재 코드에서 미사용 상태 그대로 둔다.
- 이미 연결된 보호자의 재로그인(`guardian-resume`) 흐름은 변경하지 않는다.
- `/guardian-confirm-link`의 기존 검증 로직(`guardianMatchesSeniorState`)은 그대로 유지한다.

## 완료 조건

- 루트와 `www/` 양쪽의 `guardian.html`/`js/guardian.js` 모두 수정.
- `worker/src/index.js` 수정 후 `npm run dev`로 로컬 확인 후 `npm run deploy`로 배포.
- 브라우저에서 실제로 보호자 계정으로 로그인 → 어르신 이름/전화번호 입력 → 매칭 성공/실패 케이스 모두 확인.
