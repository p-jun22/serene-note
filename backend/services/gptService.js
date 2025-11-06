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

function toStrArray(x, { max = Infinity, dedup = true } = {}) {
  let arr = [];
  if (Array.isArray(x)) arr = x;
  else if (typeof x === 'string') arr = [x];
  arr = arr.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  if (dedup) { const seen = new Set(); arr = arr.filter(s => (seen.has(s) ? false : (seen.add(s), true))); }
  if (Number.isFinite(max)) arr = arr.slice(0, max);
  return arr;
}

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
    '- "핵심믿음": 문자열 배열',
    '※ "핵심믿음"은 반드시 한 문장으로 추출하라. 비어 있거나 모호하면 사용자의 서술에서 가장 중심이 되는 신념을 한 문장으로 재진술하라. (기본 1개, 불가피한 경우에만 2개)',
    '- "추천질문": 문자열 배열',
    '- "confidences": { "emotions":0..1, "distortions":0..1, "coreBelief":0..1, "question":0..1 }',
    '',
    '※ carryover 규칙:',
    '- 이전 메시지 분석(prev)이 함께 주어질 수 있다.',
    '- 현재 입력이 매우 짧거나 메타 성격(예: “어떻게 했어야 했을까?”)으로 새 근거가 없으면, prev의 라벨을 유지하되 확실히 갱신 가능한 항목만 신중히 갱신한다.',
    '- 결과 JSON에서 어떤 항목이 비었으면 prev의 값을 보완하되, "추천질문"은 반드시 현재 입력을 기준으로 새로 생성한다.'
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

async function runStage1({ mode, userText, enableCoaching, prev = null, promptOverride = null }) {
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
        '- "핵심믿음": 문자열 배열',
        '- "추천질문": 문자열 배열'
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
      // DEMO baseline 표준화(out 만드는 부분)
      const out = {
        '감정': toStrArray(parsed['감정'], { max: 4 }),
        '인지왜곡': toStrArray(parsed['인지왜곡'], { max: 4 }),
        '핵심믿음': toStrArray(parsed['핵심믿음'], { max: 2 }),
        '추천질문': toStrArray(parsed['추천질문'], { max: 3 })
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
  const sys = promptOverride || buildSystemPromptStage1({ coaching: enableCoaching });

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

  // ▼ JSON 파싱 후: 표준화(문자열/배열 모두 수용)
  const out = {
    '감정': toStrArray(parsed['감정'], { max: 4 }),
    '인지왜곡': toStrArray(parsed['인지왜곡'], { max: 4 }),
    '핵심믿음': toStrArray(parsed['핵심믿음'], { max: 2 }),   // 기본 1개, 최대 2개
    '추천질문': toStrArray(parsed['추천질문'], { max: 3 }),
    'confidences': {
      emotions: clip01(parsed?.confidences?.emotions ?? 0.6),
      distortions: clip01(parsed?.confidences?.distortions ?? 0.5),
      coreBelief: clip01(parsed?.confidences?.coreBelief ?? 0.5),
      question: clip01(parsed?.confidences?.question ?? 0.5),
    }
  };

  // ▼ carryover: 결과가 비면 prev로 보완(배열 기준)
  if (prev) {
    if (!out['감정'].length && Array.isArray(prev.emotions) && prev.emotions.length) {
      out['감정'] = [...prev.emotions];
      if (out.confidences.emotions == null) out.confidences.emotions = 0.6;
    }
    if (!out['인지왜곡'].length && Array.isArray(prev.distortions) && prev.distortions.length) {
      out['인지왜곡'] = [...prev.distortions];
      if (out.confidences.distortions == null) out.confidences.distortions = 0.6;
    }
    if (!out['핵심믿음'].length) {
      const cb = Array.isArray(prev.coreBeliefs) ? prev.coreBeliefs[0] : (prev.coreBelief || '');
      if (cb) {
        out['핵심믿음'] = [cb];
        if (out.confidences.coreBelief == null) out.confidences.coreBelief = 0.6;
      }
    }
    // "추천질문"은 항상 현재 입력 기준 → prev로 채우지 않음
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
    const r = await axios.post(`${HF_BASE}/scores?segment=true`, payload, { timeout: 30000 });
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
  promptOverride = null,
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
  const s1 = await runStage1({ mode, userText, enableCoaching, prev: prevSnapshot, promptOverride });
  const llm = s1.llm;
  const p = s1.parsed || {};

  const emotionsArr = toStrArray(p['감정'], { max: 4 });
  const distortionsArr = toStrArray(p['인지왜곡'], { max: 4 });
  const coreBeliefsArr = toStrArray(p['핵심믿음'], { max: 2 });
  const questionsArr = toStrArray(p['추천질문'], { max: 3 });
  const primaryCoreBelief = coreBeliefsArr[0] || '';
  const llmConf = {
    emotions: clip01(p?.confidences?.emotions ?? 0.5),
    distortions: clip01(p?.confidences?.distortions ?? 0.5),
    coreBelief: clip01(p?.confidences?.coreBelief ?? 0.5),
    question: clip01(p?.confidences?.question ?? 0.5),
  };

  // 2) HF 신호
  const hfResp = await runHFSignals({ userText, emotions: emotionsArr, coreBelief: primaryCoreBelief });
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
      emotions: emotionsArr,
      distortions: distortionsArr,
      coreBeliefs: coreBeliefsArr,
      recommendedQuestions: questionsArr,
      emoji: pickEmojiFromLabels(emotionsArr),
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

  // 4-2.5) HF-게이팅: HF 신호가 약할수록 LLM 감정확신을 부드럽게 수축
if (hf && typeof hf?.emotion?.entropy === 'number') { 
  const hfConfEmo = clip01(1 - hf.emotion.entropy);           // 0..1
  const gate = Math.max(0.2, Math.min(1.0, 4 * hfConfEmo));   // 신호 약할수록 작아짐(바닥 0.2)
  conf.emotions = clip01((conf.emotions ?? 0) * gate);
  if (llmConf && typeof llmConf.emotions === 'number') {
    llmConf.emotions = conf.emotions; // 요약 카드 표기도 정렬
  }
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
  const emojiValue = enableCoaching ? undefined : pickEmojiFromLabels(emotionsArr);

  const snapshot = {
    emotions: emotionsArr,
    distortions: distortionsArr,
    coreBeliefs: coreBeliefsArr,
    recommendedQuestions: questionsArr,
    ...(emojiValue ? { emoji: emojiValue } : {}),
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

  const emotions = toStrArray(parsed['감정'], { max: 4 });
  const distortions = toStrArray(parsed['인지왜곡'], { max: 4 });
  const coreBeliefs = toStrArray(parsed['핵심믿음'], { max: 2 });
  const questions = toStrArray(parsed['추천질문'], { max: 3 });
  const primaryCoreBelief = coreBeliefs[0] || '';

  const hf_raw = await runHFSignals({ userText, emotions, coreBelief: primaryCoreBelief });

  const llmConf = {
    emotions: clip01(parsed?.confidences?.emotions ?? 0.5),
    distortions: clip01(parsed?.confidences?.distortions ?? 0.5),
    coreBelief: clip01(parsed?.confidences?.coreBelief ?? 0.5),
    question: clip01(parsed?.confidences?.question ?? 0.5),
  };
  const hf = hf_raw ? {
    emotion: {
      avg: clip01(hf_raw?.emotions_avg ?? hf_raw?.hf_raw?.emotion?.avg),
      entropy: clip01(hf_raw?.emotion_entropy ?? hf_raw?.hf_raw?.emotion?.entropy)
    },
    nli: {
      core: {
        entail: clip01(hf_raw?.nli_core?.entail ?? hf_raw?.hf_raw?.nli_core?.entail),
        contradict: clip01(hf_raw?.nli_core?.contradict ?? hf_raw?.hf_raw?.nli_core?.contradict)
      }
    }
  } : undefined;

  return {
    analysisSnapshot_v1: {
      emotions,
      distortions,
      coreBeliefs,
      recommendedQuestions: questions,
      emoji: pickEmojiFromLabels(emotions),
      ...(hf ? { hf } : {}),
      llm: { text: llm.text || '', output: llm.output || parsed, confidences: llmConf }
    },
    hf_raw
  };
}


/* ─────────────────────────────────────────────────────────────────────────────
   A/B 변형 프롬프트 선택 + 저장 제어 러너(runCBTAnalysis) + 공통 저장(persist)
   - variant: 'A' | 'B'  (필요 시 더 늘려도 됨)
   - save: false 면 messages/analysisSnapshot_v1/캘린더에 아무 것도 저장하지 않음
   - persistAnalyzeResult: /gpt/analyze 경로에서 쓰던 저장 루틴을 공통화
   ────────────────────────────────────────────────────────────────────────────*/

/** V1/V2 실제 차이를 만드는 시스템 프롬프트(간결/보수 vs. 타이트/제약 강화) */
function promptVariantV1({ coaching }) {
  // 기존 빌더 유지
  return buildSystemPromptStage1({ coaching });
}
function promptVariantV2({ coaching }) {
  // V2는 키/제약을 더 타이트하게 (키 한글 고정, 길이 제한 등)
  const base = buildSystemPromptStage1({ coaching });
  return base + [
    '',
    '※ V2 추가 규칙',
    '- 출력 키는 반드시 이 5개만: 감정, 인지왜곡, 핵심믿음, 추천질문, confidences',
    '- 감정은 최대 4개, 핵심믿음/추천질문은 각 1개 문장(20~60자 권장).',
    '- confidences 수치는 0~1, 소수 둘째 자리까지.',
  ].join('\n');
}

/** variant → system 프롬프트 문자열 선택 */
function selectPromptByVariant(variant, { coaching }) {
  return (String(variant).toUpperCase() === 'B')
    ? promptVariantV2({ coaching })
    : promptVariantV1({ coaching }); // 기본 A
}

/** A/B 비교도, 일반 analyze도 이 함수 한 번으로 수행 가능 */
async function runCBTAnalysis({
  uid,
  text,
  dateKey,
  variant = 'A',
  save = true,               // compare는 false로
  conversationId = null,     // analyze에서는 넘어옴
  clientMessageId = null,
}) {
  if (!uid || !text) throw new Error('bad_params');
  const dk = (dateKey && String(dateKey).slice(0, 10)) || new Date().toISOString().slice(0, 10);

  const enableCoaching = false;     // 비교는 첫 턴 요약 기준
  const enableCorrection = true;    // ±보정 ON
  const safetyOn = false;           // 비교 때는 안전 게이트 OFF(응답 형태를 비교하려고)
  const promptOverride = selectPromptByVariant(variant, { coaching: enableCoaching });

  const { snapshot } = await analyzeMessage({
    uid,
    dateKey: dk,
    conversationId,
    userText: text,
    mode: 'admin',                 // 파이프라인 동일 적용
    enableCoaching,
    enableCorrection,
    safetyOn,
    prevSnapshot: null,
    promptOverride,
  });

  if (save) {
    await persistAnalyzeResult({
      uid,
      dateKey: dk,
      conversationId,
      clientMessageId,
      userText: text,
      result: snapshot,
    });
  }

  return { ...snapshot, usedVariant: String(variant || 'A') };
}

/** 어시스턴트 말풍선 포맷(요약 + 점수) */
function formatAssistantSummary({ dateKey, out, confidences, hf, safety }) {
  // 자해 신호가 있으면 날짜 프리픽스 없이 위기 안내만 보여줌
  if (safety?.selfHarm) {
    const crisis = (typeof safety.message === 'string' && safety.message.trim())
      ? safety.message.trim()
      : CRISIS_HELP_KO;
    return crisis; // 날짜 프리픽스 없이 그대로 저장 → 프론트 inferLooksLikeSafety가 바로 잡아냄
  }
  const emo = Array.isArray(out['감정']) ? out['감정'].filter(Boolean) : [];
  const dist = Array.isArray(out['인지왜곡']) ? out['인지왜곡'].filter(Boolean) : [];
  const coreArr = Array.isArray(out['핵심믿음']) ? out['핵심믿음'].filter(Boolean)
    : (out['핵심믿음'] ? [String(out['핵심믿음']).trim()] : []);
  const qArr = Array.isArray(out['추천질문']) ? out['추천질문'].filter(Boolean)
    : (out['추천질문'] ? [String(out['추천질문']).trim()] : []);
  const core = coreArr[0] || '';
  const q = qArr[0] || '';

  const c = confidences || {};
  const eavg = hf?.emotion?.avg;
  const eent = hf?.emotion?.entropy;
  const ent = hf?.nli?.core?.entail;
  const ctr = hf?.nli?.core?.contradict;

  return [
    `[${dateKey}]`,
    `감정: ${emo.join(', ') || '-'}`,
    `인지 왜곡: ${dist.join(', ') || '-'}`,
    `핵심 믿음: ${core || '-'}`,
    `추천 질문: ${q || '-'}`,
    '',
    '— 점수(분리 표시) —',
    `LLM 확신도 (감정/왜곡/핵심/질문): ${n2(c.emotions)} / ${n2(c.distortions)} / ${n2(c.coreBelief)} / ${n2(c.question)}`,
    `HF emotions_avg / entropy: ${n4(eavg)} / ${n4(eent)}`,
    `HF NLI entail / contradict: ${n4(ent)} / ${n4(ctr)}`,
  ].join('\n');

  function n2(x) { return (Number.isFinite(x) ? Number(x).toFixed(2) : '-'); }
  function n4(x) { return (Number.isFinite(x) ? Number(x).toFixed(4) : '-'); }
}

//** 저장 공통 경로: 멱등 upsert → snapshot은 user 메시지에만 → 캘린더 집계 */
async function persistAnalyzeResult({
  uid,
  dateKey,             // = sessionId (YYYY-MM-DD)
  conversationId,      // 필수
  clientMessageId,     // 멱등키(선택)
  userText,
  result,              // analyzeMessage/runCBTAnalysis에서 받은 snapshot
}) {
  if (!uid || !dateKey || !conversationId) throw new Error('bad_params');
  const sessionId = String(dateKey).slice(0, 10);

  // user 메시지 저장: snapshot/hf_raw 포함
  const hf_raw = result?.hf ? {
    emotion_entropy: result.hf?.emotion?.entropy ?? null,
    emotions_avg: result.hf?.emotion?.avg ?? null,
    hf_raw: result.hf,
    nli_core: {
      entail: result.hf?.nli?.core?.entail ?? null,
      contradict: result.hf?.nli?.core?.contradict ?? null,
    },
  } : null;

  await repo.addMessage({
    uid,
    sessionId,
    conversationId,
    message: {
      role: 'user',
      text: String(userText || ''),
      clientMessageId: clientMessageId || undefined,
      analysisSnapshot_v1: {
        emotions: result.emotions || [],
        distortions: result.distortions || [],
        coreBeliefs: result.coreBeliefs || [],
        recommendedQuestions: result.recommendedQuestions || [],
        ...(result.emoji ? { emoji: result.emoji } : {}),
        confidences: result.confidences || {},
        ...(result.hf ? { hf: result.hf } : {}),
        llm: result.llm || {},
        ...(result.safety ? { safety: result.safety } : {}),
      },
      hf_raw,
    },
  });

  // assistant 메시지(사람이 볼 텍스트만)
  const asstText = formatAssistantSummary({
    dateKey: sessionId,
    out: result?.llm?.output || {},
    confidences: (result?.llm?.confidences || result?.confidences || {}),
    hf: result?.hf || null,
    safety: result?.safety || null,
  });

  await repo.addMessage({
    uid,
    sessionId,
    conversationId,
    message: {
      role: 'assistant',
      text: asstText,
      lastBot: true,
      isSafety: !!(result?.safety?.selfHarm), // ← 안전문구 표시용 메타
    },
  });

  // repo.addMessage 내부에서 recomputeCalendar 호출하므로 끝.
  return { ok: true, conversationId };
}



module.exports = {
  analyzeMessage,
  analyzeWithLLMAndHF,
  runCBTAnalysis,
  persistAnalyzeResult,
};
