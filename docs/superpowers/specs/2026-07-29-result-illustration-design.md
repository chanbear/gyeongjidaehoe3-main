# 분석 결과 일러스트 생성 — 설계

## 배경

문서/문자 분석 결과 화면(`screen-result-doc`, `screen-result-text`)은 현재 텍스트(`headline`/`summary`/`checklist`)만 보여준다. 사용자는 "핵심 분석 결과는 그림으로도 보여줬으면 좋겠다"고 요청했다 — 텍스트는 중요 사항만 짧게 유지하고, 메인 분석 결과를 시각적으로(일러스트) 함께 보여달라는 것.

Claude/Anthropic API는 이미지 생성 기능이 없으므로(비전 입력만 지원, 생성은 불가), 사용자는 OpenAI Images API(`gpt-image-1`)를 새로 연동하기로 결정했다.

## 범위

- 적용 화면: `screen-result-doc`(문서 분석), `screen-result-text`(문자 분석) 둘 다.
- 일러스트 내용: "해야 할 행동"을 보여주는 장면(예: 병원에서 건강검진 받는 모습) — 상태/위험도를 상징적으로 표현하는 방식은 채택하지 않음.
- 로딩 방식: 텍스트 분석과 일러스트 생성을 **같은 요청 안에서 순차 처리**해 한 번에 함께 반환한다(2단계 비동기 로딩 없음).
- 이번 스코프에 포함하지 않는 것: 과거 기록 재조회 시 일러스트 재사용/캐싱(D1 저장 등) — 매 요청마다 새로 생성한다. 배포(`npm run deploy`)도 이번 작업 범위에 포함하지 않는다 — 사용자가 완료 후 직접 배포한다.

## 아키텍처

```
사용자 사진/문자 → Worker(/analyze-doc, /analyze-text)
   1. Claude 호출 → {status, headline, summary, checklist, ...} 획득
   2. (성공 시) headline + checklist[0]로 영어 프롬프트 조립
   3. OpenAI Images API(gpt-image-1) 호출 → b64_json
   4. 응답 JSON에 illustration: "data:image/png;base64,..." 추가 (실패 시 null)
   → 프런트엔드가 텍스트 + 일러스트를 함께 렌더링
```

## Worker 변경 (`worker/src/index.js`)

- 새 시크릿 `OPENAI_API_KEY`를 사용(코드에 하드코딩하지 않음, `wrangler secret put`으로 등록 — 이 스펙에서는 코드만 준비하고 실제 secret 등록/배포는 사용자가 진행).
- Claude 분석이 성공한 뒤(`status`가 나온 뒤) 이미지 생성 단계를 별도 `try/catch`로 감싸 실행 — 이미지 생성 실패가 전체 분석 응답 실패로 이어지지 않도록 한다.
- 프롬프트 조립 규칙:
  - 기본 틀: "Warm, simple flat illustration of an elderly Korean person {행동 설명}, friendly accessible style, soft warm colors, no text or letters in the image."
  - `{행동 설명}`은 `checklist[0]`이 있으면 그 문장을, 없으면 `headline`을 기반으로 Claude 응답에 이미 포함된 한국어 문장을 영어로 풀어쓰지 않고 **Claude에게 이미지 프롬프트용 짧은 영어 설명(`illustrationPrompt` 같은 별도 필드)을 함께 생성하도록 스키마에 추가**해 재사용한다 — 별도 번역 호출 없이 한 번의 Claude 요청으로 텍스트 분석과 이미지 프롬프트를 동시에 받는다.
  - "no text or letters in the image"를 항상 포함해 이미지 안에 깨진 글자가 나오는 것을 방지.
- OpenAI 요청: `POST https://api.openai.com/v1/images/generations`, `model: "gpt-image-1"`, `size: "1024x1024"`, `quality: "medium"`, `response_format`은 gpt-image-1 기본값(b64_json)을 사용.
- 응답 필드 추가: 기존 `{status, headline, summary, checklist, ...}`에 `illustration`(성공 시 data URI 문자열, 실패/키 없음 시 `null`) 필드를 추가. `/analyze-doc`, `/analyze-text` 양쪽 다 동일하게 처리.
- 이미지 생성이 실패하거나 `OPENAI_API_KEY`가 설정되지 않은 경우: 콘솔에 로그만 남기고 `illustration: null`을 반환 — 사용자에게 에러를 보여주지 않는다(문서 분석 자체는 정상 완료).

## Claude 스키마 변경

`worker/src/index.js`의 JSON 스키마(`headline`/`summary`/`checklist`/... 옆)에 `illustrationPrompt: { type: 'string' }`을 추가하고 `required`에도 넣는다. 프롬프트 지시문에 다음을 추가:
> `illustrationPrompt`: 이 문서/문자에 대해 사용자가 취해야 할 핵심 행동을 그림으로 표현하기 위한 영어 한 문장 설명 (예: "an elderly person visiting a hospital reception desk"). 실제 인물/기관을 특정하지 말고 일반적인 장면으로 묘사할 것.

## 프런트엔드 변경 (`index.html` + `www/index.html`, `js/script.js` + `www/js/script.js`)

- `screen-result-doc`, `screen-result-text`의 배지/headline 카드 아래·"해야 할 일" 체크리스트 위에 일러스트 카드 섹션을 추가 (`<div class="illustration-card" id="docIllustration" style="display:none;"><img id="docIllustrationImg" alt=""></div>` 형태, 문자 결과 화면엔 `sms` 접두사로 별도 id).
- `renderDocResult()` / `renderSmsResult()` (또는 해당 결과 렌더 함수)에서 `lastDocAnalysis.illustration` / `lastSmsAnalysis.illustration`이 있으면 `src`에 채우고 카드를 보여주고, 없으면 카드를 숨긴다 — 기존 "지오코딩 실패 시 지도 숨김"과 동일한 원칙.
- 로딩 화면(`screen-loading-doc`, `screen-loading-text`)의 안내 문구·`data-voice`에 "그림도 함께 준비 중이에요" 같은 문구를 추가해 기존보다 길어진 대기 시간을 안내한다. `progressMap`의 `fillId`/타이밍은 그대로 두되(실제 완료는 fetch 응답 도착 시점이므로), 텍스트만 조정.
- CSS(`css/styles.css` + `www/css/styles.css`)에 `.illustration-card` 스타일(카드 배경, 라운드, 이미지 `max-width:100%`) 추가.

## 에러 처리 원칙

- OpenAI 키 미설정/호출 실패/타임아웃 → `illustration: null`, 문서·문자 분석 자체는 정상 진행 (CLAUDE.md 5번 규칙: 실패를 성공처럼 위장하지 않되, 이건 보조 기능이므로 "일러스트 없음"이 곧 정직한 실패 표시).
- 이미지 생성 실패를 사용자에게 별도 토스트/에러로 알리지 않는다(문서 분석 자체엔 영향 없으므로 조용히 숨김) — 지도 렌더링 실패 패턴과 동일.

## 확인 조건 (완료 기준)

- 루트와 `www/` 양쪽에 동일하게 반영됨.
- 브라우저에서 `wrangler dev`로 로컬 실행 후 실제 사진/문자로 분석 요청 시 콘솔 에러 없이 일러스트 카드가 뜨거나(키 있을 때) 조용히 숨겨짐(키 없을 때)을 확인.
- `OPENAI_API_KEY` 시크릿 등록과 `npm run deploy`는 사용자가 직접 진행 — Claude Code는 배포하지 않는다.
