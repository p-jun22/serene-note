// backend/services/gptService.js
// ─────────────────────────────────────────────────────────────────────────────
// [역할/총칙]
// - 사용자 입력 1건을 분석하여 analysisSnapshot_v1을 생성한다.
// - 계정/상황에 따라 3가지 모드로 동작:
//   · baseline(basic): 순정 GPT 텍스트만(프롬프트/보정/캡/게이트 OFF), 수치는 HF로만 파생
//   · admin: Stage-1(JSON) + Stage-2(± 교정) + 전역/개인 보정 + cap(≤0.85), safety OFF
//   · user : Stage-1(JSON) + Stage-2(± 교정) + 전역/개인 보정 + cap(≤0.85), safety ON
//
// [출력 스키마(불변)]
// analysisSnapshot_v1 = {
//   emotions: string[], distortions: string[], coreBeliefs: string[], recommendedQuestions: string[],
//   emoji: string,
//   confidences: { emotions, distortions, coreBelief, question, _final_raw, (baseline 제외)final_capped },
//   hf?: { emotion:{ avg, entropy }, nli:{ core:{ entail, contradict } } },
//   llm: { text, output:{...}, confidences:{ emotions, distortions, coreBelief, question } },
//   safety?: { selfHarm?: boolean }
// }
//
// [설정/환경]
// - OPENAI_API_KEY 필수(실모드). DEMO_MODE=1이면 내부 스텁 사용.
// - HF_BASE_URL(HF_SERVER): 허깅페이스 지표 서버(base: http://127.0.0.1:5001)
// - OPENAI_MODEL 기본 'gpt-4o'
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ── 환경 변수
const HF_BASE = process.env.HF_BASE_URL || process.env.HF_SERVER || 'http://127.0.0.1:5001';
const DEMO = process.env.DEMO_MODE === '1';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

// ── 레포(전역/개인 보정 파라미터 로드용)
let repo = null;
try {
  repo = require('./firestoreRepository') || null;
} catch (_) { repo = null; }

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────
const clip01 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return +n;
};
const coldStartCap = (x) => Math.min(clip01(x), 0.85);

// 이모지 매핑
const EMOJI = {
  행복: '😊', 기쁨: '😊', 즐거움: '😊', 만족: '🙂',
  사랑: '🥰', 설렘: '🤩', 기대: '🤩',
  평온: '😌', 안정: '😌', 중립: '😐',
  불안: '😟', 걱정: '😟', 초조: '😟', 두려움: '😨', 공포: '😨',
  슬픔: '😢', 우울: '😞', 상실: '😢',
  분노: '😠', 짜증: '😠', 화: '😠',
  수치심: '😳', 부끄러움: '😳',
  피곤: '🥱', 지침: '🥱'
};
const pickEmojiFromLabels = (labels = []) => {
  for (const l of labels) { if (EMOJI[l]) return EMOJI[l]; }
  return '😐';
};

// --- Self-harm quick detector (KO, fuzzy) ---
const SELF_HARM_PATTERNS = [
  // “자살 …” 계열
  /자\s*살\s*하\s*고\s*싶(?:다|어|겠|니|냐|다니|다니까)?/i,   // 자살하고싶다/…싶다니까
  /자\s*살\s*할\s*(?:래|까|게|거|지도)?/i,                   // 자살할래, 자살할까 …
  /자\s*살\s*(?:해|할)\s*것\s*같/i,                         // 자살할 것 같…
  /스스로\s*목\s*숨/i,
  /생을\s*마감/i,
  /삶(?:을)?\s*끝낼/i,

  // “죽고/죽어 … 싶” 계열
  /죽(?:고|어)\s*버리?\s*고?\s*싶/i,
  /죽고\s*싶/i,
  /살기\s*싫/i,
  /세상.*떠나/i,
  /없어지고\s*싶/i,
  /사라지고\s*싶/i,

  // 자해/투신 등
  /자\s*해/i,
  /뛰어\s*내리/i,
  /목\s*숨\s*(?:을)?\s*끊/i,
  /극단적\s*선택/i,
];

// 파일 상단 아무 곳(함수 바깥)에 추가
const CRISIS_HELP_KO = `
• 이 앱은 당신의 안전과 건강을 위해 만들어졌습니다.
  하지만 당신이 지금 느끼는 고통을 완전히 해결해주지는 못합니다.
  가까운 보호자/친구/상담센터에 즉시 연락해 주세요.

• 1393(자살예방상담) · 109(보건복지상담센터) · 1388(청소년)`;


function detectSelfHarmKo(text = '') {
  const t = String(text || '').toLowerCase();
  return SELF_HARM_PATTERNS.some((re) => re.test(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-1 : LLM 1패스
//  - baseline : 순정 GPT (no system, no JSON) → llm.text만
//  - admin/user: JSON Mode로 한글 키 + confidences(0~1)까지 추출
// ─────────────────────────────────────────────────────────────────────────────
function assertOpenAIEnv() {
  if (DEMO) return;
  if (!OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY missing');
    e.code = 'env_openai_missing';
    throw e;
  }
}

function buildSystemPromptStage1({ coaching = false }) {
  // coaching=false : 구조화/요약 추출 중심
  // coaching=true  : 추천질문 항목을 IF/코칭 가이드에 맞춰 더 명시적으로 생성
  const head = [
    '너는 심리/CBT 보조 분석기다.',
    '입력 텍스트에서 다음을 **JSON 객체**로만 출력하라(추가 텍스트/코드블록 금지).',
    '- "감정": 문자열 배열',
    '- "인지왜곡": 문자열 배열',
    '- "핵심믿음": 문자열(없으면 빈 문자열)',
    '- "추천질문": 문자열(없으면 빈 문자열)',
    '- "confidences": { "emotions":0..1, "distortions":0..1, "coreBelief":0..1, "question":0..1 }',
    '',
    '※ carryover 규칙:',
    '- 이전 메시지 분석(prev)이 함께 주어질 수 있다.',
    '- 현재 입력이 매우 짧거나 메타 성격(예: “어떻게 했어야 했을까?”)으로 새 근거가 없으면,',
    '  prev의 라벨을 유지하되 확실히 갱신 가능한 항목만 신중히 갱신한다.',
    '- 결과 JSON에서 어떤 항목이 비었으면 prev의 값을 보완하되, "추천질문"은 반드시 현재 입력을 기준으로 생성한다.'
  ];

  if (coaching) {
    head.push(
      '',
      '추천질문은 다음 순서를 참고해 1~2개 구체적으로 작성하라:',
      '1) 상황(부족하면 보충 질문) → 2) 감정의 이유 → 3) 반응/예측(행동) →',
      '4) 행동 후 감정 변화(연극치료/IF) → 5) 이후 걱정 → 6) 근거/반증은?',
      '단정/강요 금지, 사용자 표현을 1줄로 근거 요약 후 질문 제시.'
    );
  }
  return head.join('\n');
}

async function openaiChat(payload) {
  assertOpenAIEnv();
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    payload,
    {
      timeout: 45000,
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      }
    }
  );
  return resp.data?.choices?.[0]?.message?.content ?? '';
}

async function runStage1({ mode, userText, enableCoaching, prev = null }) {
  const temp = (mode === 'baseline') ? 1.0 : 0.2;  // baseline=1.0, admin/user=0.2
  // DEMO 스텁
  if (DEMO) {
    // baseline: "순정에 가깝되" 출력만 JSON 강제
    if (mode === 'baseline') {
      const sys = [
        '너는 CBT 구조화 보조다.',
        '아래 항목만 **JSON 객체**로 출력하라(설명/코드블록 금지).',
        '- "감정": 문자열 배열',
        '- "인지왜곡": 문자열 배열',
        '- "핵심믿음": 문자열(없으면 빈 문자열)',
        '- "추천질문": 문자열(없으면 빈 문자열)'
      ].join('\n');

      const raw = await openaiChat({
        model: OPENAI_MODEL,
        temperature: temp,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: String(userText || '').slice(0, 8000) }
        ]
      });

      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
      const out = {
        '감정': Array.isArray(parsed['감정']) ? parsed['감정'] : [],
        '인지왜곡': Array.isArray(parsed['인지왜곡']) ? parsed['인지왜곡'] : [],
        '핵심믿음': typeof parsed['핵심믿음'] === 'string' ? parsed['핵심믿음'] : '',
        '추천질문': typeof parsed['추천질문'] === 'string' ? parsed['추천질문'] : ''
      };
      return {
        llm: { text: '', output: out, confidences: {} },
        parsed: out
      };
    }
    // admin/user 데모
    const parsed = {
      '감정': ['우울'],
      '인지왜곡': ['흑백논리'],
      '핵심믿음': '나는 가치없다',
      '추천질문': enableCoaching ? '그 생각을 뒷받침/반박하는 증거는 무엇인가요?' : '',
      'confidences': { emotions: 0.8, distortions: 0.5, coreBelief: 0.6, question: 0.6 }
    };
    return {
      llm: { text: '', output: parsed, confidences: parsed.confidences },
      parsed
    };
  }

  // admin/user: JSON Mode
  const sys = buildSystemPromptStage1({ coaching: !!enableCoaching });

  // prev를 간단 요약으로 축약해 함께 전달
  const prevCtx = prev ? {
    emotions: Array.isArray(prev.emotions) ? prev.emotions : [],
    distortions: Array.isArray(prev.distortions) ? prev.distortions : [],
    coreBelief: Array.isArray(prev.coreBeliefs) ? (prev.coreBeliefs[0] || '') : (prev.coreBelief || ''),
    lastQuestion: Array.isArray(prev.recommendedQuestions) ? (prev.recommendedQuestions[0] || '') : ''
  } : null;

  const messages = [{ role: 'system', content: sys }];
  if (prevCtx) messages.push({ role: 'user', content: `이전 분석(prev): ${JSON.stringify(prevCtx)}` });
  messages.push({ role: 'user', content: String(userText || '').slice(0, 8000) });

  const raw = await openaiChat({
    model: OPENAI_MODEL,
    temperature: temp,
    response_format: { type: 'json_object' },
    messages
  });

  let parsed = {};
  try { parsed = JSON.parse(raw); }
  catch (_e) {
    const m = String(raw || '').match(/\{[\s\S]*\}$/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  // 표준화
  const out = {
    '감정': Array.isArray(parsed['감정']) ? parsed['감정'] : [],
    '인지왜곡': Array.isArray(parsed['인지왜곡']) ? parsed['인지왜곡'] : [],
    '핵심믿음': typeof parsed['핵심믿음'] === 'string' ? parsed['핵심믿음'] : '',
    '추천질문': typeof parsed['추천질문'] === 'string' ? parsed['추천질문'] : '',
    'confidences': {
      emotions: clip01(parsed?.confidences?.emotions ?? 0.6),
      distortions: clip01(parsed?.confidences?.distortions ?? 0.5),
      coreBelief: clip01(parsed?.confidences?.coreBelief ?? 0.5),
      question: clip01(parsed?.confidences?.question ?? 0.5),
    }
  };

  // carryover: 결과가 비면 prev로 보완
  if (prev) {
    if ((!out['감정'] || out['감정'].length === 0) && Array.isArray(prev.emotions) && prev.emotions.length) {
      out['감정'] = [...prev.emotions];
      if (out.confidences.emotions == null) out.confidences.emotions = 0.6;
    }
    if ((!out['인지왜곡'] || out['인지왜곡'].length === 0) && Array.isArray(prev.distortions) && prev.distortions.length) {
      out['인지왜곡'] = [...prev.distortions];
      if (out.confidences.distortions == null) out.confidences.distortions = 0.6;
    }
    if (!out['핵심믿음'] || !out['핵심믿음'].trim()) {
      const cb = Array.isArray(prev.coreBeliefs) ? prev.coreBeliefs[0] : (prev.coreBelief || '');
      out['핵심믿음'] = cb || '';
      if (out.confidences.coreBelief == null && cb) out.confidences.coreBelief = 0.6;
    }
    // "추천질문"은 비어있더라도 굳이 prev로 채우지 않음(현재 입력 기준 생성이 원칙)
  }

  return {
    llm: { text: '', output: out, confidences: out.confidences },
    parsed: out
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HF 신호 호출 (/scores)
//  - 입력: text + (있다면) LLM이 추정한 감정/핵심믿음
//  - 출력: { emotions_avg, emotion_entropy, nli_core:{entail,contradict}, hf_raw{...} }
// ─────────────────────────────────────────────────────────────────────────────
async function runHFSignals({ userText, emotions, coreBelief }) {
  try {
    const payload = {
      text: String(userText || ''),
      emotions: Array.isArray(emotions) ? emotions : [],
      coreBelief: typeof coreBelief === 'string' ? coreBelief : ''
    };
    const r = await axios.post(`${HF_BASE}/scores`, payload, { timeout: 30000 });
    return r.data || null;
  } catch (_e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-2(± 교정) — 대칭 가산/감산
//  · 감정: α*(0.5 - entropy) → |boost| ≤ 0.1
//  · 핵심믿음: β*(entail - contradict) → |boost| ≤ 0.1
//  · 왜곡/질문: ±0.05 소폭
// ─────────────────────────────────────────────────────────────────────────────
function applySymmetricCorrection(llmConf, hf, { alpha = 0.2, beta = 0.2 } = {}) {
  const entropy = clip01(hf?.emotion?.entropy ?? 0.5);
  const entail = clip01(hf?.nli?.core?.entail ?? 0.0);
  const contradict = clip01(hf?.nli?.core?.contradict ?? 0.0);

  const boostEmotion = Math.max(-0.1, Math.min(0.1, alpha * (0.5 - entropy)));
  const boostCore = Math.max(-0.1, Math.min(0.1, beta * (entail - contradict)));
  const tweakSmall = 0.05;

  return {
    emotions: clip01((llmConf.emotions ?? 0) + boostEmotion),
    distortions: clip01((llmConf.distortions ?? 0) + (entail >= contradict ? +tweakSmall : -tweakSmall)),
    coreBelief: clip01((llmConf.coreBelief ?? 0) + boostCore),
    question: clip01((llmConf.question ?? 0) + (entropy <= 0.5 ? +tweakSmall : -tweakSmall)),
    _debug: { boostEmotion, boostCore }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
/** Platt/Isotonic 적용 */
// ─────────────────────────────────────────────────────────────────────────────
function applyPlatt(p, a, b) {
  const x = clip01(p);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return x;
  const z = a * x + b;
  return 1 / (1 + Math.exp(-z));
}
function applyIsotonic(p, bins, map) {
  if (!Array.isArray(bins) || !Array.isArray(map) || bins.length !== map.length + 1) return p;
  const x = clip01(p);
  let lo = 0, hi = bins.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (x < bins[mid]) hi = mid; else lo = mid;
  }
  const y = Number(map[lo]);
  return Number.isFinite(y) ? clip01(y) : x;
}
function applyCalibration(p, prof) {
  if (!prof) return clip01(p);
  // Platt 우선, 없으면 Isotonic
  if (prof.platt && Number.isFinite(prof.platt.a) && Number.isFinite(prof.platt.b)) {
    return clip01(applyPlatt(p, prof.platt.a, prof.platt.b));
  }
  if (prof.isotonic && Array.isArray(prof.isotonic.bins) && Array.isArray(prof.isotonic.map)) {
    return clip01(applyIsotonic(p, prof.isotonic.bins, prof.isotonic.map));
  }
  return clip01(p);
}

// ─────────────────────────────────────────────────────────────────────────────
/** 게이트: 재질문/재시도 제안 */
// ─────────────────────────────────────────────────────────────────────────────
function shouldRetryGate(snapshot) {
  const entail = Number(snapshot?.hf?.nli?.core?.entail ?? 0);
  const contradict = Number(snapshot?.hf?.nli?.core?.contradict ?? 0);
  const entropy = Number(snapshot?.hf?.emotion?.entropy ?? 0);
  const finalRaw = Number(snapshot?.confidences?._final_raw ?? 0);
  if ((entail < 0.35) || (contradict >= 0.20) || (entropy >= 0.85)) {
    if (finalRaw < 0.65) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인 API: analyzeMessage
//  - 입력: { uid, dateKey, conversationId, userText, mode: 'baseline'|'admin'|'user',
//           enableCoaching, enableCorrection, safetyOn }
//  - 출력: { snapshot, hf_raw, usedPrompts, suggestRetry }
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeMessage({
  uid, dateKey, conversationId, userText,
  mode = 'user',                 // 'baseline' | 'admin' | 'user'
  enableCoaching = false,        // 2번째 user부터 코칭 프롬프트 적용
  enableCorrection = true,       // 1번째부터 ±교정 적용(baseline 제외)
  safetyOn = false,              // 일반 사용자만 ON
  prevSnapshot = null,            // 직전 스냅샷(있다면 carryover용)
}) {
  // 0) Safety gate (자해/위험 신호 → Stage-1 우회 & 즉시 리턴)
  if (safetyOn && detectSelfHarmKo(userText)) {
    const snapshot = {
      emotions: [],
      distortions: [],
      coreBeliefs: [],
      // ★ 한 개의 멀티라인 문자열만 담아주면 , 로 이어지지 않음
      recommendedQuestions: [CRISIS_HELP_KO],
      llm: {
        text: '',
        output: {}, // Stage-1 우회
        confidences: { emotions: 0, distortions: 0, coreBelief: 0, question: 0.85 }
      },
      confidences: {
        emotions: 0, distortions: 0, coreBelief: 0, question: 0.85,
        _final_raw: 0, final_capped: 0
      },
      safety: { selfHarm: true, message: CRISIS_HELP_KO }
    };

    return {
      snapshot,
      hf_raw: null,
      usedPrompts: { safety: 'selfharm-ko' },
      suggestRetry: false
    };
  }

  // 1) Stage-1
  const s1 = await runStage1({ mode, userText, enableCoaching, prev: prevSnapshot });
  const llm = s1.llm;
  const p = s1.parsed || {};

  const emotions = Array.isArray(p['감정']) ? p['감정'] : [];
  const distortions = Array.isArray(p['인지왜곡']) ? p['인지왜곡'] : [];
  const coreBelief = typeof p['핵심믿음'] === 'string' ? p['핵심믿음'] : '';
  const question1 = typeof p['추천질문'] === 'string' ? p['추천질문'] : '';
  const llmConf = {
    emotions: clip01(p?.confidences?.emotions ?? 0.5),
    distortions: clip01(p?.confidences?.distortions ?? 0.5),
    coreBelief: clip01(p?.confidences?.coreBelief ?? 0.5),
    question: clip01(p?.confidences?.question ?? 0.5),
  };

  // 2) HF 신호
  const hfResp = await runHFSignals({ userText, emotions, coreBelief });
  const hf = hfResp ? {
    emotion: { avg: clip01(hfResp?.emotions_avg ?? hfResp?.hf_raw?.emotion?.avg), entropy: clip01(hfResp?.emotion_entropy ?? hfResp?.hf_raw?.emotion?.entropy) },
    nli: { core: { entail: clip01(hfResp?.nli_core?.entail ?? hfResp?.hf_raw?.nli_core?.entail), contradict: clip01(hfResp?.nli_core?.contradict ?? hfResp?.hf_raw?.nli_core?.contradict) } }
  } : undefined;

  // 3) baseline: 거의 순정 GPT + HF 파생 수치로만 스냅샷 구성
  if (mode === 'baseline') {
    const conf_emotions = clip01(1 - (hf?.emotion?.entropy ?? 0.5));
    const conf_coreBelief = clip01(Math.max(0, (hf?.nli?.core?.entail ?? 0) - (hf?.nli?.core?.contradict ?? 0)));
    const conf_distort = 0.5;
    const conf_question = 0.5;
    const _final_raw = clip01((conf_emotions + conf_distort + conf_coreBelief) / 3);

    const snapshot = {
      emotions,
      distortions,
      coreBeliefs: coreBelief ? [coreBelief] : [],
      recommendedQuestions: question1 ? [question1] : [],
      emoji: pickEmojiFromLabels(emotions),
      confidences: { emotions: conf_emotions, distortions: conf_distort, coreBelief: conf_coreBelief, question: conf_question, _final_raw },
      ...(hf ? { hf } : {}),
      llm: { text: llm.text || '', output: llm.output || p, confidences: {} },
      ...(safetyOn ? { safety: { selfHarm: detectSelfHarmKo(userText) } } : {})
    };

    const usedPrompts = { stage1: 'baseline:json' };
    const suggestRetry = shouldRetryGate(snapshot);
    return { snapshot, hf_raw: hfResp || null, usedPrompts, suggestRetry };
  }

  // 4) admin/user: 교정(±) → 전역/개인 보정 → cap
  // 4-1) 기본은 LLM confidences에서 시작
  let conf = { ...llmConf };

  // 4-2) ± 교정(대칭): baseline 제외, enableCorrection==true일 때
  if (enableCorrection) {
    const corr = applySymmetricCorrection(llmConf, hf, { alpha: 0.2, beta: 0.2 });
    conf.emotions = corr.emotions;
    conf.distortions = corr.distortions;
    conf.coreBelief = corr.coreBelief;
    conf.question = corr.question;
  }

  // 4-3) HF-우선 결합으로 _final_raw 생성
  //   emotions ≈ 1 - entropy, core ≈ max(0, entail-contradict), distort ≈ conf.distortions(소폭 조정)
  const hf_emotions = clip01(1 - (hf?.emotion?.entropy ?? 0.5));
  const hf_core = clip01(Math.max(0, (hf?.nli?.core?.entail ?? 0) - (hf?.nli?.core?.contradict ?? 0)));
  // 결합: LLM 보조(≤0.2)
  const wL = 0.2, wH = 0.8;
  const f_emotions = clip01(wH * hf_emotions + wL * conf.emotions);
  const f_core = clip01(wH * hf_core + wL * conf.coreBelief);
  const f_distort = clip01(conf.distortions);
  let _final_raw = clip01((f_emotions + f_distort + f_core) / 3);

  // 4-4) 전역/개인 보정 적용 (전역 → 개인)
  let globalProf = null, personalProf = null;
  if (repo && typeof repo.getCalibrationProfile === 'function') {
    try {
      const prof = await repo.getCalibrationProfile(uid);
      globalProf = prof?.global || null;
      personalProf = (prof?.personal && Number(prof?.personal?.rated_samples) >= Number(prof?.personal?.min_samples ?? 20)) ? prof.personal : null;
    } catch (_) { }
  }
  _final_raw = applyCalibration(_final_raw, globalProf);
  _final_raw = applyCalibration(_final_raw, personalProf);

  // 4-5) cold-start cap(≤0.85)
  const final_capped = coldStartCap(_final_raw);

  // 5) 스냅샷 조립 — 코칭 단계는 이모지 저장 생략
  const emojiValue = enableCoaching ? undefined : pickEmojiFromLabels(emotions);

  const snapshot = {
    emotions,
    distortions,
    coreBeliefs: coreBelief ? [coreBelief] : [],
    recommendedQuestions: question1 ? [question1] : [],
    ...(emojiValue ? { emoji: emojiValue } : {}),  // ← 조건부 저장
    ...(hf ? { hf } : {}),
    llm: {
      text: llm.text || '',
      output: llm.output || p,
      confidences: { ...llmConf },
    },
    confidences: {
      emotions: conf.emotions,
      distortions: conf.distortions,
      coreBelief: conf.coreBelief,
      question: conf.question,
      _final_raw,
      final_capped
    },
    ...(safetyOn ? { safety: { selfHarm: detectSelfHarmKo(userText) } } : {})
  };


  const usedPrompts = {
    stage1: `extract-json${enableCoaching ? '+coaching' : ''}`,
    stage2: enableCorrection ? '±symmetric(hf-entropy/entail-contradict)' : 'off',
    cal: [
      globalProf ? (globalProf.platt ? 'platt' : 'isotonic') : 'none',
      personalProf ? (personalProf.platt ? 'platt' : 'isotonic') : 'none'
    ].join('→'),
    cap: '≤0.85'
  };

  const suggestRetry = shouldRetryGate(snapshot);

  return { snapshot, hf_raw: hfResp || null, usedPrompts, suggestRetry };
}

// (선택) 외부에서 직접 Stage-1+HF만 필요할 때 사용하는 헬퍼
async function analyzeWithLLMAndHF(userText) {
  const { llm, parsed } = await runStage1({ mode: 'user', userText, enableCoaching: false });
  const hf_raw = await runHFSignals({ userText, emotions: parsed['감정'], coreBelief: parsed['핵심믿음'] });
  const emotions = Array.isArray(parsed['감정']) ? parsed['감정'] : [];
  const distortions = Array.isArray(parsed['인지왜곡']) ? parsed['인지왜곡'] : [];
  const coreBelief = parsed['핵심믿음'] ? [parsed['핵심믿음']] : [];
  const questions = parsed['추천질문'] ? [parsed['추천질문']] : [];
  const llmConf = {
    emotions: clip01(parsed?.confidences?.emotions ?? 0.5),
    distortions: clip01(parsed?.confidences?.distortions ?? 0.5),
    coreBelief: clip01(parsed?.confidences?.coreBelief ?? 0.5),
    question: clip01(parsed?.confidences?.question ?? 0.5),
  };
  const hf = hf_raw ? {
    emotion: { avg: clip01(hf_raw?.emotions_avg ?? hf_raw?.hf_raw?.emotion?.avg), entropy: clip01(hf_raw?.emotion_entropy ?? hf_raw?.hf_raw?.emotion?.entropy) },
    nli: { core: { entail: clip01(hf_raw?.nli_core?.entail ?? hf_raw?.hf_raw?.nli_core?.entail), contradict: clip01(hf_raw?.nli_core?.contradict ?? hf_raw?.hf_raw?.nli_core?.contradict) } }
  } : undefined;

  return {
    analysisSnapshot_v1: {
      emotions, distortions, coreBeliefs: coreBelief, recommendedQuestions: questions,
      emoji: pickEmojiFromLabels(emotions),
      ...(hf ? { hf } : {}),
      llm: { text: llm.text || '', output: llm.output || parsed, confidences: llmConf }
    },
    hf_raw
  };
}

module.exports = {
  analyzeMessage,
  analyzeWithLLMAndHF,
};
