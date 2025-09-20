// frontend/src/apiClient.js
const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';

export async function analyze(text) {
  const res = await fetch(`${API_BASE}/api/gpt/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error('analyze failed');
  return res.json();
}

export async function saveMessage({ uid, sessionId, conversationId, message }) {
  const res = await fetch(`${API_BASE}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-USER-UID': uid
    },
    body: JSON.stringify({ sessionId, conversationId, message })
  });
  if (!res.ok) throw new Error('save failed');
  return res.json();
}

export async function rateMessage({ uid, sessionId, conversationId, messageId, rating }) {
  const res = await fetch(`${API_BASE}/api/messages/${messageId}/rate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-USER-UID': uid
    },
    body: JSON.stringify({ sessionId, conversationId, rating })
  });
  if (!res.ok) throw new Error('rating failed');
  return res.json();
}

export async function listConversations({ uid, sessionId, limit = 20 }) {
  const url = new URL(`${API_BASE}/api/conversations`);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString(), { headers: { 'X-USER-UID': uid } });
  if (!res.ok) throw new Error('list failed');
  return res.json();
}

export async function getCalendar({ uid, startDateKey, endDateKey }) {
  const url = new URL(`${API_BASE}/api/calendar`);
  if (startDateKey) url.searchParams.set('startDateKey', startDateKey);
  if (endDateKey)   url.searchParams.set('endDateKey', endDateKey);
  const res = await fetch(url.toString(), { headers: { 'X-USER-UID': uid } });
  if (!res.ok) throw new Error('calendar failed');
  return res.json();
}
