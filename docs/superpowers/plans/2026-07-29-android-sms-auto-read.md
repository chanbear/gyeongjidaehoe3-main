# 안드로이드 문자(SMS) 자동 읽기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 문자 확인 흐름에서 복사/붙여넣기를 없애고, 기기의 최근 수신 문자 30건을 앱 안에서 바로 보여줘 골라서 분석할 수 있게 한다.

**Architecture:** 새 Capacitor 네이티브 플러그인(`SmsReaderPlugin`)이 `READ_SMS` 권한과 `Telephony.Sms.Inbox` 조회를 담당하고, 프런트엔드는 그 결과를 새 화면(`screen-sms-recent`, `screen-sms-permission-needed`)에 렌더링한 뒤 기존 `analyzeSmsText()` 파이프라인으로 그대로 넘긴다. 기존 복사/붙여넣기 화면 5개와 관련 함수·번역 키를 제거한다.

**Tech Stack:** Capacitor 8 (Android), 순수 HTML/CSS/JS (프런트), Java (네이티브 플러그인). 자동화 테스트 프레임워크가 없는 프로젝트라 각 태스크의 "테스트"는 `node -c` 문법 검사, `grep` 기반 참조 무결성 확인, 브라우저 `javascript_tool` 콘솔 검증, `gradlew assembleDebug` 빌드 성공으로 대체한다.

## Global Constraints

- 이 기능은 **경진대회 심사용 APK 전용**이다. Google Play 정책상 `READ_SMS`는 기본 문자 앱만 쓸 수 있어 스토어 배포는 고려하지 않는다 — 코드에 이 제약을 주석으로 남긴다.
- 웹 브라우저·iOS 등 플러그인이 없는 환경에서는 **복사/붙여넣기로 폴백하지 않는다.** `screen-sms-permission-needed`만 보여주고 중단한다.
- 루트(`index.html`/`js/script.js`)를 고치면 `www/` 아래 동일 경로도 반드시 같이 고친다 (CLAUDE.md 작업 규칙).
- AI가 만든 텍스트(분석 결과)는 그대로 유지하고, 새로 추가하는 화면 문구는 기존 5개 언어(ko/zh/vi/th/uz) 모두에 추가한다.
- 새 스크린은 `data-voice` 등록을 빠뜨리지 않는다.

---

## 파일 구조

**생성**
- `android/app/src/main/java/com/ondam/app/SmsReaderPlugin.java`

**수정**
- `android/app/src/main/AndroidManifest.xml` — `READ_SMS` 권한 추가
- `android/app/src/main/java/com/ondam/app/MainActivity.java` — 플러그인 등록
- `index.html` — 새 화면 2개 추가, 기존 화면 5개 제거, 진입점 3곳 수정
- `js/script.js` — 플러그인 헬퍼·엔트리 함수·목록 렌더링, 코치마크 엔진 일반화 및 단계 재정의, 5개 언어 번역 추가/제거
- `www/index.html`, `www/js/script.js` — 위 두 파일과 동일하게 동기화(마지막 태스크에서 `cp`)

각 화면·함수는 아래 태스크에서 어느 파일의 몇 번째 줄인지 정확히 표시한다. **줄 번호는 이 계획을 처음 작성한 시점 기준이며, 앞 태스크를 실행하면서 파일이 바뀌면 뒤 태스크의 줄 번호는 달라질 수 있으니 각 스텝의 Edit은 줄 번호가 아니라 함께 제시된 `old_string`(고유한 코드 조각)으로 위치를 찾아 적용한다.**

---

## Task 1: 네이티브 플러그인 `SmsReaderPlugin` 추가

**Files:**
- Create: `android/app/src/main/java/com/ondam/app/SmsReaderPlugin.java`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/com/ondam/app/MainActivity.java`

**Interfaces:**
- Produces: JS에서 `window.Capacitor.Plugins.SmsReader` 로 접근 가능한 플러그인. 메서드:
  - `checkPermissions()` → `Promise<{ sms: 'granted'|'denied'|'prompt'|'prompt-with-rationale' }>` (Capacitor 기본 제공, 별도 구현 불필요)
  - `requestPermissions()` → 위와 동일한 shape (Capacitor 기본 제공)
  - `getRecentMessages({ limit?: number })` → `Promise<{ messages: Array<{ id: string, address: string, body: string, date: number }> }>`
  - `openAppSettings()` → `Promise<void>`

- [ ] **Step 1: `AndroidManifest.xml`에 권한 추가**

`android/app/src/main/AndroidManifest.xml`에서 기존 권한 블록:

```xml
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

을 아래로 교체:

```xml
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <!-- 경진대회 심사용 APK 전용 기능: 문자 확인 시 복사/붙여넣기 없이 최근 문자를 바로 읽어온다.
         Google Play 정책상 READ_SMS는 기본 문자 앱만 요청할 수 있어 스토어 출시 앱에는 넣지 않는다. -->
    <uses-permission android:name="android.permission.READ_SMS" />
```

- [ ] **Step 2: `SmsReaderPlugin.java` 작성**

`android/app/src/main/java/com/ondam/app/SmsReaderPlugin.java` 새로 생성:

```java
package com.ondam.app;

import android.Manifest;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Settings;
import android.provider.Telephony;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 문자 수신함을 읽어와 복사/붙여넣기 없이 바로 확인할 수 있게 해주는 플러그인.
 * READ_SMS 권한이 필요하며, 이 권한은 Google Play 정책상 기본 문자 앱만 쓸 수 있어
 * 경진대회 심사용 APK에서만 사용한다(스토어 출시 앱에는 넣지 않음).
 * checkPermissions()/requestPermissions()는 Capacitor의 Plugin 기본 클래스가
 * 아래 @Permission 선언을 보고 자동으로 구현해준다 — 따로 오버라이드하지 않는다.
 */
@CapacitorPlugin(
    name = "SmsReader",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_SMS }, alias = "sms")
    }
)
public class SmsReaderPlugin extends Plugin {

    @PluginMethod
    public void getRecentMessages(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("READ_SMS permission not granted");
            return;
        }
        int limit = call.getInt("limit", 30);
        JSArray messages = new JSArray();
        Cursor cursor = getContext().getContentResolver().query(
            Telephony.Sms.Inbox.CONTENT_URI,
            new String[] {
                Telephony.Sms.Inbox._ID,
                Telephony.Sms.Inbox.ADDRESS,
                Telephony.Sms.Inbox.BODY,
                Telephony.Sms.Inbox.DATE
            },
            null, null,
            Telephony.Sms.Inbox.DATE + " DESC"
        );
        if (cursor != null) {
            try {
                int count = 0;
                while (cursor.moveToNext() && count < limit) {
                    JSObject msg = new JSObject();
                    msg.put("id", cursor.getString(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox._ID)));
                    msg.put("address", cursor.getString(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox.ADDRESS)));
                    msg.put("body", cursor.getString(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox.BODY)));
                    msg.put("date", cursor.getLong(cursor.getColumnIndexOrThrow(Telephony.Sms.Inbox.DATE)));
                    messages.put(msg);
                    count++;
                }
            } finally {
                cursor.close();
            }
        }
        JSObject result = new JSObject();
        result.put("messages", messages);
        call.resolve(result);
    }

    /** 한 번 거부 후 "다시 묻지 않음"까지 선택하면 시스템 권한 다이얼로그가 다시 뜨지 않는
     *  Android 정책 때문에 필요 — 사용자가 직접 앱 설정에서 권한을 켜도록 안내한다. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
```

- [ ] **Step 3: `MainActivity.java`에 플러그인 등록**

`android/app/src/main/java/com/ondam/app/MainActivity.java`에서:

```java
        registerPlugin(MessagingLauncherPlugin.class);
```

을 아래로 교체:

```java
        registerPlugin(MessagingLauncherPlugin.class);
        registerPlugin(SmsReaderPlugin.class);
```

- [ ] **Step 4: 빌드로 검증**

자동화 테스트가 없는 프로젝트이므로 컴파일 성공 여부로 검증한다.

Run: `cd android && ./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL` (기존 프로젝트에 이미 있던 `MessagingLauncherPlugin.java`와 같은 패턴이라 컴파일 실패 시 import 경로나 어노테이션 오타를 먼저 의심할 것)

- [ ] **Step 5: 커밋**

```bash
git add android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/ondam/app/SmsReaderPlugin.java android/app/src/main/java/com/ondam/app/MainActivity.java
git commit -m "안드로이드 문자 읽기 네이티브 플러그인(SmsReaderPlugin) 추가"
```

---

## Task 2: 권한 확인/요청 흐름 + `screen-sms-permission-needed` 화면

**Files:**
- Modify: `index.html`
- Modify: `js/script.js`

**Interfaces:**
- Consumes: Task 1의 `window.Capacitor.Plugins.SmsReader` (`checkPermissions`, `requestPermissions`, `openAppSettings`)
- Produces: `getSmsReaderPlugin()` (null-safe 헬퍼), `openSmsCheck()` (문자 확인 엔트리 포인트 — 이후 태스크에서 doc-choice 카드가 이 함수를 호출), `showSmsPermissionNeeded(reason)` (`reason`: `'denied' | 'unsupported'`)

- [ ] **Step 1: `screen-sms-permission-needed` 화면 마크업 추가**

`index.html`에서 `screen-sms-phone` 섹션 시작 부분(교체 대상은 Task 4에서 통째로 다루지만, 지금은 그 바로 앞에 새 섹션만 삽입한다):

```html
      <section class="screen" id="screen-sms-phone" data-voice="문자 앱을 눌러주세요." data-voice-i18n="sms.phoneVoice">
```

바로 위에 아래를 삽입:

```html
      <!-- 실사용: 문자 읽기 권한이 없거나(거부/미지원) 요청 중일 때 -->
      <section class="screen" id="screen-sms-permission-needed" data-voice="문자 확인을 하려면 문자 읽기 권한이 필요해요." data-voice-i18n="sms.permission.voice">
        <div class="topbar"><button class="nav-btn" onclick="goTo('screen-home')" data-i18n="common.home">← 홈으로</button><span></span></div>
        <div class="center-col">
          <div class="icon-circle">
            <svg viewBox="0 0 24 24" fill="none" stroke="#2454e6" stroke-width="2" width="40" height="40"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01" stroke-linecap="round" stroke-width="2.4"/></svg>
          </div>
          <h1 id="smsPermissionTitle" data-i18n="sms.permission.title">문자 확인을 하려면<br>문자 읽기 권한이 필요해요.</h1>
          <p class="desc" id="smsPermissionDesc" data-i18n="sms.permission.desc">확인을 누른 문자만 서버로 보내 분석해요.<br>다른 문자는 읽지 않아요.</p>
        </div>
        <button class="primary-btn" id="smsPermissionRetryBtn" onclick="openSmsCheck()" data-i18n="sms.permission.retry">다시 시도</button>
        <button class="secondary-btn" id="smsPermissionSettingsBtn" style="margin-top:12px;" onclick="openSmsAppSettings()" data-i18n="sms.permission.openSettings">앱 설정에서 허용하기</button>
      </section>

```

- [ ] **Step 2: JS 헬퍼와 엔트리 함수 추가**

`js/script.js`에서 `openRealSmsApp` 함수 시작 줄:

```js
function openRealSmsApp(){
```

바로 위에 아래를 삽입:

```js
function getSmsReaderPlugin(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SmsReader) || null;
}

/** 문자 확인 화면 진입점. 권한이 있으면 바로 목록을 보여주고, 없으면 요청하거나
 *  (플러그인 자체가 없는 웹/iOS라면) 권한 필요 화면으로 보낸다. 복사/붙여넣기로는 폴백하지 않는다. */
async function openSmsCheck(){
  const SmsReader = getSmsReaderPlugin();
  if (!SmsReader) { showSmsPermissionNeeded('unsupported'); return; }
  try {
    const status = await SmsReader.checkPermissions();
    if (status.sms === 'granted') { await loadAndShowRecentSms(SmsReader); return; }
    const requested = await SmsReader.requestPermissions();
    if (requested.sms === 'granted') { await loadAndShowRecentSms(SmsReader); return; }
    showSmsPermissionNeeded('denied');
  } catch (err) {
    showSmsPermissionNeeded('denied');
  }
}

function showSmsPermissionNeeded(reason){
  const isUnsupported = reason === 'unsupported';
  document.getElementById('smsPermissionTitle').textContent = isUnsupported
    ? t('sms.permission.unsupportedTitle')
    : t('sms.permission.title');
  document.getElementById('smsPermissionDesc').textContent = isUnsupported
    ? t('sms.permission.unsupportedDesc')
    : t('sms.permission.desc');
  document.getElementById('smsPermissionSettingsBtn').style.display = isUnsupported ? 'none' : '';
  goTo('screen-sms-permission-needed');
}

function openSmsAppSettings(){
  const SmsReader = getSmsReaderPlugin();
  if (SmsReader) SmsReader.openAppSettings();
}

```

- [ ] **Step 3: `data-i18n`용 번역 키 5개 언어에 추가**

`js/script.js`의 각 언어 블록에서 (한 번에 5곳, 아래는 `ko:` 블록 예시 — `zh`/`vi`/`th`/`uz` 블록에도 같은 키로 각 언어 번역을 넣는다):

`ko:` 블록(1958번째 줄 부근) 안의 아무 곳에나 추가:
```js
    'sms.permission.voice': '문자 확인을 하려면 문자 읽기 권한이 필요해요.',
    'sms.permission.title': '문자 확인을 하려면<br>문자 읽기 권한이 필요해요.',
    'sms.permission.desc': '확인을 누른 문자만 서버로 보내 분석해요.<br>다른 문자는 읽지 않아요.',
    'sms.permission.unsupportedTitle': '이 기능은<br>안드로이드 앱에서만 사용할 수 있어요.',
    'sms.permission.unsupportedDesc': '이 기기·브라우저에서는<br>문자를 직접 불러올 수 없어요.',
    'sms.permission.retry': '다시 시도',
    'sms.permission.openSettings': '앱 설정에서 허용하기',
```

`zh:` 블록(2157번째 줄 부근):
```js
    'sms.permission.voice': '要确认短信，需要短信读取权限。',
    'sms.permission.title': '要确认短信，<br>需要短信读取权限。',
    'sms.permission.desc': '只会把您点击确认的短信发送到服务器分析。<br>不会读取其他短信。',
    'sms.permission.unsupportedTitle': '此功能<br>仅支持安卓应用。',
    'sms.permission.unsupportedDesc': '此设备/浏览器<br>无法直接读取短信。',
    'sms.permission.retry': '重试',
    'sms.permission.openSettings': '在应用设置中允许',
```

`vi:` 블록(2353번째 줄 부근):
```js
    'sms.permission.voice': 'Để kiểm tra tin nhắn, cần quyền đọc tin nhắn.',
    'sms.permission.title': 'Để kiểm tra tin nhắn,<br>cần quyền đọc tin nhắn.',
    'sms.permission.desc': 'Chỉ tin nhắn bạn nhấn xác nhận mới được gửi đến máy chủ để phân tích.<br>Các tin nhắn khác sẽ không được đọc.',
    'sms.permission.unsupportedTitle': 'Tính năng này<br>chỉ dùng được trên ứng dụng Android.',
    'sms.permission.unsupportedDesc': 'Thiết bị/trình duyệt này<br>không thể đọc tin nhắn trực tiếp.',
    'sms.permission.retry': 'Thử lại',
    'sms.permission.openSettings': 'Cho phép trong Cài đặt ứng dụng',
```

`th:` 블록(2549번째 줄 부근):
```js
    'sms.permission.voice': 'การตรวจสอบข้อความต้องได้รับสิทธิ์อ่านข้อความ',
    'sms.permission.title': 'การตรวจสอบข้อความ<br>ต้องได้รับสิทธิ์อ่านข้อความ',
    'sms.permission.desc': 'จะส่งเฉพาะข้อความที่คุณกดยืนยันไปวิเคราะห์ที่เซิร์ฟเวอร์เท่านั้น<br>จะไม่อ่านข้อความอื่น',
    'sms.permission.unsupportedTitle': 'ฟีเจอร์นี้<br>ใช้ได้เฉพาะแอปแอนดรอยด์เท่านั้น',
    'sms.permission.unsupportedDesc': 'อุปกรณ์/เบราว์เซอร์นี้<br>ไม่สามารถอ่านข้อความโดยตรงได้',
    'sms.permission.retry': 'ลองอีกครั้ง',
    'sms.permission.openSettings': 'อนุญาตในการตั้งค่าแอป',
```

`uz:` 블록(2745번째 줄 부근):
```js
    'sms.permission.voice': "Xabarni tekshirish uchun xabar o'qish ruxsati kerak.",
    'sms.permission.title': "Xabarni tekshirish uchun<br>xabar o'qish ruxsati kerak.",
    'sms.permission.desc': "Faqat siz tasdiqlagan xabar serverga yuborilib tahlil qilinadi.<br>Boshqa xabarlar o'qilmaydi.",
    'sms.permission.unsupportedTitle': "Bu funksiya<br>faqat Android ilovada ishlaydi.",
    'sms.permission.unsupportedDesc': "Bu qurilma/brauzerda<br>xabarlarni to'g'ridan-to'g'ri o'qib bo'lmaydi.",
    'sms.permission.retry': 'Qayta urinish',
    'sms.permission.openSettings': "Ilova sozlamalarida ruxsat berish",
```

- [ ] **Step 4: 브라우저에서 폴백 경로 검증** (플러그인이 없는 환경 = 지금 브라우저 테스트 그대로)

로컬 서버로 `index.html`을 열고 콘솔에서:

```js
goTo('screen-home');
openSmsCheck();
```

Expected: `screen-sms-permission-needed` 화면으로 이동하고, 제목이 "이 기능은 안드로이드 앱에서만 사용할 수 있어요."(unsupported 문구)로 보이고 "앱 설정에서 허용하기" 버튼은 숨겨져 있어야 한다.

```js
document.getElementById('smsPermissionSettingsBtn').style.display
```
Expected: `"none"`

- [ ] **Step 5: 문법 검사 + 커밋**

Run: `node -c js/script.js`
Expected: 에러 없음

```bash
git add index.html js/script.js
git commit -m "문자 읽기 권한 확인/요청 흐름과 권한 필요 안내 화면 추가"
```

---

## Task 3: `screen-sms-recent` 화면과 목록 렌더링

**Files:**
- Modify: `index.html`
- Modify: `js/script.js`

**Interfaces:**
- Consumes: Task 2의 `getSmsReaderPlugin()`, Task 1의 `getRecentMessages({limit})`, 기존 `startSmsAnalysis()`(`pendingSmsText`를 분석)
- Produces: `loadAndShowRecentSms(SmsReader)` (Task 2의 `openSmsCheck()`가 호출), `renderSmsRecentList(messages)`, `selectSmsMessage(body)`

- [ ] **Step 1: `screen-sms-recent` 화면 마크업 추가**

`index.html`에서 Task 2에서 추가한 `screen-sms-permission-needed` 섹션의 `</section>` 바로 다음 줄(=기존 `screen-sms-phone` 섹션 시작 줄) 앞에 추가:

```html
      <!-- 실사용: 최근 문자 목록에서 골라 확인 (복사/붙여넣기 없음) -->
      <section class="screen" id="screen-sms-recent" data-voice="최근 문자 목록을 가져왔어요. 확인하고 싶은 문자를 눌러주세요." data-voice-i18n="sms.recent.voice">
        <div class="topbar"><button class="nav-btn" onclick="goTo('screen-home')" data-i18n="common.home">← 홈으로</button><span></span></div>
        <h1 class="page-title" data-i18n="sms.recent.title">최근 문자</h1>
        <p class="desc" id="smsRecentCount" data-i18n="sms.recent.desc">최근 문자를 가져왔어요. 확인하고 싶은 문자를 눌러주세요.</p>
        <div class="group" id="smsRecentList" style="background:#fff;"></div>
        <div class="empty-state" id="smsRecentEmpty" style="display:none;" data-i18n="sms.recent.empty">받은 문자가 없어요.</div>
      </section>

```

- [ ] **Step 2: 목록 조회·렌더링·선택 함수 추가**

`js/script.js`에서 Task 2에서 추가한 `openSmsAppSettings` 함수 바로 다음에 추가:

```js
async function loadAndShowRecentSms(SmsReader){
  goTo('screen-sms-recent');
  document.getElementById('smsRecentCount').textContent = t('sms.recent.loading');
  try {
    const { messages } = await SmsReader.getRecentMessages({ limit: 30 });
    renderSmsRecentList(messages || []);
  } catch (err) {
    renderSmsRecentList([]);
  }
}

/** 문자 미리보기 한 줄(50자)만 보여주고, 발신번호·받은 시각은 그대로 표시한다.
 *  AI가 만든 텍스트가 아니라 기기 문자 원문이므로 XSS 방지를 위해 항상 textContent로만 채운다. */
function renderSmsRecentList(messages){
  const listEl = document.getElementById('smsRecentList');
  const emptyEl = document.getElementById('smsRecentEmpty');
  const countEl = document.getElementById('smsRecentCount');
  listEl.innerHTML = '';
  if (messages.length === 0) {
    countEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  countEl.style.display = '';
  countEl.textContent = t('sms.recent.desc');
  emptyEl.style.display = 'none';
  messages.forEach((msg) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.onclick = () => selectSmsMessage(msg.body);

    const iconChip = document.createElement('div');
    iconChip.className = 'icon-chip accent';
    iconChip.innerHTML = '<svg viewBox="0 0 24 24"><use href="#ic-chat"></use></svg>';

    const text = document.createElement('div');
    text.className = 'text';
    const t1 = document.createElement('div');
    t1.className = 't1';
    t1.textContent = msg.address || t('sms.recent.unknownSender');
    const t2 = document.createElement('div');
    t2.className = 't2';
    const preview = (msg.body || '').replace(/\s+/g, ' ').trim();
    t2.textContent = preview.length > 50 ? preview.slice(0, 50) + '…' : preview;
    text.appendChild(t1);
    text.appendChild(t2);

    row.appendChild(iconChip);
    row.appendChild(text);
    listEl.appendChild(row);
  });
}

function selectSmsMessage(body){
  pendingSmsText = body;
  startSmsAnalysis();
}

```

- [ ] **Step 3: 브라우저에서 가짜 플러그인으로 렌더링 검증**

로컬 서버로 열고 콘솔에서 가짜 `SmsReader`를 흉내내 확인:

```js
renderSmsRecentList([
  { id: '1', address: '01012345678', body: '건강검진비 환급 대상입니다. bit.ly/hcheck-refund', date: Date.now() },
  { id: '2', address: '15881577', body: '택배가 도착했습니다', date: Date.now() }
]);
document.querySelectorAll('#smsRecentList .row').length
```
Expected: `2`

```js
document.getElementById('smsRecentEmpty').style.display
```
Expected: `"none"`

빈 목록도 확인:
```js
renderSmsRecentList([]);
document.getElementById('smsRecentEmpty').style.display
```
Expected: `"block"`

행 탭 검증(실제 분석 API 호출 없이 흐름만 확인 — `startSmsAnalysis`를 임시로 감싸서 확인):
```js
const _orig = startSmsAnalysis;
let called = false;
startSmsAnalysis = () => { called = true; };
document.querySelector('#screen-sms-recent .row').click();
JSON.stringify({ called, pendingSmsText })
startSmsAnalysis = _orig; // 원복
```
Expected: `called: true`, `pendingSmsText`가 클릭한 행의 문자 본문과 일치

- [ ] **Step 4: 문법 검사 + 커밋**

Run: `node -c js/script.js`
Expected: 에러 없음

```bash
git add index.html js/script.js
git commit -m "최근 문자 목록 화면(screen-sms-recent) 추가"
```

---

## Task 4: 기존 복사/붙여넣기 화면·함수·번역 키 제거 + 진입점 3곳 전환

**Files:**
- Modify: `index.html`
- Modify: `js/script.js`

**Interfaces:**
- Consumes: Task 2의 `openSmsCheck()`
- Produces: 없음 (제거·전환 작업)

- [ ] **Step 1: 실사용 진입점 3곳을 `openSmsCheck()`로 전환**

`index.html`에서 아래 3곳을 각각 교체한다.

① `screen-doc-choice`의 "문자 내용 불러오기" 카드:
```html
        <div class="feature-card" onclick="goTo('screen-sms-phone')" role="button" tabindex="0">
          <div class="fc-icon soft"><svg viewBox="0 0 24 24"><use href="#ic-chat"></use></svg></div>
          <div class="fc-text"><div class="fc-title" data-i18n="docChoice.smsTitle">문자 내용 불러오기</div><div class="fc-desc" data-i18n="docChoice.smsDesc">문자 앱에서 문자를 복사해 불러옵니다</div></div>
          <svg class="chev" viewBox="0 0 24 24"><use href="#ic-chevron"></use></svg>
        </div>
```
→
```html
        <div class="feature-card" onclick="openSmsCheck()" role="button" tabindex="0">
          <div class="fc-icon soft"><svg viewBox="0 0 24 24"><use href="#ic-chat"></use></svg></div>
          <div class="fc-text"><div class="fc-title" data-i18n="docChoice.smsTitle">문자 내용 불러오기</div><div class="fc-desc" data-i18n="docChoice.smsDesc">최근 받은 문자 중에서 골라 확인합니다</div></div>
          <svg class="chev" viewBox="0 0 24 24"><use href="#ic-chevron"></use></svg>
        </div>
```

② `screen-result-text`의 "다른 문자 확인하기" 버튼:
```html
        <button class="secondary-btn" style="margin-top:10px;" onclick="goTo('screen-sms-phone')"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-chat"></use></svg><span data-i18n="result.checkAnotherSms">다른 문자 확인하기</span></button>
```
→
```html
        <button class="secondary-btn" style="margin-top:10px;" onclick="openSmsCheck()"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-chat"></use></svg><span data-i18n="result.checkAnotherSms">다른 문자 확인하기</span></button>
```

③ `screen-help-sms`(설정 → 사용 방법 안내) 전체를 새 방식 설명으로 교체:
```html
      <section class="screen" id="screen-help-sms" data-voice="홈 화면에서 문자 내용 요약을 누르고, 문자 앱에서 실제 문자를 복사해 붙여넣으면 AI가 안전한지 확인해드려요.">
        <div class="topbar"><button class="nav-btn" onclick="goTo('screen-help')">← 뒤로</button><span></span></div>
        <h1 class="page-title"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-chat"></use></svg>문자 확인 방법</h1>
        <div class="todo-list">
          <div class="checklist-row"><label style="cursor:default;">홈 화면에서 "문자 내용 요약" 카드를 누르세요</label></div>
          <div class="checklist-row"><label style="cursor:default;">문자 앱을 열어 확인하고 싶은 문자를 길게 눌러 복사하세요</label></div>
          <div class="checklist-row"><label style="cursor:default;">다시 이 앱으로 돌아와 복사한 문자를 붙여넣으세요</label></div>
          <div class="checklist-row"><label style="cursor:default;">AI가 안전한 문자인지, 위험한 문자인지 알려드려요</label></div>
        </div>
        <div class="tip-card">
          <div class="tip-title"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-alert"></use></svg>이런 문자는 특히 조심하세요</div>
          <ul>
            <li>계좌번호, 비밀번호, 인증번호를 요구하는 문자</li>
            <li>모르는 링크(주소)를 눌러보라는 문자</li>
            <li>"위험 감지" 표시가 뜨면 절대 응답하지 말고 118로 신고하세요</li>
          </ul>
        </div>
        <button class="primary-btn" onclick="goTo('screen-sms-phone')">문자 확인하러 가기</button>
        <button class="secondary-btn" style="margin-top:12px;" onclick="startCoachmark(smsMiniCoachSteps)">체험해보기</button>
        <button class="secondary-btn" style="margin-top:12px;" onclick="goTo('screen-help')">다른 게 궁금해요</button>
```
→
```html
      <section class="screen" id="screen-help-sms" data-voice="홈 화면에서 문자 내용 요약을 누르면 최근 받은 문자 중에서 골라 AI가 안전한지 확인해드려요.">
        <div class="topbar"><button class="nav-btn" onclick="goTo('screen-help')">← 뒤로</button><span></span></div>
        <h1 class="page-title"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-chat"></use></svg>문자 확인 방법</h1>
        <div class="todo-list">
          <div class="checklist-row"><label style="cursor:default;">홈 화면에서 "문자 내용 요약" 카드를 누르세요</label></div>
          <div class="checklist-row"><label style="cursor:default;">최근 받은 문자 목록이 뜨면 확인하고 싶은 문자를 누르세요</label></div>
          <div class="checklist-row"><label style="cursor:default;">AI가 안전한 문자인지, 위험한 문자인지 알려드려요</label></div>
        </div>
        <div class="tip-card">
          <div class="tip-title"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-alert"></use></svg>이런 문자는 특히 조심하세요</div>
          <ul>
            <li>계좌번호, 비밀번호, 인증번호를 요구하는 문자</li>
            <li>모르는 링크(주소)를 눌러보라는 문자</li>
            <li>"위험 감지" 표시가 뜨면 절대 응답하지 말고 118로 신고하세요</li>
          </ul>
        </div>
        <button class="primary-btn" onclick="openSmsCheck()">문자 확인하러 가기</button>
        <button class="secondary-btn" style="margin-top:12px;" onclick="startCoachmark(smsMiniCoachSteps)">체험해보기</button>
        <button class="secondary-btn" style="margin-top:12px;" onclick="goTo('screen-help')">다른 게 궁금해요</button>
```

- [ ] **Step 2: 옛 화면 5개(`screen-sms-phone`~`screen-sms-filled`) 통째로 삭제**

`index.html`에서 (Task 2·3에서 추가한 새 섹션들 바로 뒤에 있는) 아래 블록 전체를 삭제한다. 시작 지점:
```html
      <section class="screen" id="screen-sms-phone" data-voice="문자 앱을 눌러주세요." data-voice-i18n="sms.phoneVoice">
```
끝 지점(이 줄 포함):
```html
      <section class="screen" id="screen-sms-filled" data-voice="문자 내용이 잘 들어왔어요. 확인 버튼을 눌러 결과를 확인해보세요." data-voice-i18n="sms.filledVoice">
        <div class="topbar"><button class="nav-btn" onclick="goTo('screen-sms-paste')" data-i18n="common.back">← 뒤로</button><button class="replay-btn" data-replay aria-label="음성 다시 듣기"><svg class="inline-icon" viewBox="0 0 24 24"><use href="#ic-speaker"></use></svg><span data-i18n="onboard.replay">다시 듣기</span></button></div>
        <h1 data-i18n="sms.filledTitle">문자 내용이<br>들어왔어요.</h1>
        <div class="compose-box filled" id="smsFilledPreview"></div>
        <button class="primary-btn" onclick="startSmsAnalysis()" data-i18n="sms.confirm">확인</button>
      </section>
```
(`screen-sms-phone`, `screen-tutorial-sms-mock`, `screen-sms-switch`, `screen-sms-paste`, `screen-text-error`, `screen-sms-filled` 여섯 섹션이 통째로 삭제 대상 — 바로 다음에 나오는 `screen-loading-text` 섹션은 그대로 남긴다.)

- [ ] **Step 3: 관련 JS 함수 삭제**

`js/script.js`에서 아래 함수 5개를 삭제한다: `openRealSmsApp`, `handleSmsAppOpen`, `tutorialHoldStart`/`tutorialHoldCancel`(과 `let tutorialHoldTimer`), `expandCoachHoleForPopup`, `tutorialCopySms`, `confirmSmsPaste`. (정확한 경계는 각 함수의 `function ... { ... }` 블록 — 앞서 Task 2에서 삽입한 `getSmsReaderPlugin`/`openSmsCheck`가 바로 이 자리를 대신한다.)

`analyzeSmsText`와 `retryAiError` 안의 `'screen-sms-paste'` 참조 3곳을 `'screen-sms-recent'`로 교체:

```js
async function analyzeSmsText(text){
  if (!navigator.onLine) { goToAiError('screen-sms-paste', true); return; }

  try {
    const res = await fetch(AI_WORKER_URL + '/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, profile: appState.profile })
    });
    const data = await res.json();
    if (!res.ok || data.error) { goToAiError('screen-sms-paste'); return; }
    lastSmsAnalysis = data;
    finishAllProgress();
    goTo('screen-result-text');
  } catch (err) {
    goToAiError('screen-sms-paste', !navigator.onLine);
  }
}
```
→
```js
async function analyzeSmsText(text){
  if (!navigator.onLine) { goToAiError('screen-sms-recent', true); return; }

  try {
    const res = await fetch(AI_WORKER_URL + '/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, profile: appState.profile })
    });
    const data = await res.json();
    if (!res.ok || data.error) { goToAiError('screen-sms-recent'); return; }
    lastSmsAnalysis = data;
    finishAllProgress();
    goTo('screen-result-text');
  } catch (err) {
    goToAiError('screen-sms-recent', !navigator.onLine);
  }
}
```

```js
  if (aiErrorRetryScreen === 'screen-sms-paste' && pendingSmsText) {
```
→
```js
  if (aiErrorRetryScreen === 'screen-sms-recent' && pendingSmsText) {
```

- [ ] **Step 4: 안 쓰는 번역 키 일괄 삭제**

아래 키들은 제거된 화면·함수에서만 쓰였으므로 5개 언어 블록 전부에서 삭제한다:
`sms.phoneVoice`, `sms.statusTime`, `sms.phoneHome`, `sms.appPhone`, `sms.appSms`, `sms.appCamera`, `sms.phoneCaption`, `sms.openSmsApp`, `sms.switchVoice`, `sms.switchTitle`, `sms.switchDesc`, `sms.switchOpenApp`, `sms.pasteVoice`, `sms.pasteTitle`, `sms.pastePlaceholder`, `sms.confirm`, `sms.filledVoice`, `sms.filledTitle`, `error.textShortVoice`, `error.textShortTitle`, `error.textShortDesc`, `error.textShortHint`, `error.pasteAgain`.

Run:
```bash
node - <<'EOF'
const fs = require('fs');
const path = 'js/script.js';
let src = fs.readFileSync(path, 'utf8');
const keys = ['sms.phoneVoice','sms.statusTime','sms.phoneHome','sms.appPhone','sms.appSms','sms.appCamera',
  'sms.phoneCaption','sms.openSmsApp','sms.switchVoice','sms.switchTitle','sms.switchDesc','sms.switchOpenApp',
  'sms.pasteVoice','sms.pasteTitle','sms.pastePlaceholder','sms.confirm','sms.filledVoice','sms.filledTitle',
  'error.textShortVoice','error.textShortTitle','error.textShortDesc','error.textShortHint','error.pasteAgain'];
const lines = src.split('\n').filter(line => !keys.some(k => line.includes(`'${k}'`)));
fs.writeFileSync(path, lines.join('\n'));
console.log('removed lines containing target keys');
EOF
```

이 스크립트는 각 키가 통째로 자기 줄을 차지하고 있다고 가정한다(현재 파일이 그렇게 되어 있음). 실행 후 `git diff js/script.js`로 의도한 줄만 지워졌는지 반드시 눈으로 확인할 것 — 다른 키와 한 줄에 같이 있는 경우가 있으면 그 줄 전체가 지워지지 않도록 수동으로 바로잡는다.

- [ ] **Step 5: 참조 무결성 확인**

Run:
```bash
grep -n "screen-sms-phone\|screen-tutorial-sms-mock\|screen-sms-switch\|screen-sms-paste\|screen-text-error\|screen-sms-filled\|tutorialHoldStart\|tutorialCopySms\|handleSmsAppOpen\|openRealSmsApp\|confirmSmsPaste\|expandCoachHoleForPopup" index.html js/script.js
```
Expected: 결과 없음 (전부 제거됨)

Run: `node -c js/script.js`
Expected: 에러 없음

- [ ] **Step 6: 브라우저 스모크 테스트**

로컬 서버로 열고: 홈 → "AI 문서 분석하기" → "문자 내용 불러오기" 카드 클릭 → (플러그인이 없는 브라우저이므로) `screen-sms-permission-needed`로 이동하는지 확인.

- [ ] **Step 7: 커밋**

```bash
git add index.html js/script.js
git commit -m "옛 문자 복사/붙여넣기 화면·함수·번역 제거, 새 흐름으로 진입점 전환"
```

---

## Task 5: 코치마크 엔진 일반화 + 문자 확인 튜토리얼 단계 재정의

**Files:**
- Modify: `js/script.js`

**Interfaces:**
- Consumes: `fullCoachSteps`, `coachOnNavigate`, Task 3의 `#screen-sms-recent .row`
- Produces: 재정의된 `fullCoachSteps`(길이 25→21), 재계산된 미니 투어 슬라이스 7개, 2단계 lookahead가 적용된 `coachOnNavigate`

- [ ] **Step 1: `coachOnNavigate`를 2단계 lookahead로 일반화**

```js
function coachOnNavigate(id){
  if (!coachActive) return;
  const step = coachSteps[coachIndex];
  if (!step) return;
  const nextStep = coachSteps[coachIndex + 1];
  // 현재 단계와 다음 단계가 같은 화면일 수 있으므로(예: 설정 화면 안에서 이어지는 단계들), "지금 단계가 기다리는 화면"인지 먼저 확인해야
  // 이제 막 시작한 단계를 건너뛰지 않는다. 다른 화면으로 실제로 넘어갔을 때만 다음 단계로 진행한다.
  if (id === step.screen) {
    setTimeout(showCoachStep, 200);
  } else if (nextStep && id === nextStep.screen) {
    coachIndex++;
    setTimeout(showCoachStep, 200);
  } else if (!nextStep) {
    // advance 없이 마지막 단계를 벗어난 경우(예: 미니 투어에서 재사용한 단계의 원래 다음 단계가 없음): 더 기다릴 단계가 없으므로 투어를 종료한다
    stopCoachmark();
  } else {
    // ponytail: 분석 중/결과 화면처럼 성공·실패로 갈라지는 중간 화면은 그냥 지나쳐 보내고(오버레이만 숨김),
    // 다음 단계가 기다리는 화면(예: 홈)으로 실제로 돌아왔을 때 위 분기에서 자연스럽게 이어받는다
    setCoachOverlayVisible(false);
  }
}
```
→
```js
function coachOnNavigate(id){
  if (!coachActive) return;
  const step = coachSteps[coachIndex];
  if (!step) return;
  const nextStep = coachSteps[coachIndex + 1];
  const nextNextStep = coachSteps[coachIndex + 2];
  // 현재 단계와 다음 단계가 같은 화면일 수 있으므로(예: 설정 화면 안에서 이어지는 단계들), "지금 단계가 기다리는 화면"인지 먼저 확인해야
  // 이제 막 시작한 단계를 건너뛰지 않는다. 다른 화면으로 실제로 넘어갔을 때만 다음 단계로 진행한다.
  if (id === step.screen) {
    setTimeout(showCoachStep, 200);
  } else if (nextStep && id === nextStep.screen) {
    coachIndex++;
    setTimeout(showCoachStep, 200);
  } else if (nextNextStep && id === nextNextStep.screen) {
    // 조건에 따라 중간 단계가 통째로 생략될 수 있는 경우(예: 문자 읽기 권한이 이미 있어 권한 안내 화면을 안 거침) —
    // 그 단계는 건너뛰고 실제로 도착한 화면부터 바로 이어받는다
    coachIndex += 2;
    setTimeout(showCoachStep, 200);
  } else if (!nextStep) {
    // advance 없이 마지막 단계를 벗어난 경우(예: 미니 투어에서 재사용한 단계의 원래 다음 단계가 없음): 더 기다릴 단계가 없으므로 투어를 종료한다
    stopCoachmark();
  } else {
    // ponytail: 분석 중/결과 화면처럼 성공·실패로 갈라지는 중간 화면은 그냥 지나쳐 보내고(오버레이만 숨김),
    // 다음 단계가 기다리는 화면(예: 홈)으로 실제로 돌아왔을 때 위 분기에서 자연스럽게 이어받는다
    setCoachOverlayVisible(false);
  }
}
```

- [ ] **Step 2: `fullCoachSteps`의 문자 확인 구간(인덱스 3~9, 7개) 재정의**

```js
  // 문자 확인 입구가 홈에서 'AI 문서 분석하기' 화면(screen-doc-choice) 안으로 옮겨져 이 단계도 그리로 옮겼다.
  { screen: 'screen-doc-choice', target: '#screen-doc-choice .feature-card[onclick*="screen-sms-phone"]', cat: 'sms', key: 'sms1' },
  { screen: 'screen-sms-phone', target: '#screen-sms-phone .app-icon.msg', cat: 'sms', key: 'sms2' },
  { screen: 'screen-tutorial-sms-mock', target: '#screen-tutorial-sms-mock .compose-box', cat: 'sms', key: 'sms3' },
  { screen: 'screen-sms-switch', target: '#screen-sms-switch .primary-btn', cat: 'sms', key: 'sms4' },
  { screen: 'screen-sms-paste', target: '#smsPasteInput', cat: 'sms', key: 'sms5', advance: 'input' },
  { screen: 'screen-sms-paste', target: '#screen-sms-paste .primary-btn', cat: 'sms', key: 'sms6' },
  { screen: 'screen-sms-filled', target: '#screen-sms-filled .primary-btn', cat: 'sms', key: 'sms7' },
```
→
```js
  // 문자 확인 입구가 홈에서 'AI 문서 분석하기' 화면(screen-doc-choice) 안으로 옮겨져 이 단계도 그리로 옮겼다.
  // 2026-07-29: 복사/붙여넣기 대신 최근 문자 목록에서 바로 고르는 방식으로 바뀌어 7단계 → 3단계로 줄었다.
  { screen: 'screen-doc-choice', target: '#screen-doc-choice .feature-card[onclick*="screen-sms-phone"]', cat: 'sms', key: 'sms1' },
  // 권한이 이미 있으면 이 단계 자체가 통째로 건너뛰어진다(coachOnNavigate의 2단계 lookahead가 처리)
  { screen: 'screen-sms-permission-needed', target: '#smsPermissionRetryBtn', cat: 'sms', key: 'smsPermission', skippable: true },
  { screen: 'screen-sms-recent', target: '#screen-sms-recent .row:first-child', cat: 'sms', key: 'sms2' },
```

- [ ] **Step 3: 미니 투어 슬라이스 재계산**

문자 확인 구간이 7개(인덱스 3~9)에서 3개(인덱스 3~5)로 줄어 뒤의 모든 인덱스가 4씩 당겨진다.

```js
const docMiniCoachSteps = fullCoachSteps.slice(0, 3);
const smsMiniCoachSteps = fullCoachSteps.slice(3, 10);
const historyMiniCoachSteps = fullCoachSteps.slice(10, 12);
const publicInfoMiniCoachSteps = fullCoachSteps.slice(12, 14);
const welfareMiniCoachSteps = fullCoachSteps.slice(14, 16);
const voiceMiniCoachSteps = [fullCoachSteps[16]];
const emergencyMiniCoachSteps = [fullCoachSteps[17]];
const settingsLanguageMiniStep = { screen: 'screen-settings', target: '#languageGroup', cat: 'settings', key: 'language', skippable: true };
const settingsMiniCoachSteps = [fullCoachSteps[19], fullCoachSteps[20], fullCoachSteps[21], settingsLanguageMiniStep, fullCoachSteps[24]];
```
→
```js
const docMiniCoachSteps = fullCoachSteps.slice(0, 3);
const smsMiniCoachSteps = fullCoachSteps.slice(3, 6);
const historyMiniCoachSteps = fullCoachSteps.slice(6, 8);
const publicInfoMiniCoachSteps = fullCoachSteps.slice(8, 10);
const welfareMiniCoachSteps = fullCoachSteps.slice(10, 12);
const voiceMiniCoachSteps = [fullCoachSteps[12]];
const emergencyMiniCoachSteps = [fullCoachSteps[13]];
const settingsLanguageMiniStep = { screen: 'screen-settings', target: '#languageGroup', cat: 'settings', key: 'language', skippable: true };
const settingsMiniCoachSteps = [fullCoachSteps[15], fullCoachSteps[16], fullCoachSteps[17], settingsLanguageMiniStep, fullCoachSteps[20]];
```

- [ ] **Step 4: `firstRunCoachSteps`의 sms 구간 슬라이스 범위 수정**

```js
const firstRunCoachSteps = [
  ...fullCoachSteps.slice(0, 3),
  firstRunDocToSmsBridgeStep,
  ...fullCoachSteps.slice(3, 10),
  firstRunHelpStep
];
```
→
```js
const firstRunCoachSteps = [
  ...fullCoachSteps.slice(0, 3),
  firstRunDocToSmsBridgeStep,
  ...fullCoachSteps.slice(3, 6),
  firstRunHelpStep
];
```

- [ ] **Step 5: 옛 `coach.sms3`~`coach.sms7` 번역 키 삭제, `coach.sms2` 재정의, `coach.smsPermission` 신규 추가 (5개 언어)**

각 언어 블록에서 옛 `coach.sms2`~`coach.sms7` 여섯 줄을 지우고, `coach.smsPermission`(신규) + `coach.sms2`(재정의) 두 줄로 교체한다. `coach.sms1`/`coach.sms1b` 줄은 그대로 둔다.

`ko:` 블록(2072~2077번째 줄):
```js
    'coach.sms2.title': '문자 앱을 눌러보세요', 'coach.sms2.desc': '문자 앱을 열어볼게요.', 'coach.sms2.voice': '문자 앱을 눌러보세요.',
    'coach.sms3.title': '문자를 길게 눌러 복사해보세요', 'coach.sms3.desc': '실제로는 확인하고 싶은 문자를 길게 눌러 복사하면 돼요.', 'coach.sms3.voice': '문자를 길게 눌러 복사해보세요.',
    'coach.sms4.title': '다시 이 앱으로 돌아와주세요', 'coach.sms4.desc': '복사했다면 이 버튼을 눌러 앱으로 돌아오세요.', 'coach.sms4.voice': '앱 열기 버튼을 눌러주세요.',
    'coach.sms5.title': '길게 눌러 붙여넣어보세요', 'coach.sms5.desc': '이 칸을 길게 눌러 붙여넣기를 선택하세요. 화면을 빠르게 두 번 톡톡 두드리면 더 쉽게 붙여넣을 수 있어요.', 'coach.sms5.voice': '붙여넣기 칸을 눌러보세요. 빠르게 두 번 두드리면 더 쉽게 붙여넣을 수 있어요.',
    'coach.sms6.title': '확인을 눌러주세요', 'coach.sms6.desc': '붙여넣기가 끝나면 확인을 눌러주세요.', 'coach.sms6.voice': '확인 버튼을 눌러주세요.',
    'coach.sms7.title': '확인을 눌러 결과를 보세요', 'coach.sms7.desc': '이 버튼을 누르면 AI가 문자를 확인해드려요.', 'coach.sms7.voice': '확인 버튼을 눌러 결과를 확인하세요.',
```
→
```js
    'coach.smsPermission.title': '문자 읽기를 허용해주세요', 'coach.smsPermission.desc': '허용하면 최근 문자를 바로 보여드려요.', 'coach.smsPermission.voice': '허용을 눌러주세요.',
    'coach.sms2.title': '이 문자를 눌러 확인해보세요', 'coach.sms2.desc': '탭 한 번으로 바로 확인할 수 있어요.', 'coach.sms2.voice': '문자를 눌러 확인해보세요.',
```

`zh:` 블록(2268~2273번째 줄):
```js
    'coach.sms2.title': '请点击短信应用', 'coach.sms2.desc': '我们来打开短信应用。', 'coach.sms2.voice': '请点击短信应用。',
    'coach.sms3.title': '长按短信复制试试看', 'coach.sms3.desc': '实际使用时，长按想确认的短信即可复制。', 'coach.sms3.voice': '请长按短信进行复制。',
    'coach.sms4.title': '请再回到本应用', 'coach.sms4.desc': '复制完成后，请点击此按钮返回应用。', 'coach.sms4.voice': '请点击打开应用按钮。',
    'coach.sms5.title': '长按粘贴试试看', 'coach.sms5.desc': '长按此处后选择粘贴。快速点击两下屏幕可以更轻松地粘贴。', 'coach.sms5.voice': '请点击粘贴框。快速点击两下可以更轻松粘贴。',
    'coach.sms6.title': '请点击确认', 'coach.sms6.desc': '粘贴完成后请点击确认。', 'coach.sms6.voice': '请点击确认按钮。',
    'coach.sms7.title': '点击确认查看结果', 'coach.sms7.desc': '点击此按钮AI会为您确认短信。', 'coach.sms7.voice': '请点击确认按钮查看结果。',
```
→
```js
    'coach.smsPermission.title': '请允许读取短信', 'coach.smsPermission.desc': '允许后会立即显示最近的短信。', 'coach.smsPermission.voice': '请点击允许。',
    'coach.sms2.title': '点击这条短信确认', 'coach.sms2.desc': '轻触一下即可确认。', 'coach.sms2.voice': '请点击短信确认。',
```

`vi:` 블록(2464~2469번째 줄):
```js
    'coach.sms2.title': 'Hãy nhấn vào ứng dụng tin nhắn', 'coach.sms2.desc': 'Chúng ta sẽ mở ứng dụng tin nhắn.', 'coach.sms2.voice': 'Hãy nhấn vào ứng dụng tin nhắn.',
    'coach.sms3.title': 'Hãy thử nhấn giữ tin nhắn để sao chép', 'coach.sms3.desc': 'Trong thực tế, bạn nhấn giữ tin nhắn muốn kiểm tra để sao chép.', 'coach.sms3.voice': 'Hãy nhấn giữ tin nhắn để sao chép.',
    'coach.sms4.title': 'Hãy quay lại ứng dụng này', 'coach.sms4.desc': 'Sau khi sao chép, nhấn nút này để quay lại ứng dụng.', 'coach.sms4.voice': 'Hãy nhấn nút mở ứng dụng.',
    'coach.sms5.title': 'Hãy thử nhấn giữ để dán', 'coach.sms5.desc': 'Nhấn giữ ô này rồi chọn dán. Chạm nhanh hai lần vào màn hình sẽ dễ dán hơn.', 'coach.sms5.voice': 'Hãy nhấn vào ô dán. Chạm nhanh hai lần sẽ dễ dán hơn.',
    'coach.sms6.title': 'Hãy nhấn xác nhận', 'coach.sms6.desc': 'Sau khi dán xong, hãy nhấn xác nhận.', 'coach.sms6.voice': 'Hãy nhấn nút xác nhận.',
    'coach.sms7.title': 'Nhấn xác nhận để xem kết quả', 'coach.sms7.desc': 'Nhấn nút này để AI kiểm tra tin nhắn giúp bạn.', 'coach.sms7.voice': 'Hãy nhấn nút xác nhận để xem kết quả.',
```
→
```js
    'coach.smsPermission.title': 'Hãy cho phép đọc tin nhắn', 'coach.smsPermission.desc': 'Cho phép thì sẽ hiện tin nhắn gần đây ngay.', 'coach.smsPermission.voice': 'Hãy nhấn cho phép.',
    'coach.sms2.title': 'Nhấn vào tin nhắn này để kiểm tra', 'coach.sms2.desc': 'Chỉ cần chạm một lần là kiểm tra được ngay.', 'coach.sms2.voice': 'Hãy nhấn vào tin nhắn để kiểm tra.',
```

`th:` 블록(2660~2665번째 줄):
```js
    'coach.sms2.title': 'กรุณากดแอปข้อความ', 'coach.sms2.desc': 'เราจะเปิดแอปข้อความกัน', 'coach.sms2.voice': 'กรุณากดแอปข้อความ',
    'coach.sms3.title': 'ลองกดค้างที่ข้อความเพื่อคัดลอกดู', 'coach.sms3.desc': 'ในการใช้งานจริง กดค้างที่ข้อความที่ต้องการตรวจสอบเพื่อคัดลอก', 'coach.sms3.voice': 'กรุณากดค้างที่ข้อความเพื่อคัดลอก',
    'coach.sms4.title': 'กรุณากลับมาที่แอปนี้อีกครั้ง', 'coach.sms4.desc': 'เมื่อคัดลอกแล้ว กดปุ่มนี้เพื่อกลับมาที่แอป', 'coach.sms4.voice': 'กรุณากดปุ่มเปิดแอป',
    'coach.sms5.title': 'ลองกดค้างเพื่อวางดู', 'coach.sms5.desc': 'กดค้างที่ช่องนี้แล้วเลือกวาง แตะหน้าจอสองครั้งเร็วๆ จะวางได้ง่ายขึ้น', 'coach.sms5.voice': 'กรุณากดที่ช่องวาง แตะสองครั้งเร็วๆ จะวางได้ง่ายขึ้น',
    'coach.sms6.title': 'กรุณากดยืนยัน', 'coach.sms6.desc': 'เมื่อวางเสร็จแล้ว กรุณากดยืนยัน', 'coach.sms6.voice': 'กรุณากดปุ่มยืนยัน',
    'coach.sms7.title': 'กดยืนยันเพื่อดูผลลัพธ์', 'coach.sms7.desc': 'กดปุ่มนี้เพื่อให้ AI ตรวจสอบข้อความให้คุณ', 'coach.sms7.voice': 'กรุณากดปุ่มยืนยันเพื่อดูผลลัพธ์',
```
→
```js
    'coach.smsPermission.title': 'กรุณาอนุญาตให้อ่านข้อความ', 'coach.smsPermission.desc': 'หากอนุญาตจะแสดงข้อความล่าสุดทันที', 'coach.smsPermission.voice': 'กรุณากดอนุญาต',
    'coach.sms2.title': 'กดข้อความนี้เพื่อตรวจสอบ', 'coach.sms2.desc': 'แตะเพียงครั้งเดียวก็ตรวจสอบได้ทันที', 'coach.sms2.voice': 'กรุณากดข้อความเพื่อตรวจสอบ',
```

`uz:` 블록(2856~2861번째 줄):
```js
    'coach.sms2.title': 'SMS ilovasini bosing', 'coach.sms2.desc': 'SMS ilovasini ochamiz.', 'coach.sms2.voice': 'SMS ilovasini bosing.',
    'coach.sms3.title': 'SMS xabarni bosib turib nusxalab ko\'ring', 'coach.sms3.desc': "Haqiqatda tekshirmoqchi bo'lgan SMS ni bosib turib nusxalash mumkin.", 'coach.sms3.voice': 'SMS ni bosib turib nusxalang.',
    'coach.sms4.title': 'Yana shu ilovaga qaytib keling', 'coach.sms4.desc': "Nusxalagandan so'ng, shu tugmani bosib ilovaga qayting.", 'coach.sms4.voice': 'Ilovani ochish tugmasini bosing.',
    'coach.sms5.title': 'Bosib turib joylashtirib ko\'ring', 'coach.sms5.desc': 'Shu joyni bosib turib joylashtirishni tanlang. Ekranni tez ikki marta bosish osonroq joylashtiradi.', 'coach.sms5.voice': 'Joylashtirish maydonini bosing. Tez ikki marta bosish osonroq joylashtiradi.',
    'coach.sms6.title': 'Tasdiqlashni bosing', 'coach.sms6.desc': 'Joylashtirish tugagach tasdiqlashni bosing.', 'coach.sms6.voice': 'Tasdiqlash tugmasini bosing.',
    'coach.sms7.title': 'Natijani ko\'rish uchun tasdiqlashni bosing', 'coach.sms7.desc': 'Shu tugmani bosganingizda AI SMS ni tekshirib beradi.', 'coach.sms7.voice': 'Natijani ko\'rish uchun tasdiqlash tugmasini bosing.',
```
→
```js
    'coach.smsPermission.title': "Xabar o'qishga ruxsat bering", 'coach.smsPermission.desc': "Ruxsat bersangiz so'nggi xabarlar darhol ko'rsatiladi.", 'coach.smsPermission.voice': "Ruxsat berishni bosing.",
    'coach.sms2.title': 'Ushbu xabarni tekshirish uchun bosing', 'coach.sms2.desc': "Bir marta bosish bilan darhol tekshirish mumkin.", 'coach.sms2.voice': 'Xabarni tekshirish uchun bosing.',
```

- [ ] **Step 6: 코치마크 분기 동작을 콘솔에서 검증**

로컬 서버로 열고, 권한이 "이미 있는" 케이스를 흉내:
```js
coachActive = true; coachSteps = firstRunCoachSteps; coachIndex = 3; // sms1 자리
goTo('screen-sms-recent'); // 권한 확인 화면을 안 거치고 바로 도착했다고 가정
await new Promise(r => setTimeout(r, 300));
JSON.stringify({ coachIndex, overlay: getComputedStyle(document.getElementById('coachOverlay')).display })
```
Expected: `coachIndex: 5`(sms-permission을 건너뛰고 sms2로 2단계 점프), `overlay: "block"`

권한을 "처음 묻는" 케이스:
```js
coachActive = true; coachSteps = firstRunCoachSteps; coachIndex = 3;
goTo('screen-sms-permission-needed');
await new Promise(r => setTimeout(r, 300));
JSON.stringify({ coachIndex, overlay: getComputedStyle(document.getElementById('coachOverlay')).display })
```
Expected: `coachIndex: 4`(1단계만 이동), `overlay: "block"` (skippable 단계지만 실제로 도착했으니 오버레이는 보여야 함)

- [ ] **Step 7: 문법 검사 + 커밋**

Run: `node -c js/script.js`
Expected: 에러 없음

```bash
git add js/script.js
git commit -m "코치마크 엔진 2단계 lookahead로 일반화, 문자 확인 튜토리얼을 새 흐름(7→3단계)으로 재정의"
```

---

## Task 6: root → www 동기화, APK 빌드, 실기기 확인 절차 정리

**Files:**
- Modify: `www/index.html`, `www/js/script.js`

**Interfaces:** 없음(동기화·빌드 검증만)

- [ ] **Step 1: root와 www가 커밋 시점 기준으로 같은 베이스였는지 확인**

Run:
```bash
diff <(git show HEAD~5:index.html) www/index.html
diff <(git show HEAD~5:js/script.js) www/js/script.js
```
(`HEAD~5`는 Task 1~5를 커밋하기 직전 커밋 — 실행 시점의 실제 커밋 수에 맞게 조정)
Expected: 두 명령 모두 출력 없음(그 사이 www가 다른 이유로 바뀌지 않았다는 뜻)

- [ ] **Step 2: 동기화**

```bash
cp index.html www/index.html
cp js/script.js www/js/script.js
diff -q index.html www/index.html
diff -q js/script.js www/js/script.js
```
Expected: 두 `diff -q` 모두 출력 없음("동일" 의미)

- [ ] **Step 3: Capacitor sync + APK 빌드**

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
```
Expected: `BUILD SUCCESSFUL`. 산출물: `android/app/build/outputs/apk/debug/app-debug.apk`

- [ ] **Step 4: 실기기 확인 절차 (이 계획을 실행하는 사람이 반드시 수동으로 진행)**

브라우저·에뮬레이터로는 `READ_SMS` 동작 자체(실제 문자 읽기, 권한 다이얼로그, "다시 묻지 않음" 이후 설정 화면 이동)를 검증할 수 없다. Android 실기기에 이 APK를 설치해 아래를 직접 확인해야 한다:
1. 실제 문자가 있는 기기에서 "문자 내용 불러오기" → 권한 다이얼로그 → 허용 → 최근 문자 목록이 뜨는지
2. 목록에서 문자 하나를 눌러 실제 분석 결과가 나오는지
3. 권한을 거부했을 때 `screen-sms-permission-needed`로 가는지, "다시 시도"를 누르면 다시 권한을 묻는지
4. "다시 묻지 않음"까지 거부한 뒤 "앱 설정에서 허용하기"를 누르면 앱 정보 화면이 뜨는지, 거기서 권한을 켜고 돌아와 "다시 시도"하면 목록이 뜨는지
5. 설정 → 사용 방법 안내 → 문자 → 체험해보기가 새 2~3단계 흐름으로 뜨는지
6. 온보딩을 초기화하고(예: 앱 데이터 삭제 후 재설치) 첫 실행 코치마크가 문서 촬영 → (권한에 따라 분기) → 문자 확인까지 막히지 않고 이어지는지

- [ ] **Step 5: 커밋**

```bash
git add www/index.html www/js/script.js
git commit -m "www/ 를 루트 최신 문자 자동 읽기 기능과 동기화"
```
