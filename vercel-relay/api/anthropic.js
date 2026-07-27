// Cloudflare Worker가 여기로 요청을 보내면, 이 함수(Vercel, Cloudflare 밖 네트워크)가 대신 Anthropic API를 호출해서 돌려준다.
// Cloudflare Worker에서 직접 호출하면 봇 차단(403)에 걸리는 문제를 우회하기 위한 중계 서버.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 허용됩니다.' });
    return;
  }

  const relayKey = req.headers['x-relay-key'];
  if (!relayKey || relayKey !== process.env.RELAY_KEY) {
    res.status(401).json({ error: '인증되지 않은 요청입니다.' });
    return;
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await anthropicRes.text();
    res.status(anthropicRes.status);
    res.setHeader('content-type', 'application/json');
    res.send(data);
  } catch (err) {
    res.status(502).json({ error: '중계 요청 실패', detail: String(err && err.message || err) });
  }
}
