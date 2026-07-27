export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (req.headers['x-relay-secret'] !== process.env.RELAY_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(req.body),
  });

  const text = await anthropicRes.text();
  res.status(anthropicRes.status).setHeader('content-type', 'application/json').send(text);
}
