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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
  },
  required: ['status', 'headline', 'summary', 'checklist', 'phone', 'website', 'mapQuery'],
  additionalProperties: false,
};

const DOC_PROMPT = `당신은 고령자를 위한 문서 분석 도우미입니다. 사진 속 문서(공공기관 안내문, 병원 서류, 고지서, 안내문 등)의 내용을 분석해서 다음 항목을 한국어로 작성하세요.

- status: 이 문서가 사기·개인정보 요구 등으로 위험하면 "danger", 특별한 조치 없이 참고만 하면 되는 정보성 문서면 "info", 기한 내에 예약·신청·납부 등 조치가 필요하면 "normal"
- headline: 문서의 핵심 내용을 한 문장으로, 노인이 이해하기 쉽게
- summary: 2~3문장으로 쉬운 설명 (전문 용어 없이, 존댓말로)
- checklist: 사용자가 해야 할 구체적인 행동 목록 (없으면 빈 배열)
- phone: 문서에 실제로 적힌 문의 전화번호가 있으면 그대로, 없으면 빈 문자열 (지어내지 말 것)
- website: 문서에 실제로 적힌 공식 홈페이지 주소가 있으면 그대로, 없으면 빈 문자열 (지어내지 말 것)
- mapQuery: 방문해야 할 기관·장소명이 문서에 있으면 지도 검색에 쓸 이름(예: "국민건강보험공단 OO지사"), 없으면 빈 문자열 (지어내지 말 것)

사진이 문서가 아니거나 글자를 읽을 수 없으면 status는 "info", headline은 "사진을 다시 확인해주세요", summary에 그 이유를 설명하고 checklist는 빈 배열, phone/website/mapQuery도 빈 문자열로 답하세요.`;

/** 사용자가 설정에서 선택 입력한 성별/연령대/지역(선택 사항). 있으면 설명 톤 참고용으로만 쓰고, 모르는 지역별 기관명·연락처·주소는 절대 지어내지 않도록 명시한다. */
function buildProfileNote(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const parts = [];
  if (profile.age) parts.push(profile.age + '대'); // 앱에서 연령대(50/60/70/80) 단위로 받으므로 "73세"가 아닌 "70대"로 전달
  if (profile.gender) parts.push(profile.gender);
  if (profile.region) parts.push(profile.region + ' 거주');
  if (parts.length === 0) return '';
  return `\n\n[참고: 사용자는 ${parts.join(' · ')} 어르신입니다. 이 정보는 설명 톤과 관련성을 참고하는 데만 사용하고, 확실하지 않은 지역별 기관명·주소·전화번호는 절대 지어내지 마세요.]`;
}

const SMS_PROMPT = `당신은 고령자를 위한 문자 메시지 분석 도우미입니다. 아래 문자 내용을 분석해서 다음 항목을 한국어로 작성하세요.

- status: 사기·피싱·개인정보나 금융정보 요구 등 위험한 문자면 "danger", 광고나 인증번호 등 참고만 하면 되는 문자면 "info", 확인·예약·참석 등 조치가 필요한 정상적인 안내 문자면 "normal"
- headline: 문자의 핵심 내용을 한 문장으로, 노인이 이해하기 쉽게
- summary: 2~3문장으로 쉬운 설명 (전문 용어 없이, 존댓말로). 위험한 문자라면 왜 위험한지, 무엇을 하면 안 되는지도 포함
- checklist: 사용자가 해야 할 구체적인 행동 목록 (없으면 빈 배열)
- phone, website, mapQuery: 문자 분석에서는 사용하지 않으니 항상 빈 문자열로 답하세요`;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const RELAY_URL = 'https://relay-jet-six.vercel.app';

async function runAnalysis(env, content) {
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
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });

  const data = await proxied.json();
  if (!proxied.ok) throw new Error(`${proxied.status} ${JSON.stringify(data)}`);

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI 응답을 이해하지 못했습니다.');
  return JSON.parse(textBlock.text);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const isAllowedGet = request.method === 'GET' && (url.pathname === '/profile' || url.pathname === '/region-info');
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

      const { image, mediaType, profile } = body || {};
      if (!image || typeof image !== 'string') return json({ error: '이미지가 없습니다.' }, 400);

      try {
        const result = await runAnalysis(env, [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
          { type: 'text', text: DOC_PROMPT + buildProfileNote(profile) },
        ]);
        return json(result, 200);
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
        return json(result, 200);
      } catch (err) {
        return json({ error: 'AI 분석에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    /* 로그인이 없으므로 기기별 임의 deviceId로 프로필(이름/성별/연령대/지역)을 D1에 저장한다 */
    if (url.pathname === '/profile' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const { deviceId, name, gender, age, region } = body || {};
      if (!deviceId || typeof deviceId !== 'string') return json({ error: 'deviceId가 없습니다.' }, 400);

      try {
        await env.ansim_doumi_db.prepare(
          `INSERT INTO profiles (device_id, name, gender, age_band, region, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(device_id) DO UPDATE SET
             name = excluded.name, gender = excluded.gender,
             age_band = excluded.age_band, region = excluded.region,
             updated_at = excluded.updated_at`
        ).bind(deviceId, name || '', gender || '', age ? String(age) : '', region || '').run();
        return json({ ok: true }, 200);
      } catch (err) {
        return json({ error: '저장에 실패했습니다.', detail: String(err && err.message || err) }, 502);
      }
    }

    if (url.pathname === '/profile' && request.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) return json({ error: 'deviceId가 없습니다.' }, 400);

      try {
        const row = await env.ansim_doumi_db.prepare(
          `SELECT name, gender, age_band as age, region FROM profiles WHERE device_id = ?`
        ).bind(deviceId).first();
        if (row && row.age) row.age = parseInt(row.age, 10) || null;
        return json(row || { name: '', gender: '', age: null, region: '' }, 200);
      } catch (err) {
        return json({ error: '불러오기에 실패했습니다.', detail: String(err && err.message || err) }, 502);
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

    return json({ error: 'Not found' }, 404);
  },
};
