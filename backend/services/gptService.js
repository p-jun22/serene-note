// backend/services/gptService.js
// ─────────────────────────────────────────────────────────────────────────────
// [역할]
// - 사용자 입력에 대해 ① LLM 1패스 추출(Stage-1), ② HF(Flask) 보조 시그널 호출,
//   ③ (조건부) Stage-2 보정, ④ 콜드스타트 캡(min(final_conf, 0.85)) 적용,
//   ⑤ 표준 스냅샷(analysisSnapshot_v1)으로 반환.
// - 스키마/키 이름은 "자가 경계 프롬프트" 명세를 그대로 따른다.
//   (emotions/distortions/coreBeliefs/recommendedQuestions/emoji/confidences/...)
// - assistant 메시지에는 이 스냅샷을 절대 저장하지 않는다(라우터에서 이미 차단).
//
// [환경]
// - DEMO_MODE=1 이면 LLM 호출은 데모 스텁 결과를 사용한다.
// - HF 서버는 HF_BASE_URL 또는 HF_SERVER로 지정한다.
//
// [반환 스냅샷 표준]
// analysisSnapshot_v1 = {
//   emotions: [...], distortions: [...], coreBeliefs: [...], recommendedQuestions: [...],
//   emoji: "😊",
//   confidences: { emotions, distortions, coreBelief, question, final_capped },
//   hf: { emotion: { avg, entropy }, nli: { core: { entail, contradict } } },
//   llm: { text, output:{감정,인지왜곡,핵심믿음,추천질문}, confidences:{...} }
// }
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

const HF_BASE = process.env.HF_BASE_URL || process.env.HF_SERVER || 'http://127.0.0.1:5001';
const DEMO = process.env.DEMO_MODE === '1';

// ★ 실모델 환경변수
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

/* ─────────────────────────────────────────────
   공용 유틸
───────────────────────────────────────────── */

/** 0~1 범위로 안전 보정 */
const clip01 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.0;
  if (n < 0) return 0.0;
  if (n > 1) return 1.0;
  return +n;
};

/** 콜드스타트 캡: final_conf 상한 0.85 고정(프로젝트 규칙) */
const coldStartCap = (x) => Math.min(clip01(x), 0.85);

/** 이모지 간단 매핑 (라벨 우선순위 스캔) */
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

/* ─────────────────────────────────────────────
   Stage-1: LLM 1패스 추출
   - DEMO_MODE=1 이면 데모 결과
   - 그 외: OpenAI Chat Completions(JSON Mode) 실제 호출
───────────────────────────────────────────── */
function assertOpenAIEnv() {
  if (!OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY missing');
    e.code = 'env_openai_missing';
    throw e;
  }
}
function buildSystemPrompt() {
  // 출력은 반드시 JSON(객체). 스키마 키 한글 라벨 유지.
  return [
    '너는 심리/CBT 보조 분석기다.',
    '입력 텍스트에서 다음을 JSON으로만 출력한다:',
    '- "감정": 문자열 배열',
    '- "인지왜곡": 문자열 배열',
    '- "핵심믿음": 문자열(없으면 빈 문자열)',
    '- "추천질문": 문자열(없으면 빈 문자열)',
    '- "confidences": { "emotions":0~1, "distortions":0~1, "coreBelief":0~1, "question":0~1 }',
    '추가 텍스트 금지. 코드블록 금지. 반드시 단일 JSON 객체.'
  ].join('\n');
}

async function runLLM(userText) {
  if (DEMO) {
    // (데모) 눈으로 확인 가능한 결과 예시
    return {
      text: `요약 응답(데모): ${String(userText || '').slice(0, 40)}`,
      output: {
        '감정': ['우울'],
        '인지왜곡': ['흑백논리'],
        '핵심믿음': '나는 가치없다',
        '추천질문': '이 생각을 뒷받침하는 증거는 무엇인가요?'
      },
      confidences: { emotions: 0.9, distortions: 0.2, coreBelief: 0.85, question: 0.75 }
    };
  }

  // 실제 모델 호출(OpenAI Chat Completions + JSON Mode)
  assertOpenAIEnv();

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' }, // JSON Mode 강제
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: String(userText || '').slice(0, 8000) }
    ]
  };

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    payload,
    {
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content || '{}';

  // 방어적 파싱: JSON 아닌 경우를 한 번 더 시도
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_e) {
    const m = raw.match(/\{[\s\S]*\}$/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  // 스키마 기본값 채우기(누락 방지)
  return {
    text: '', // llm.text는 남겨두되, 실제 표시문은 프론트에서 조합
    output: {
      '감정': Array.isArray(parsed['감정']) ? parsed['감정'] : [],
      '인지왜곡': Array.isArray(parsed['인지왜곡']) ? parsed['인지왜곡'] : [],
      '핵심믿음': typeof parsed['핵심믿음'] === 'string' ? parsed['핵심믿음'] : '',
      '추천질문': typeof parsed['추천질문'] === 'string' ? parsed['추천질문'] : ''
    },
    confidences: {
      emotions: clip01(parsed?.confidences?.emotions ?? 0.6),
      distortions: clip01(parsed?.confidences?.distortions ?? 0.5),
      coreBelief: clip01(parsed?.confidences?.coreBelief ?? 0.5),
      question: clip01(parsed?.confidences?.question ?? 0.5),
    }
  };
}

/* ─────────────────────────────────────────────
   HF(Flask) 보조 시그널 호출
   - 실패 시 null 반환(상위에서 안전 처리)
───────────────────────────────────────────── */
async function runHFSignals(userText) {
  try {
    const r = await axios.post(`${HF_BASE}/scores`, { text: userText }, { timeout: 20000 });
    // 기대 스키마: { emotions_avg, emotion_entropy, nli_core:{ entail, contradict }, ... }
    return r.data || null;
  } catch (_e) {
    return null;
  }
}

/* ─────────────────────────────────────────────
   Stage-1 조립(LLM+HF) → 표준 스냅샷
───────────────────────────────────────────── */
async function analyzeWithLLMAndHF(userText) {
  const llm = await runLLM(userText);
  const hf_raw = await runHFSignals(userText);

  // LLM → 표준화
  const emotions = Array.isArray(llm?.output?.['감정']) ? llm.output['감정'] : [];
  const distortions = Array.isArray(llm?.output?.['인지왜곡']) ? llm.output['인지왜곡'] : [];
  const coreBelief = llm?.output?.['핵심믿음'] ? [llm.output['핵심믿음']] : [];
  const questions = llm?.output?.['추천질문'] ? [llm.output['추천질문']] : [];

  const llmConf = {
    emotions: clip01(llm?.confidences?.emotions),
    distortions: clip01(llm?.confidences?.distortions),
    coreBelief: clip01(llm?.confidences?.coreBelief),
    question: clip01(llm?.confidences?.question),
  };

  // HF → 표준화(있으면)
  const hf = hf_raw ? {
    emotion: {
      avg: clip01(
        hf_raw?.emotions_avg ??
        hf_raw?.hf_scores?.emotions_avg ??
        hf_raw?.emotion?.avg
      ),
      entropy: clip01(
        hf_raw?.emotion_entropy ??
        hf_raw?.hf_scores?.emotion_entropy ??
        hf_raw?.emotion?.entropy
      ),
    },
    nli: {
      core: {
        entail: clip01(
          hf_raw?.nli_core?.entail ??
          hf_raw?.nli?.core?.entail
        ),
        contradict: clip01(
          hf_raw?.nli_core?.contradict ??
          hf_raw?.nli?.core?.contradict
        ),
      }
    }
  } : undefined;

  // 1차 스냅샷(아직 Stage-2/캡 이전)
  const snapshot = {
    emotions,
    distortions,
    coreBeliefs: coreBelief,
    recommendedQuestions: questions,
    // confidences는 Stage-2/캡 계산 후에 완성(final_capped 포함)
    emoji: pickEmojiFromLabels(emotions),
    ...(hf ? { hf } : {}),
    llm: {
      text: llm?.text || '',
      output: llm?.output || {},
      confidences: { ...llmConf }
    }
  };

  return { snapshot, llmConf, hf_raw };
}

/* ─────────────────────────────────────────────
   Stage-2 보정(두 번째 user부터)
   - 엔트레일 신호(hf.nli.core.entail)를 약하게 가산(상한 0.1)
   - 없는 값은 그대로 유지(0 가산)
───────────────────────────────────────────── */
function applyStage2Adjust(conf, hf) {
  const entail = clip01(hf?.nli?.core?.entail ?? 0);
  const boost = Math.min(0.1, entail * 0.05); // 최대 +0.1
  return {
    emotions: clip01((conf.emotions ?? 0) + boost),
    distortions: clip01((conf.distortions ?? 0) + boost),
    coreBelief: clip01((conf.coreBelief ?? 0) + boost),
    question: clip01(conf.question ?? 0.5),
    _final_raw: Math.min(1, ((conf.emotions ?? 0) + (conf.distortions ?? 0) + (conf.coreBelief ?? 0)) / 3 + boost / 3),
  };
}

/* ─────────────────────────────────────────────
   API 표면: analyzeMessage
   - enableStage2=true 이면 Stage-2 보정 수행
   - 최종 confidences에 final_capped 추가(콜드스타트 캡)
   - 반환: { snapshot, hf_raw, usedPrompts }
───────────────────────────────────────────── */
async function analyzeMessage({ uid, dateKey, conversationId, userText, enableStage2 }) {
  // 1) Stage-1 조립
  const { snapshot, llmConf, hf_raw } = await analyzeWithLLMAndHF(userText);

  // 2) Stage-2 (두 번째 user부터)
  let conf = { ...llmConf };
  if (enableStage2) {
    conf = applyStage2Adjust(llmConf, snapshot.hf);
  } else {
    // _final_raw는 Stage-2 미적용 시 평균으로 계산
    conf._final_raw = ((llmConf.emotions || 0) + (llmConf.distortions || 0) + (llmConf.coreBelief || 0)) / 3;
  }

  // 3) 콜드스타트 캡
  const final_capped = coldStartCap(conf._final_raw);

  // 4) 스냅샷에 최종 confidences 씌우기(스키마 고정 키)
  snapshot.confidences = {
    emotions: conf.emotions,
    distortions: conf.distortions,
    coreBelief: conf.coreBelief,
    question: conf.question,
    final_capped,
  };

  // 5) 사용 프롬프트/단계 기록(디버깅용, 프론트 표시에는 영향 없음)
  const usedPrompts = {
    stage1: 'extract emotions/distortions/coreBelief/questions (ko)',
    ...(enableStage2 ? { stage2: 'confidence adjust by NLI entail (weak boost ≤ 0.1)' } : {}),
    // calibrate: '← 필요 시 여기에 추가',
  };

  return { snapshot, usedPrompts, hf_raw };
}

module.exports = {
  analyzeWithLLMAndHF,
  analyzeMessage,
};
