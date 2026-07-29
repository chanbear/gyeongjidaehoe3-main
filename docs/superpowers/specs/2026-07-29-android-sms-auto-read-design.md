# 안드로이드 문자(SMS) 자동 읽기 — 설계

날짜: 2026-07-29
작성: Claude Code (브레인스토밍 세션)

## 배경

지금 문자 확인 흐름은 실제 문자 앱을 열어 사용자가 문자를 길게 눌러 복사한 뒤 앱에 붙여넣는 방식이다 (`screen-sms-phone` → `openRealSmsApp()` → `screen-sms-switch` → `screen-sms-paste` → `confirmSmsPaste()`). 사용자가 "처음에 말했던 안드로이드용 문자 인식" 기능을 요청했고, 확인 결과 이는 **문자를 수동으로 복사하지 않고 앱이 직접 읽어오는 기능(READ_SMS)** 이었다.

이 권한은 Google Play 정책상 기본 문자 앱(default SMS handler)만 요청할 수 있어 스토어 출시 앱에는 쓸 수 없지만, 이 프로젝트는 **경진대회 심사용**이라 정책 반려 위험 없이 적용 가능하다는 점을 사용자와 확인했다.

## 목표

문자 확인 진입 시, 복사/붙여넣기 없이 **기기의 최근 수신 문자 목록을 앱 안에서 바로 보여주고 골라서 분석**할 수 있게 한다.

## 결정된 사항 (브레인스토밍 질의응답)

| 질문 | 결정 |
|---|---|
| 기존 복사/붙여넣기와의 관계 | **대체한다.** 실사용 경로에서 복사/붙여넣기 화면을 없앤다 |
| 보여줄 범위 | 수신함의 **최근 30건** (발신자 구분 없이 시간순) |
| 권한 요청 시점 | 온보딩이 아니라 **"문자 내용 불러오기" 카드를 처음 누를 때** |
| 권한 거부/미지원 환경(웹 등) | 복사/붙여넣기로 폴백하지 **않는다.** 권한 필요 안내 화면만 보여주고 중단 |
| 첫 실행 코치마크 튜토리얼 | 새 방식(목록에서 선택)에 맞춰 같이 바꾼다 |

## 전체 흐름

```
screen-doc-choice "문자 내용 불러오기" 카드
        │
        ▼
  권한 확인 (SmsReaderPlugin.checkPermissions)
   ├─ 이미 허용됨 ──────────────┐
   ├─ 처음 물어봄 → 권한 요청     │
   │     ├─ 허용됨 ─────────────┤
   │     └─ 거부됨 → screen-sms-permission-needed (중단)
   └─ (웹/비-Android, 플러그인 없음) → screen-sms-permission-needed (중단)
        │
        ▼
  최근 문자 30건 조회 (SmsReaderPlugin.getRecentMessages)
        │
        ▼
  screen-sms-recent (발신번호 + 미리보기 + 시간, 탭 가능한 목록)
        │ (한 건 탭)
        ▼
  screen-loading-text → analyzeSmsText(선택한 문자 원문) → screen-result-text
```

기존 `screen-sms-phone`(휴대폰 홈 흉내) · `screen-tutorial-sms-mock`(복사 연습) · `screen-sms-switch` · `screen-sms-paste` · `screen-text-error`(너무 짧은 문자 에러)는 실사용 경로에서 제거한다. (`confirmSmsPaste`/`smsPasteInput` 등 관련 함수·엘리먼트도 함께 정리)

## 네이티브 플러그인: `SmsReaderPlugin`

위치: `android/app/src/main/java/com/ondam/app/SmsReaderPlugin.java` (기존 `MessagingLauncherPlugin`과 같은 패키지)

- **권한**: `AndroidManifest.xml`에 `<uses-permission android:name="android.permission.READ_SMS" />` 추가. Capacitor 표준 권한 시스템(`@CapacitorPlugin(permissions = {@Permission(strings = {Manifest.permission.READ_SMS}, alias = "sms")})`)을 사용해 JS에서 `checkPermissions()` / `requestPermissions()`로 다룬다.
- **메서드**: `getRecentMessages({ limit: 30 })` — `Telephony.Sms.Inbox` 컨텐트 URI를 `date DESC`로 정렬해 조회, `[{ id, address, body, date }]` 배열을 반환. 주소록 이름 조회는 하지 않고 발신 **번호만** 사용한다(연락처 권한을 추가로 요구하지 않기 위함).
- `MainActivity.java`의 `registerPlugin(...)` 목록에 추가.

### JS 헬퍼 (기존 `getGeolocationPlugin()` 패턴과 동일)

```js
function getSmsReaderPlugin(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SmsReader) || null;
}
```

플러그인이 없으면(웹 브라우저, iOS) 바로 `screen-sms-permission-needed`로 이동한다 — 이 기능은 웹 폴백이 없는 Android 전용 기능이다.

## 새 화면

### `screen-sms-recent`
- 상단 안내: "최근 문자 30건을 가져왔어요" + `data-voice`
- 목록: 기존 복지센터 목록(`.row`)과 같은 톤 — 발신번호(큰 글씨) / 미리보기 한 줄 / 받은 시각. 전체 행이 탭 가능(터치 타깃 확대, 접근성 원칙 유지)
- 빈 상태: 문자가 없으면 "받은 문자가 없어요" 안내
- 행 탭 → `screen-loading-text` → `analyzeSmsText(원문)` (기존 분석 파이프라인 그대로 재사용)

### `screen-sms-permission-needed`
- "문자 확인을 하려면 문자 읽기 권한이 필요해요" + 이유 설명(어떤 문자를 읽는지, 서버로는 분석할 때만 전송됨)
- 버튼: "다시 시도"(권한 재요청) / "앱 설정에서 허용하기"(`Intent.ACTION_APPLICATION_DETAILS_SETTINGS` — 한 번 거부 후 "다시 묻지 않음"까지 선택하면 시스템 다이얼로그가 다시 안 뜨는 Android 정책 때문에 필요)
- 안드로이드가 아닌 환경에서는 "이 기능은 안드로이드 앱에서만 사용할 수 있어요"로 문구만 다르게 표시

## 코치마크 튜토리얼 변경

기존 6단계(전화 아이콘 → 길게 눌러 복사 → 복사 완료 → 붙여넣기 → 붙여넣기 확인 → 결과 확인)를 **2단계**로 줄인다.

- **sms1** (기존과 동일): `screen-doc-choice`의 SMS 카드
- **sms2** (재정의): `screen-sms-recent`의 첫 번째 문자 행 → "이 문자를 눌러 확인해보세요"

권한이 이미 허용된 기기는 카드를 누르자마자 `screen-sms-recent`로 바로 가고, 처음 권한을 묻는 기기는 중간에 `screen-sms-permission-needed`를 거친다 — **실행마다 경로가 달라진다.**

지금 `coachOnNavigate`는 "바로 다음 한 단계"만 보고 판단하기 때문에 이런 분기가 있으면 화면 전환이 코치 단계와 어긋나 오버레이가 조용히 멈추는 문제가 생긴다(2026-07-29 QA에서 고친 "촬영 후 3단계 멈춤" 버그와 같은 유형). 이를 막기 위해 `coachOnNavigate`의 "다음 단계" 확인을 **앞으로 2단계까지 살펴보는 것으로 일반화**한다:

- 현재 화면이 `coachSteps[coachIndex+1]`뿐 아니라 `coachSteps[coachIndex+2]`의 화면과도 일치하는지 확인하고, 일치하면 그 인덱스로 바로 건너뛴다.
- 권한이 이미 있으면 `screen-sms-permission-needed` 안내 없이 바로 `sms2`로 건너뛴다.
- 권한을 처음 묻는 경우 `screen-sms-permission-needed`에서 안내 툴팁이 뜨고, 허용 후 재시도하면 자연스럽게 이어진다. 원하지 않으면 모든 코치 툴팁에 항상 있는 "튜토리얼 건너뛰기" 링크로 빠져나갈 수 있다.

`screen-sms-permission-needed`도 하나의 코치 단계로 등록해야 한다(스킵 가능 표시).

## 인덱스 참조 정리 (구현 시 필수)

`fullCoachSteps`는 다른 미니 투어(설정 → "사용 방법 안내"의 항목별 체험)가 숫자 인덱스로 잘라 쓰는 배열이다 (`smsMiniCoachSteps`, `historyMiniCoachSteps`, `publicInfoMiniCoachSteps`, `welfareMiniCoachSteps`, `voiceMiniCoachSteps`, `emergencyMiniCoachSteps`, `settingsMiniCoachSteps`). 문자 확인 구간이 7단계 → 3단계(sms1, sms-permission, sms2)로 줄어들므로, 이 배열 전체의 인덱스가 뒤로 밀린다. 구현 시 해당 슬라이스 경계를 전부 다시 계산해야 한다.

## 예외 처리 정리

- 문자가 하나도 없는 기기: 빈 상태 안내
- 한 번 거부 + "다시 묻지 않음": 시스템 다이얼로그가 다시 안 뜨므로 "앱 설정에서 허용하기"가 유일한 경로
- 번역: 새 화면 2개의 문구·음성 안내, 바뀐 코치마크 문구를 기존 5개 언어(한/중/베/태/우즈벡)에 전부 추가

## 제외한 대안

- **실시간 수신 감지(BroadcastReceiver + RECEIVE_SMS)**: 새 문자가 올 때마다 자동 알림. `RECEIVE_SMS` 권한과 백그라운드 리시버가 추가로 필요해 훨씬 복잡하고, 이번에 요청된 "최근 목록에서 선택"과는 다른 기능이라 제외. 추후 별도 기능으로 고려 가능.
- **SMS Retriever API(무권한)**: 앱 해시가 포함된 인증번호(OTP) 문자만 받을 수 있어 임의의 문자를 읽는 용도에 맞지 않아 제외.

## 영향받는 파일

- `index.html` / `www/index.html` — 새 화면 마크업, 기존 화면 제거
- `js/script.js` / `www/js/script.js` — 플러그인 헬퍼, 흐름 로직, 코치마크 엔진 일반화, 번역 5개 언어
- `android/app/src/main/AndroidManifest.xml` — `READ_SMS` 권한 추가
- `android/app/src/main/java/com/ondam/app/SmsReaderPlugin.java` — 신규
- `android/app/src/main/java/com/ondam/app/MainActivity.java` — 플러그인 등록
