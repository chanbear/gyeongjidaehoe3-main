/** (더 이상 사용하지 않음) Anthropic API를 호출하던 Durable Object.
 *  Cloudflare 콜로(홍콩 등)에서 나가는 요청이 403(forbidden)으로 차단되는 문제가 있었고,
 *  locationHint로 리전을 바꿔가며(wnam/enam/weur/eeur/apac/oc) 우회를 시도했지만
 *  전 리전에서 동일하게 차단됨 — Cloudflare 데이터센터 IP 대역 자체가 막힌 것으로 판단.
 *  대신 Cloudflare 바깥의 Vercel 중계 서버(relay/)를 거쳐 호출하도록 변경했다(runAnalysis 참고).
 *  DO 클래스 삭제는 migrations 조율이 필요해 위험 부담이 있어 일단 미사용 상태로 남겨둔다. */
export class AnthropicProxy {
  async fetch(request) {
    const body = await request.text();
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': request.headers.get('x-api-key'),
        'anthropic-version': '2023-06-01',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'accept': 'application/json',
      },
      body,
    });
  }
}

// 웹 배포본(Cloudflare Pages)과 안드로이드 APK(Capacitor 기본 WebView origin)만 허용한다.
// capacitor.config.json에 별도 server 설정이 없으면 Capacitor Android는 https://localhost를 origin으로 보낸다.
const ALLOWED_ORIGINS = new Set(['https://ondam-web.pages.dev', 'https://localhost']);

function corsHeadersFor(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token, X-Guardian-Phone, X-Guardian-Token',
    'Vary': 'Origin',
  };
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['normal', 'danger', 'info'] },
    headline: { type: 'string' },
    summary: { type: 'string' },
    checklist: { type: 'array', items: { type: 'string' } },
    phone: { type: 'string' },
    website: { type: 'string' },
    mapQuery: { type: 'string' },
    // 체크리스트를 대표하는 일러스트를 그리기 위한 영어 한 문장 설명. generateIllustration()이 그대로 이미지 생성 프롬프트에 넣는다.
    illustrationPrompt: { type: 'string' },
  },
  required: ['status', 'headline', 'summary', 'checklist', 'phone', 'website', 'mapQuery', 'illustrationPrompt'],
  additionalProperties: false,
};

/** 한 문서에 대한 분석 결과. 문자 분석에는 쓰지 않는다(문자에는 금액·기한 개념이 없다).
 *  category/amount/dueDate/issuer 는 문서에서 확실히 읽히지 않으면 빈 값으로 두게 하고,
 *  프런트엔드는 값이 없으면 해당 UI를 숨긴다. */
const DOC_ONE_SCHEMA = {
  type: 'object',
  properties: {
    ...ANALYSIS_SCHEMA.properties,
    category: { type: 'string', enum: ['고지서', '안내문', '통지서', '광고', '기타'] },
    amount: { type: 'integer' },
    dueDate: { type: 'string' },
    issuer: { type: 'string' },
    pages: { type: 'array', items: { type: 'integer' } },  // 이 문서를 이루는 사진 번호(1부터)
  },
  required: [...ANALYSIS_SCHEMA.required, 'category', 'amount', 'dueDate', 'issuer', 'pages'],
  additionalProperties: false,
};

/** 사진 여러 장을 받아 문서 단위로 묶어 돌려준다.
 *  한 문서의 여러 페이지일 수도, 서로 다른 문서일 수도 있어 판단은 AI가 한다
 *  (어르신에게 "이게 한 문서인가요?"를 묻지 않기 위함). */
const DOC_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: { documents: { type: 'array', items: DOC_ONE_SCHEMA } },
  required: ['documents'],
  additionalProperties: false,
};

/** 한 번에 보낼 수 있는 사진 수. 너무 많으면 응답이 길어져 잘리고 비용도 커진다. */
const MAX_DOC_PHOTOS = 5;

const SENSITIVE_NUMBER_PLACEHOLDER = '(민감정보라 표시하지 않음)';

/** AI가 프롬프트 지침을 놓치고 주민등록번호·계좌/카드번호를 headline·summary·checklist에
 *  그대로 옮겨 적었을 경우를 코드로 강제 제거하는 안전망. 이 결과는 D1에 영구 저장되고
 *  기기 간 동기화되며 보호자 앱에도 노출되므로, 즉시 폐기되는 사진 원본과 달리 계속 남는다.
 *  전화번호(010-XXXX-XXXX=11자리)와 겹치지 않도록 계좌/카드번호 쪽은 12자리 이상만 대상으로 한다. */
function redactSensitiveNumbers(text) {
  if (typeof text !== 'string' || !text) return text;
  // 주민등록번호: 생년월일 6자리 + (선택적 대시) + 성별 구분값(1~8) + 6자리
  let out = text.replace(/\d{6}-?[1-8]\d{6}/g, SENSITIVE_NUMBER_PLACEHOLDER);
  // 계좌번호·카드번호로 볼 수 있는 긴 숫자열(대시·공백으로 나뉘어 있어도 총 12자리 이상)
  out = out.replace(/\d(?:[-\s]?\d){11,}/g, SENSITIVE_NUMBER_PLACEHOLDER);
  return out;
}

/** 분석 결과의 headline·summary·checklist에 redactSensitiveNumbers()를 적용한다.
 *  phone/website/mapQuery/category/amount/dueDate/issuer 등 구조화된 필드는 대상이 아니다. */
function redactAnalysisResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (typeof result.headline === 'string') result.headline = redactSensitiveNumbers(result.headline);
  if (typeof result.summary === 'string') result.summary = redactSensitiveNumbers(result.summary);
  if (Array.isArray(result.checklist)) result.checklist = result.checklist.map(redactSensitiveNumbers);
  return result;
}

const DOC_PROMPT = `당신은 고령자를 위한 문서 분석 도우미입니다. 사진(한 장 이상)에 찍힌 문서(공공기관 안내문, 병원 서류, 고지서 등)를 분석하세요.

먼저 사진들이 몇 개의 문서인지 판단하세요.
- 같은 문서의 여러 페이지(앞뒤, 접힌 면, 나눠 찍은 부분)라면 하나의 문서로 묶어 결과를 1개만 만드세요.
- 서로 다른 문서라면 각각 별도의 결과로 나누세요.
- 판단 근거는 기관명·문서 제목·서식·내용의 연결성입니다. 애매하면 별도 문서로 나누세요.
documents 배열에 문서마다 결과를 하나씩 담고, 각 문서의 pages 에는 그 문서를 이루는 사진 번호([사진 1] 의 1)를 넣으세요.

문서마다 다음 항목을 한국어로 작성하세요.

- status: 이 문서가 사기·개인정보 요구 등으로 위험하면 "danger", 특별한 조치 없이 참고만 하면 되는 정보성 문서면 "info", 기한 내에 예약·신청·납부 등 조치가 필요하면 "normal"
- headline: 문서의 핵심 내용을 한 문장으로, 노인이 이해하기 쉽게
- summary: 가장 중요한 핵심만 한 문장으로 짧게 (전문 용어 없이, 존댓말로). headline과 완전히 같은 문장이 되지 않도록, 문서에 적힌 구체적인 날짜·금액·장소 등 세부 정보가 있으면 한 가지만 덧붙이세요. 긴 설명은 피하세요.
- checklist: 사용자가 해야 할 구체적인 행동 목록 (없으면 빈 배열)
- phone: 문서에 실제로 적힌 문의 전화번호가 있으면 그대로, 없으면 빈 문자열 (지어내지 말 것)
- website: 문서에 실제로 적힌 공식 홈페이지 주소가 있으면 그대로, 없으면 빈 문자열 (지어내지 말 것)
- mapQuery: 방문해야 할 기관·장소명이 문서에 있으면 지도 검색에 쓸 이름(예: "국민건강보험공단 OO지사"), 없으면 빈 문자열 (지어내지 말 것)
- illustrationPrompt: checklist(해야 할 일)를 대표하는 장면을 그리기 위한 영어 한 문장. 실제 기관명·인물을 특정하지 말고 일반적인 장면으로("an elderly Korean person visiting a hospital reception desk" 처럼). checklist가 비어 있으면 headline이 설명하는 상황으로 대신 묘사. status가 "danger"면 상대에게 응답하지 않고 전화를 끊는 등 안전한 대처 장면으로.

- category: 문서 종류를 "고지서"(납부할 돈이 적힌 것), "안내문"(알림·설명), "통지서"(결정·처분 통보), "광고"(홍보물), "기타" 중 하나로
- amount: 납부해야 할 금액이 문서에 적혀 있으면 숫자만(원 단위, 콤마 없이). 금액이 없거나 확실하지 않으면 0
- dueDate: 납부·신청 기한이 적혀 있으면 "YYYY-MM-DD" 형식으로. 없거나 확실하지 않으면 빈 문자열
- issuer: 문서를 보낸 기관명이 적혀 있으면 그대로. 없으면 빈 문자열

amount·dueDate·issuer는 문서에 실제로 적힌 것만 쓰세요. 추측하거나 계산해서 채우지 말고, 조금이라도 불확실하면 0 또는 빈 문자열로 두세요.

사진이 문서가 아니거나 글자를 읽을 수 없으면 documents 에 결과를 하나만 담고 status는 "info", headline은 "사진을 다시 확인해주세요", summary에 그 이유를 설명하고 checklist는 빈 배열, phone/website/mapQuery/dueDate/issuer/illustrationPrompt도 빈 문자열, category는 "기타", amount는 0, pages 에는 문제가 된 사진 번호를 넣으세요.

개인정보 보호: 문서에 주민등록번호나 계좌번호·카드번호로 보이는 숫자가 있어도 headline·summary·checklist에는 그 번호를 그대로 옮겨 적지 마세요. 언급이 필요하면 "민감정보라 표시하지 않았어요"처럼만 안내하세요.

말투: headline·summary는 "이것은 사기입니다"처럼 단정하지 말고, "~해 보여요", "~확인해보세요"처럼 안내하는 말투로 쓰세요. status가 "danger"여도 최종 판단은 참고용이며, 확실하지 않으면 가족이나 발급 기관에 직접 확인해보시라고 안내하세요.`;

/** 사용자가 설정에서 선택 입력한 성별/연령대/지역(선택 사항). 있으면 설명 톤 참고용으로만 쓰고, 모르는 지역별 기관명·연락처·주소는 절대 지어내지 않도록 명시한다. */
function buildProfileNote(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const parts = [];
  if (profile.age) parts.push(profile.age + '세'); // 앱이 만 나이를 한 살 단위로 받으므로 "73세" 그대로 전달한다(예전에는 연령대 단위라 "70대"였다)
  if (profile.gender) parts.push(profile.gender);
  if (profile.region) parts.push(profile.region + ' 거주');
  if (parts.length === 0) return '';
  return `\n\n[참고: 사용자는 ${parts.join(' · ')} 어르신입니다. 이 정보는 설명 톤과 관련성을 참고하는 데만 사용하고, 확실하지 않은 지역별 기관명·주소·전화번호는 절대 지어내지 마세요.]`;
}

const SMS_PROMPT = `당신은 고령자를 위한 문자 메시지 분석 도우미입니다. 아래 문자 내용을 분석해서 다음 항목을 한국어로 작성하세요.

- status: 사기·피싱·개인정보나 금융정보 요구 등 위험한 문자면 "danger", 광고나 인증번호 등 참고만 하면 되는 문자면 "info", 확인·예약·참석 등 조치가 필요한 정상적인 안내 문자면 "normal"
- headline: 문자의 핵심 내용을 한 문장으로, 노인이 이해하기 쉽게
- summary: 2~3문장으로 쉬운 설명 (전문 용어 없이, 존댓말로). 위험한 문자라면 어떤 점 때문에 확인이 필요한지, 무엇을 하면 안 되는지도 포함
- checklist: 사용자가 해야 할 구체적인 행동 목록 (없으면 빈 배열)
- phone, website, mapQuery: 문자 분석에서는 사용하지 않으니 항상 빈 문자열로 답하세요
- illustrationPrompt: checklist(해야 할 일)를 대표하는 장면을 그리기 위한 영어 한 문장. 실제 인물·기관을 특정하지 말고 일반적인 장면으로. 위험한 문자라면 상대에게 응답하지 않고 전화를 끊거나 가족에게 알리는 등 안전한 대처 장면으로, checklist가 비어 있으면 headline이 설명하는 상황으로 대신 묘사.

개인정보 보호: 문자에 주민등록번호나 계좌번호·카드번호로 보이는 숫자가 있어도 headline·summary·checklist에는 그 번호를 그대로 옮겨 적지 마세요. 언급이 필요하면 "민감정보라 표시하지 않았어요"처럼만 안내하세요.

말투: headline·summary는 "이것은 사기입니다"처럼 단정하지 말고, "~해 보여요", "~확인해보세요"처럼 안내하는 말투로 쓰세요. status가 "danger"여도 최종 판단은 참고용이며, 확실하지 않으면 가족이나 발신 기관에 직접 확인해보시라고 안내하세요.`;

/* ---- 되묻기(질문하기) ----
   자유 대화가 아니라 "방금 분석한 문서·문자에 대해 되묻기"만 다룬다.
   답변 근거를 눈앞의 분석 결과로 한정해, 앱이 모르는 지역별 혜택·기관 정보를 지어내지 않도록 한다. */
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    // 분석 결과에 근거가 있으면 true, 일반 상식으로 답했으면 false (앱이 이 차이를 표시한다)
    fromDocument: { type: 'boolean' },
  },
  required: ['answer', 'fromDocument'],
  additionalProperties: false,
};

const ASK_PROMPT = `당신은 고령자를 돕는 도우미입니다. 사용자가 방금 확인한 문서(또는 문자)의 분석 결과를 보고, 사용자의 질문에 한국어로 답하세요.

규칙:
- 2~3문장으로 짧게, 존댓말로, 전문 용어 없이 답하세요.
- 아래 [분석 결과]에 있는 내용으로 답할 수 있으면 그걸 근거로 답하고 fromDocument는 true로 하세요.
- [분석 결과]에 없는 내용이면, 일반적으로 알려진 사실만 조심스럽게 answer에 담고 fromDocument는 false로 하세요.
- 확실하지 않으면 "이 문서에는 그 내용이 없어요"라고 솔직히 말하고, 어디에 문의하면 되는지 안내하세요.
- 기관명·전화번호·주소·금액·날짜는 [분석 결과]에 적힌 것만 쓰세요. 절대 지어내지 마세요.
- 돈을 보내라거나 개인정보를 알려달라는 조언은 어떤 경우에도 하지 마세요.`;

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

/** 6자리 숫자 인증번호(OTP) 생성 */
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
    return true;
  } catch (err) {
    return false;
  }
}

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

/** X-User-Id/X-Auth-Token 헤더가 is_admin=1인 유저와 일치하는지 확인한다. authenticateRequest와 같은
 *  토큰 체계를 그대로 쓰되 관리자 권한도 함께 확인한다 — 일치하면 유저 id를, 아니면 null을 반환한다. */
async function authenticateAdminRequest(env, request) {
  const userId = Number(request.headers.get('X-User-Id'));
  const token = request.headers.get('X-Auth-Token');
  if (!userId || !token) return null;
  const row = await env.ansim_doumi_db.prepare(
    `SELECT id FROM users WHERE id = ? AND token = ? AND is_admin = 1`
  ).bind(userId, token).first();
  return row ? row.id : null;
}

/** X-Guardian-Phone/X-Guardian-Token 헤더로 요청한 seniorId에 대한 유효한(active) 연결인지 확인한다.
 *  일치하는 guardian_links 행을 반환(없으면 null) — 호출부가 senior_user_id·id 등을 그대로 쓸 수 있게. */
async function authenticateGuardianRequest(env, request, seniorId) {
  const phoneDigits = String(request.headers.get('X-Guardian-Phone') || '').replace(/\D/g, '');
  const token = request.headers.get('X-Guardian-Token');
  const seniorUserId = Number(seniorId);
  if (!phoneDigits || !token || !seniorUserId) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.ansim_doumi_db.prepare(
    `SELECT id, senior_user_id FROM guardian_links
     WHERE senior_user_id = ? AND guardian_phone = ? AND token_hash = ? AND active = 1`
  ).bind(seniorUserId, phoneDigits, tokenHash).first();
  return row || null;
}

const RELAY_URL = 'https://relay-jet-six.vercel.app';

async function runAnalysis(env, content, schema = ANALYSIS_SCHEMA, maxTokens = 4096) {
  // Cloudflare 데이터센터 IP 대역이 Anthropic API에서 차단되어(리전 무관), Cloudflare 밖의
  // Vercel 중계 서버(relay/)를 거쳐 호출한다. RELAY_SECRET은 이 중계 서버를 아무나 호출해
  // Anthropic 크레딧을 소모하지 못하도록 막는 공유 비밀값이다.
  const proxied = await fetch(`${RELAY_URL}/api/proxy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-secret': env.RELAY_SECRET,
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      // 문서 분석은 문서마다 12개 필드를 채우고 여러 개로 나뉠 수도 있어 1024로는 응답이 잘린다.
      // 잘리면 JSON 파싱이 깨져 "분석에 실패했습니다"로 떨어지므로 넉넉히 잡는다.
      max_tokens: maxTokens,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }),
  });

  // 본문이 너무 크면 중계 서버가 JSON 이 아닌 평문("Request Entity Too Large")을 돌려준다.
  // 그대로 .json() 하면 엉뚱한 파싱 오류가 나므로 먼저 본문을 읽고 판별한다.
  const rawBody = await proxied.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    if (proxied.status === 413 || /entity too large/i.test(rawBody)) {
      throw new Error('사진 용량이 너무 큽니다. 더 작게 찍거나 한 번에 보내는 장수를 줄여주세요.');
    }
    throw new Error(`중계 서버 응답을 이해하지 못했습니다 (${proxied.status}) ${rawBody.slice(0, 120)}`);
  }
  if (!proxied.ok) throw new Error(`${proxied.status} ${JSON.stringify(data)}`);

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI 응답을 이해하지 못했습니다.');
  // max_tokens 에 걸려 잘리면 JSON 이 깨진다. 원인을 알 수 있게 구분해서 알려준다.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('AI 응답이 너무 길어 잘렸습니다. (stop_reason=max_tokens)');
  }
  return JSON.parse(textBlock.text);
}

/** 체크리스트를 대표하는 일러스트 1장을 OpenAI Images API(gpt-image-1)로 생성한다.
 *  키가 없거나 호출이 실패해도 문서/문자 분석 자체는 그대로 성공해야 하므로, 여기서는 절대 throw하지 않고 null만 돌려준다
 *  (프런트엔드는 illustration이 null이면 그림 영역을 조용히 숨긴다 — 지도 렌더링 실패와 같은 원칙). */
async function generateIllustration(env, prompt) {
  if (!env.OPENAI_API_KEY || !prompt || typeof prompt !== 'string') return null;
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: `Warm, simple flat illustration of ${prompt}. Friendly, accessible style for elderly viewers, soft warm colors, no text or letters in the image.`,
        size: '1024x1024',
        quality: 'medium',
      }),
    });
    if (!res.ok) {
      console.warn('일러스트 생성 실패:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    return b64 ? `data:image/png;base64,${b64}` : null;
  } catch (err) {
    console.warn('일러스트 생성 중 오류:', err && err.message || err);
    return null;
  }
}

export default {
  async fetch(request, env) {
    const CORS_HEADERS = corsHeadersFor(request);
    function json(data, status) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const ALLOWED_GET_PATHS = new Set(['/state', '/region-info', '/local-welfare', '/guardian/seniors', '/guardian/state', '/admin/users']);
    const isAllowedGet = request.method === 'GET' && ALLOWED_GET_PATHS.has(url.pathname);
    if (request.method !== 'POST' && !isAllowedGet) {
      return json({ error: 'Not found' }, 404);
    }

    if (url.pathname === '/analyze-doc') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }

      // images(배열)가 새 형식, image(단일)는 예전 앱 버전 호환용.
      const { image, images, mediaType, profile } = body || {};
      const photos = Array.isArray(images) && images.length
        ? images
        : (typeof image === 'string' && image ? [{ data: image, mediaType }] : []);
      if (photos.length === 0) return json({ error: '이미지가 없습니다.' }, 400);
      if (photos.length > MAX_DOC_PHOTOS) return json({ error: `사진은 한 번에 ${MAX_DOC_PHOTOS}장까지 보낼 수 있습니다.` }, 400);

      const invalid = photos.some((p) => !p || typeof p.data !== 'string' || !p.data);
      if (invalid) return json({ error: '이미지 형식이 올바르지 않습니다.' }, 400);

      try {
        const content = photos.map((p, i) => ([
          { type: 'text', text: `[사진 ${i + 1}]` },
          { type: 'image', source: { type: 'base64', media_type: p.mediaType || mediaType || 'image/jpeg', data: p.data } },
        ])).flat();
        content.push({ type: 'text', text: DOC_PROMPT + buildProfileNote(profile) });

        const result = await runAnalysis(env, content, DOC_ANALYSIS_SCHEMA);

        // 항상 documents 배열로 돌려준다. 앱은 예전 형식(단일 객체)도 읽을 수 있으므로
        // 첫 문서를 최상위에도 펼쳐 두어 배포 시점이 어긋나도 화면이 깨지지 않게 한다.
        const docs = Array.isArray(result.documents) && result.documents.length ? result.documents : [result];
        docs.forEach(redactAnalysisResult);
        // 문서마다 체크리스트를 대표하는 일러스트를 함께 생성한다(실패해도 분석 결과는 그대로 반환).
        await Promise.all(docs.map(async (doc) => {
          doc.illustration = await generateIllustration(env, doc.illustrationPrompt);
        }));
        return json({ ...docs[0], documents: docs }, 200);
      } catch (err) {
        return json({ error: 'AI 분석에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/analyze-text') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }

      const { text, profile } = body || {};
      if (!text || typeof text !== 'string') return json({ error: '문자 내용이 없습니다.' }, 400);

      try {
        const result = await runAnalysis(env, [
          { type: 'text', text: `${SMS_PROMPT}${buildProfileNote(profile)}\n\n문자 내용:\n${text}` },
        ]);
        redactAnalysisResult(result);
        result.illustration = await generateIllustration(env, result.illustrationPrompt);
        return json(result, 200);
      } catch (err) {
        return json({ error: 'AI 분석에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/ask') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }

      const { question, analysis, history, profile } = body || {};
      if (!question || typeof question !== 'string') return json({ error: '질문이 없습니다.' }, 400);
      if (question.length > 300) return json({ error: '질문이 너무 깁니다.' }, 400);
      if (!analysis || typeof analysis !== 'object') return json({ error: '무엇에 대한 질문인지 알 수 없습니다.' }, 400);

      // 분석 결과 중 답변 근거가 될 수 있는 값만 추려 넣는다(이미지는 다시 보내지 않는다).
      const facts = ['headline', 'summary', 'category', 'issuer', 'amount', 'dueDate', 'phone', 'website', 'mapQuery']
        .map((k) => (analysis[k] || analysis[k] === 0 ? `- ${k}: ${analysis[k]}` : null))
        .filter(Boolean);
      if (Array.isArray(analysis.checklist) && analysis.checklist.length) {
        facts.push(`- checklist: ${analysis.checklist.join(' / ')}`);
      }

      // 직전 대화는 몇 턴만 보낸다(길어지면 비용이 커지고 엉뚱한 맥락이 섞인다).
      const recent = (Array.isArray(history) ? history : []).slice(-4)
        .filter((h) => h && typeof h.q === 'string' && typeof h.a === 'string')
        .map((h) => `사용자: ${h.q}\n도우미: ${h.a}`)
        .join('\n');

      try {
        const prompt = [
          ASK_PROMPT + buildProfileNote(profile),
          `\n[분석 결과]\n${facts.join('\n')}`,
          recent ? `\n[앞선 대화]\n${recent}` : '',
          `\n[질문]\n${question}`,
        ].join('\n');
        const result = await runAnalysis(env, [{ type: 'text', text: prompt }], ASK_SCHEMA);
        if (typeof result.answer === 'string') result.answer = redactSensitiveNumbers(result.answer);
        return json(result, 200);
      } catch (err) {
        return json({ error: '답변을 만들지 못했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    /* ---- 통합 로그인/회원가입: 전화번호+비밀번호(PIN)만 받고, 계정이 없으면 그 자리에서 새로 만든다.
       이름은 여기서 받지 않고(가입 시 빈 문자열로 저장) screen-profile 단계에서 채워진다. ---- */
    if (url.pathname === '/auth' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const { phone, pin } = body || {};
      const phoneDigits = String(phone || '').replace(/\D/g, '');
      if (!/^010\d{7,8}$/.test(phoneDigits)) return json({ error: 'invalid_phone' }, 400);
      if (!/^\d{4}$/.test(String(pin || ''))) return json({ error: 'invalid_pin' }, 400);

      try {
        const user = await env.ansim_doumi_db.prepare(
          `SELECT id, pin_hash, pin_salt, name, is_admin, failed_attempts, locked_until FROM users WHERE phone = ?`
        ).bind(phoneDigits).first();

        if (!user) {
          const pinSalt = randomHex(16);
          const pinHash = await sha256Hex(pinSalt + pin);
          const token = randomHex(32);
          const inserted = await env.ansim_doumi_db.prepare(
            `INSERT INTO users (phone, pin_hash, pin_salt, name, token)
             VALUES (?, ?, ?, '', ?)`
          ).bind(phoneDigits, pinHash, pinSalt, token).run();
          return json({ userId: inserted.meta.last_row_id, token, name: '', isNewUser: true, isAdmin: false }, 200);
        }

        if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
          return json({ error: 'locked' }, 423);
        }

        const pinHash = await sha256Hex(user.pin_salt + pin);
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

        return json({ userId: user.id, token, name: user.name || '', isNewUser: false, isAdmin: !!user.is_admin }, 200);
      } catch (err) {
        return json({ error: '처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    /* ---- 회원 탈퇴: 세션 토큰만으로는 부족하고, 되돌릴 수 없는 작업이라 PIN을 다시 확인한다.
       계정과 함께 저장된 모든 데이터(appState, 보호자 연결)를 실제로 지운다. ---- */
    if (url.pathname === '/account/delete' && request.method === 'POST') {
      const userId = await authenticateRequest(env, request);
      if (!userId) return json({ error: 'unauthorized' }, 401);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const { pin } = body || {};

      try {
        const user = await env.ansim_doumi_db.prepare(
          `SELECT pin_hash, pin_salt FROM users WHERE id = ?`
        ).bind(userId).first();
        if (!user) return json({ error: 'unauthorized' }, 401);

        const pinHash = await sha256Hex(user.pin_salt + String(pin || ''));
        if (pinHash !== user.pin_hash) return json({ error: 'invalid_pin' }, 401);

        await env.ansim_doumi_db.prepare(
          `DELETE FROM guardian_message_reads WHERE link_id IN (SELECT id FROM guardian_links WHERE senior_user_id = ?)`
        ).bind(userId).run();
        await env.ansim_doumi_db.prepare(`DELETE FROM guardian_links WHERE senior_user_id = ?`).bind(userId).run();
        await env.ansim_doumi_db.prepare(`DELETE FROM user_state WHERE user_id = ?`).bind(userId).run();
        await env.ansim_doumi_db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();

        return json({ ok: true }, 200);
      } catch (err) {
        return json({ error: '탈퇴 처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

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

    if (url.pathname === '/verify-pin-reset-otp' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const { phone, otp, newPin } = body || {};
      const phoneDigits = String(phone || '').replace(/\D/g, '');
      if (String(newPin || '').length < 4) return json({ error: 'invalid_pin' }, 400);

      try {
        const user = await env.ansim_doumi_db.prepare(
          `SELECT id, otp_hash, otp_expires_at, otp_attempts FROM users WHERE phone = ?`
        ).bind(phoneDigits).first();

        if (!user || !user.otp_hash) return json({ error: 'invalid' }, 401);

        if (user.otp_attempts >= 5) return json({ error: 'otp_locked' }, 423);

        if (!user.otp_expires_at || new Date(user.otp_expires_at).getTime() < Date.now()) {
          return json({ error: 'otp_expired' }, 401);
        }

        const otpHash = await sha256Hex(String(otp || ''));
        if (otpHash !== user.otp_hash) {
          const attempts = (user.otp_attempts || 0) + 1;
          await env.ansim_doumi_db.prepare(
            `UPDATE users SET otp_attempts = ? WHERE id = ?`
          ).bind(attempts, user.id).run();
          return json({ error: 'invalid', attemptsLeft: Math.max(0, 5 - attempts) }, 401);
        }

        const pinSalt = randomHex(16);
        const pinHash = await sha256Hex(pinSalt + String(newPin));
        await env.ansim_doumi_db.prepare(
          `UPDATE users SET pin_hash = ?, pin_salt = ?, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?`
        ).bind(pinHash, pinSalt, user.id).run();

        return json({ ok: true }, 200);
      } catch (err) {
        return json({ error: '요청 처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    /* ---- 보호자 연동: 어르신은 이미 설정에서 입력해둔 보호자 전화번호를 그대로 쓰고(새 UI 없음),
       보호자 쪽에서 본인 전화번호를 OTP로 확인하면 그 번호를 등록해둔 어르신 계정을 자동으로 찾아 연결한다. ---- */

    if (url.pathname === '/guardian/request-otp' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const phoneDigits = String((body || {}).phone || '').replace(/\D/g, '');
      if (!/^010\d{7,8}$/.test(phoneDigits)) return json({ error: 'invalid_phone' }, 400);

      try {
        const otp = generateOtp();
        const otpHash = await sha256Hex(otp);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        await env.ansim_doumi_db.prepare(
          `INSERT INTO guardian_otp_requests (phone, otp_hash, otp_expires_at, otp_attempts)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(phone) DO UPDATE SET
             otp_hash = excluded.otp_hash, otp_expires_at = excluded.otp_expires_at, otp_attempts = 0`
        ).bind(phoneDigits, otpHash, expiresAt).run();

        const sent = await sendAligoSms(env, phoneDigits, `[온담 보호자] 인증번호는 ${otp}입니다. 5분 이내에 입력해주세요.`);
        if (!sent) return json({ error: 'sms_failed' }, 502);

        return json({ ok: true }, 200);
      } catch (err) {
        return json({ error: '요청 처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/guardian/verify-otp' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const { otp, guardianName } = body || {};
      const phoneDigits = String((body || {}).phone || '').replace(/\D/g, '');

      try {
        const req = await env.ansim_doumi_db.prepare(
          `SELECT otp_hash, otp_expires_at, otp_attempts FROM guardian_otp_requests WHERE phone = ?`
        ).bind(phoneDigits).first();

        if (!req) return json({ error: 'invalid' }, 401);
        if (req.otp_attempts >= 5) return json({ error: 'otp_locked' }, 423);
        if (!req.otp_expires_at || new Date(req.otp_expires_at).getTime() < Date.now()) {
          return json({ error: 'otp_expired' }, 401);
        }

        const otpHash = await sha256Hex(String(otp || ''));
        if (otpHash !== req.otp_hash) {
          const attempts = (req.otp_attempts || 0) + 1;
          await env.ansim_doumi_db.prepare(
            `UPDATE guardian_otp_requests SET otp_attempts = ? WHERE phone = ?`
          ).bind(attempts, phoneDigits).run();
          return json({ error: 'invalid', attemptsLeft: Math.max(0, 5 - attempts) }, 401);
        }

        // 인증 성공: 이 번호를 보호자로 등록해둔 어르신 계정을 전부 찾아 연결한다.
        const { results: seniors } = await env.ansim_doumi_db.prepare(
          `SELECT id, name FROM users WHERE guardian_phone = ?`
        ).bind(phoneDigits).all();

        const token = randomHex(32);
        const tokenHash = await sha256Hex(token);
        const name = String(guardianName || '');
        for (const senior of (seniors || [])) {
          await env.ansim_doumi_db.prepare(
            `INSERT INTO guardian_links (senior_user_id, guardian_phone, guardian_name, token_hash, active)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(senior_user_id, guardian_phone) DO UPDATE SET
               token_hash = excluded.token_hash, guardian_name = excluded.guardian_name, active = 1`
          ).bind(senior.id, phoneDigits, name, tokenHash).run();
        }

        // 재사용 방지: 검증에 성공한 OTP는 즉시 폐기한다.
        await env.ansim_doumi_db.prepare(`DELETE FROM guardian_otp_requests WHERE phone = ?`).bind(phoneDigits).run();

        return json({
          ok: true,
          token,
          seniors: (seniors || []).map((s) => ({ id: s.id, name: s.name || '' })),
        }, 200);
      } catch (err) {
        return json({ error: '요청 처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/guardian/seniors' && request.method === 'GET') {
      const phoneDigits = String(request.headers.get('X-Guardian-Phone') || '').replace(/\D/g, '');
      const token = request.headers.get('X-Guardian-Token');
      if (!phoneDigits || !token) return json({ error: 'unauthorized' }, 401);

      try {
        const tokenHash = await sha256Hex(token);
        const { results } = await env.ansim_doumi_db.prepare(
          `SELECT u.id, u.name FROM guardian_links gl
           JOIN users u ON u.id = gl.senior_user_id
           WHERE gl.guardian_phone = ? AND gl.token_hash = ? AND gl.active = 1`
        ).bind(phoneDigits, tokenHash).all();
        return json({ seniors: (results || []).map((s) => ({ id: s.id, name: s.name || '' })) }, 200);
      } catch (err) {
        return json({ error: '조회에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/guardian/state' && request.method === 'GET') {
      const seniorId = url.searchParams.get('seniorId');
      const link = await authenticateGuardianRequest(env, request, seniorId);
      if (!link) return json({ error: 'unauthorized' }, 401);

      try {
        await env.ansim_doumi_db.prepare(
          `UPDATE guardian_links SET last_seen_at = datetime('now') WHERE id = ?`
        ).bind(link.id).run();

        const row = await env.ansim_doumi_db.prepare(
          `SELECT state_json FROM user_state WHERE user_id = ?`
        ).bind(link.senior_user_id).first();
        const state = row ? JSON.parse(row.state_json) : {};
        const history = Array.isArray(state.history) ? state.history : [];
        const schedule = Array.isArray(state.schedule) ? state.schedule : [];
        const profile = state.profile || {};

        // 보호자에게는 appState 전체가 아니라 최근 기록 요약·일정만 보여준다(설정·PIN 등은 제외).
        const summary = history.slice(0, 20).map((h) => ({
          messageId: String(h.ts || h.time || ''),
          title: h.title || '',
          createdAt: h.ts ? new Date(h.ts).toISOString() : null,
          time: h.time || '',
          analysis: h.analysis ? {
            status: h.analysis.status || null,
            headline: h.analysis.headline || '',
            summary: h.analysis.summary || '',
            category: h.analysis.category || '',
            issuer: h.analysis.issuer || '',
            amount: h.analysis.amount || 0,
            dueDate: h.analysis.dueDate || '',
            phone: h.analysis.phone || '',
            website: h.analysis.website || '',
            checklist: Array.isArray(h.analysis.checklist) ? h.analysis.checklist : [],
          } : null,
        }));

        return json({
          profile: { name: profile.name || '', age: profile.age || '', gender: profile.gender || '', region: profile.region || '' },
          history: summary,
          schedule: schedule.map((s) => ({ text: s.text || '', source: s.source || '', date: s.date || '', time: s.time || '', done: !!s.done })),
        }, 200);
      } catch (err) {
        return json({ error: '불러오기에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/guardian/mark-read' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const { messageId } = body || {};
      const link = await authenticateGuardianRequest(env, request, (body || {}).seniorId);
      if (!link) return json({ error: 'unauthorized' }, 401);
      if (!messageId) return json({ error: '메시지가 없습니다.' }, 400);

      try {
        await env.ansim_doumi_db.prepare(
          `INSERT INTO guardian_message_reads (link_id, message_id) VALUES (?, ?)
           ON CONFLICT(link_id, message_id) DO NOTHING`
        ).bind(link.id, String(messageId)).run();
        return json({ ok: true }, 200);
      } catch (err) {
        return json({ error: '처리에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

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
        const state = body.state || {};
        await env.ansim_doumi_db.prepare(
          `INSERT INTO user_state (user_id, state_json, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             state_json = excluded.state_json, updated_at = excluded.updated_at`
        ).bind(userId, JSON.stringify(state)).run();

        // 보호자 앱이 전화번호로 어르신을 찾을 수 있도록 users.guardian_phone에도 동기화한다.
        // 번호가 바뀌거나 지워지면(예전 보호자 정보가 더 이상 유효하지 않음), 그 번호로 이미
        // 연결돼 있던 guardian_links는 비활성화해 예전 보호자가 계속 조회하지 못하게 막는다.
        const newGuardianPhone = String((state.guardian && state.guardian.phone) || '').replace(/\D/g, '') || null;
        const prevRow = await env.ansim_doumi_db.prepare(
          `SELECT guardian_phone FROM users WHERE id = ?`
        ).bind(userId).first();
        const prevGuardianPhone = prevRow ? prevRow.guardian_phone : null;
        if (prevGuardianPhone !== newGuardianPhone) {
          await env.ansim_doumi_db.prepare(
            `UPDATE users SET guardian_phone = ? WHERE id = ?`
          ).bind(newGuardianPhone, userId).run();
          if (prevGuardianPhone) {
            await env.ansim_doumi_db.prepare(
              `UPDATE guardian_links SET active = 0 WHERE senior_user_id = ? AND guardian_phone = ?`
            ).bind(userId, prevGuardianPhone).run();
          }
        }

        return json({ ok: true }, 200);
      } catch (err) {
        return json({ error: '저장에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    /* ---- 관리자 대시보드: is_admin=1인 계정만 볼 수 있는 조회 전용 화면. 로그인은 일반 회원과 동일한
       /auth(전화번호+PIN)로 하고, 여기서는 그 세션 토큰에 관리자 권한이 있는지만 확인한다.
       회원 수정·삭제나 분석 원문 열람 기능은 없다(조회 전용). ---- */
    if (url.pathname === '/admin/users' && request.method === 'GET') {
      const adminId = await authenticateAdminRequest(env, request);
      if (!adminId) return json({ error: 'unauthorized' }, 401);

      try {
        const { results } = await env.ansim_doumi_db.prepare(
          `SELECT u.id, u.name, u.phone, u.created_at,
                  COALESCE(json_array_length(us.state_json, '$.history'), 0) AS history_count
           FROM users u
           LEFT JOIN user_state us ON us.user_id = u.id
           ORDER BY u.created_at DESC`
        ).all();

        const users = (results || []).map((u) => {
          const digits = String(u.phone || '');
          const masked = digits.length >= 7
            ? digits.slice(0, 3) + '*'.repeat(digits.length - 7) + digits.slice(-4)
            : digits;
          return {
            id: u.id,
            name: u.name || '',
            phone: masked,
            createdAt: u.created_at,
            historyCount: u.history_count || 0,
          };
        });

        return json({ users, totalCount: users.length }, 200);
      } catch (err) {
        return json({ error: '조회에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    /* 경기데이터드림(경로당 현황, SenircentFaclt) 실제 공공데이터로 지역별 맞춤 정보 제공.
       경기도 31개 시/군 중 하나가 사용자가 입력한 자유 텍스트 지역에 포함될 때만 조회하고,
       매칭되지 않으면(경기도 밖 등) 지어내지 않고 matched:false만 반환한다. */
    const GYEONGGI_CITIES = [
      '수원시', '성남시', '의정부시', '안양시', '부천시', '광명시', '평택시', '동두천시',
      '안산시', '고양시', '과천시', '구리시', '남양주시', '오산시', '시흥시', '군포시',
      '의왕시', '하남시', '용인시', '파주시', '이천시', '안성시', '김포시', '화성시',
      '광주시', '양주시', '포천시', '여주시', '연천군', '가평군', '양평군'
    ];

    /* 언어 설정: 정적으로 미리 옮겨둔 5개 언어 번역 대신, 화면 문구(I18N.ko)를 실시간으로 번역한다.
       기기별로 언어당 한 번만 호출하고 결과를 localStorage에 캐시해 재사용한다(js/script.js의
       translateUiIfNeeded 참고) — 매번 언어를 바꿀 때마다 호출하지 않는다. */
    const TRANSLATE_LANG_NAMES = { zh: '중국어(간체)', vi: '베트남어', th: '태국어', uz: '우즈베크어' };
    const TRANSLATE_SCHEMA = {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'string' } } },
      required: ['translations'],
      additionalProperties: false,
    };

    if (url.pathname === '/translate' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }

      const { lang, texts } = body || {};
      const langName = TRANSLATE_LANG_NAMES[lang];
      if (!langName) return json({ error: '지원하지 않는 언어입니다.' }, 400);
      if (!Array.isArray(texts) || texts.length === 0) return json({ error: '번역할 문구가 없습니다.' }, 400);
      if (texts.length > 500) return json({ error: '한 번에 번역할 수 있는 문구는 500개까지입니다.' }, 400);

      const prompt = `다음은 고령자를 위한 한국어 앱의 화면 UI 문구 목록(JSON 배열)입니다. 각 문구를 자연스럽고 정중한 ${langName}로 번역하세요.

- <br> 같은 HTML 태그와 {i}, {n}, {age}, {gender} 같은 중괄호 플레이스홀더는 번역하지 말고 위치까지 그대로 유지하세요.
- 이모지(예: ⚠, 💛)는 그대로 두세요.
- 문구가 비어 있으면("") 빈 문자열로 그대로 두세요.
- 입력 배열과 같은 개수, 같은 순서로 translations 배열을 채우세요.

문구 목록:
${JSON.stringify(texts)}`;

      try {
        const result = await runAnalysis(env, [{ type: 'text', text: prompt }], TRANSLATE_SCHEMA, 8192);
        if (!Array.isArray(result.translations) || result.translations.length !== texts.length) {
          return json({ error: 'AI 응답 형식이 올바르지 않습니다.' }, 502);
        }
        return json({ translations: result.translations }, 200);
      } catch (err) {
        return json({ error: '번역에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/region-info' && request.method === 'GET') {
      const region = (url.searchParams.get('region') || '').trim();
      const matchedCity = GYEONGGI_CITIES.find((city) => region.includes(city));
      if (!matchedCity) return json({ matched: false }, 200);

      /* gg.go.kr Open API는 Cloudflare Workers의 해외 egress IP를 차단해 실시간 호출이 안 되므로,
         같은 데이터를 로컬에서 한 번 내려받아 D1(senior_centers)에 저장해두고 여기서 조회한다.
         (worker/seed_senior_centers.sql — 경기데이터드림 SenircentFaclt API 결과를 그대로 저장) */
      try {
        const { results } = await env.ansim_doumi_db.prepare(
          `SELECT name, phone, address FROM senior_centers WHERE sigun_nm = ? LIMIT 3`
        ).bind(matchedCity).all();
        return json({ matched: true, city: matchedCity, source: '경기데이터드림(경로당 현황)', centers: results || [] }, 200);
      } catch (err) {
        return json({ matched: false, error: String(err && err.message || err) }, 200);
      }
    }

    /* 지역 복지 서비스: 한국사회보장정보원_지자체복지서비스(복지로) 실제 공공데이터 — 전국 대상 실시간 API 호출.
       경로당(위)과 달리 apis.data.go.kr는 표준 오픈API 게이트웨이라 Worker에서 직접 호출한다.
       lifeArray=006(노년) 고정 + 나이·시도·시군구로 필터링하고, 시/도를 못 알아보면 지어내지 않고 matched:false. */
    const KOREA_PROVINCES = [
      '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시',
      '세종특별자치시', '경기도', '강원특별자치도', '강원도', '충청북도', '충청남도',
      '전북특별자치도', '전라북도', '전라남도', '경상북도', '경상남도', '제주특별자치도',
    ];
    const PROVINCE_ALIASES = {
      '서울': '서울특별시', '부산': '부산광역시', '대구': '대구광역시', '인천': '인천광역시',
      '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시', '세종': '세종특별자치시',
      '경기': '경기도', '강원': '강원특별자치도', '충북': '충청북도', '충남': '충청남도',
      '전북': '전북특별자치도', '전남': '전라남도', '경북': '경상북도', '경남': '경상남도', '제주': '제주특별자치도',
    };

    function parseRegionText(region) {
      const text = (region || '').trim();
      if (!text) return { ctpvNm: null, sggNm: '' };
      for (const full of KOREA_PROVINCES) {
        if (text.includes(full)) return { ctpvNm: full, sggNm: text.replace(full, '').trim() };
      }
      for (const short of Object.keys(PROVINCE_ALIASES)) {
        if (text.includes(short)) return { ctpvNm: PROVINCE_ALIASES[short], sggNm: text.replace(short, '').trim() };
      }
      return { ctpvNm: null, sggNm: text };
    }

    /* 지자체복지서비스 목록조회는 XML만 지원한다(JSON 미지원) — servList 블록 단위로 잘라 필요한 필드만 정규식으로 뽑는다. */
    function parseWelfareXml(xml) {
      const blocks = xml.split('<servList>').slice(1).map((s) => s.split('</servList>')[0]);
      const field = (block, tag) => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        if (!m) return '';
        return m[1]
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
          .trim();
      };
      return blocks
        .map((b) => ({ name: field(b, 'servNm'), summary: field(b, 'servDgst'), link: field(b, 'servDtlLink'), dept: field(b, 'bizChrDeptNm') }))
        .filter((item) => item.name);
    }

    if (url.pathname === '/local-welfare' && request.method === 'GET') {
      const region = (url.searchParams.get('region') || '').trim();
      const age = (url.searchParams.get('age') || '').trim();
      const { ctpvNm, sggNm } = parseRegionText(region);
      if (!ctpvNm || !env.WELFARE_API_KEY) return json({ matched: false }, 200);

      try {
        /* data.go.kr는 서비스키를 Encoding(퍼센트 인코딩된 형태)·Decoding(원문) 두 가지로 발급한다.
           URLSearchParams가 어차피 다시 인코딩하므로, 어느 쪽을 넣어도 이중 인코딩되지 않게 먼저 디코딩해둔다
           (원문 키에는 %로 시작하는 유효한 escape가 없어 decodeURIComponent가 그대로 통과한다). */
        let serviceKey = env.WELFARE_API_KEY;
        try { serviceKey = decodeURIComponent(serviceKey); } catch { /* 이미 원문이면 그대로 둔다 */ }

        const params = new URLSearchParams({ serviceKey, lifeArray: '006', numOfRows: '3', pageNo: '1', ctpvNm });
        if (sggNm) params.set('sggNm', sggNm);
        if (age) params.set('age', age);

        const res = await fetch(`https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist?${params.toString()}`);
        if (!res.ok) return json({ matched: false }, 200);
        const xml = await res.text();
        const items = parseWelfareXml(xml);
        if (items.length === 0) return json({ matched: false }, 200);
        return json({ matched: true, region: [ctpvNm, sggNm].filter(Boolean).join(' '), items }, 200);
      } catch (err) {
        return json({ matched: false, error: String(err && err.message || err) }, 200);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
