// gptService.js - GPT 분석 + 신뢰도 계산 포함

const { ChatOpenAI } = require('@langchain/openai');
const { PromptTemplate } = require('@langchain/core/prompts');

const llm = new ChatOpenAI({
  modelName: 'gpt-4o',
  openAIApiKey: process.env.OPENAI_API_KEY
});

const template = `
다음 사용자 입력을 분석해서 아래 JSON 형식을 그대로 따르세요.

입력: {user_input}

형식:
{{
  "감정": ["감정1", "감정2"],
  "인지왜곡": ["왜곡1", "왜곡2"],
  "핵심믿음": "문장",
  "추천질문": "문장"
}}
`;

const prompt = new PromptTemplate({
  template: template,
  inputVariables: ['user_input']
});

// Plutchik + Ekman + Beck 기반 정규화
const BECK_DISTORTIONS = [
  "이분법적 사고", "과잉 일반화", "정신적 여과", "긍정적인 것 무시하기",
  "성급한 결론 도출", "확대 및 축소", "감정적 추리", "해야 한다 진술",
  "낙인찍기", "개인화", "운명화", "통제의 오류", "독심술", "예언하기", "비난"
];

const EMOTIONS_STANDARD = [
  "기쁨", "신뢰", "두려움", "놀람", "슬픔", "혐오", "분노", "기대",
  "사랑", "경악", "외로움", "절망", "수용", "애착", "불안", "좌절",
  "짜증", "증오", "자부심", "수치심", "후회", "멸시", "경멸", "흥미"
];

function calcSchemaMatch(json) {
  const 감정일치율 = json.감정.filter(e => EMOTIONS_STANDARD.includes(e)).length / json.감정.length;
  const 왜곡일치율 = json.인지왜곡.filter(e => BECK_DISTORTIONS.includes(e)).length / json.인지왜곡.length;
  return (감정일치율 + 왜곡일치율) / 2;
}

function calcConsistencyScore(json) {
  const 핵심 = json.핵심믿음;
  return json.감정.some(e => 핵심.includes(e)) ? 1 : 0.5;
}

function calcTotalScore(userScore, schemaScore, consistencyScore) {
  return (userScore * 0.4) + (schemaScore * 0.3) + (consistencyScore * 0.3);
}

async function runCBTAnalysis(userInput) {
  const promptText = await prompt.format({ user_input: userInput });
  const response = await llm.invoke(promptText);

  if (!response || !response.content) {
    throw new Error('GPT 응답이 비어 있습니다.');
  }

  let content = response.content.trim();
  if (content.startsWith("```")) {
    content = content.replace(/```json|```/g, '').trim();
  }

  try {
    const parsed = JSON.parse(content);
    const schemaScore = calcSchemaMatch(parsed);
    const consistencyScore = calcConsistencyScore(parsed);
    const totalScore = calcTotalScore(1, schemaScore, consistencyScore);
    return { ...parsed, schemaScore, consistencyScore, totalScore };
  } catch (err) {
    console.error("GPT JSON 파싱 오류:", err);
    console.log("GPT 원본 응답:", content);
    throw new Error('GPT 응답 형식 오류 발생');
  }
}

module.exports = { runCBTAnalysis };