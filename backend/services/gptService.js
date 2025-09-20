// backend/gptService.js
const { ChatOpenAI } = require('@langchain/openai');
const { PromptTemplate } = require('@langchain/core/prompts');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.warn('[gptService] OPENAI_API_KEY 미설정: 서버 구동은 되지만, 호출 시 500을 반환합니다.');
}

const llm = new ChatOpenAI({
  modelName: MODEL,
  openAIApiKey: API_KEY,
  temperature: 0.2,
});

const template = `
반드시 아래 JSON 형식을 그대로 따르세요.
- 설명 추가 금지
- 코드블럭 사용 금지
- key 순서 유지
형식:
{{
  "감정": ["감정1", "감정2"],
  "인지왜곡": ["왜곡1", "왜곡2"],
  "핵심믿음": "문장",
  "추천질문": "문장"
}}

입력: {user_input}
`;

const prompt = new PromptTemplate({
  template,
  inputVariables: ['user_input'],
});

async function runCBTAnalysis(userInput) {
  if (!API_KEY) {
    const e = new Error('OPENAI_API_KEY not set');
    e.code = 'NO_API_KEY';
    throw e;
  }

  const promptText = await prompt.format({ user_input: userInput });
  const response = await llm.invoke(promptText);

  if (!response || !response.content) throw new Error('GPT 응답이 비어 있습니다.');

  let content = String(response.content).trim();
  if (content.startsWith('```')) content = content.replace(/```json|```/g, '').trim();

  // ✅ JSON 파싱 시 폴백
  try {
    const parsed = JSON.parse(content);
    // 최소 필드 보정
    return {
      감정: Array.isArray(parsed.감정) ? parsed.감정 : (parsed.감정 ? [parsed.감정] : []),
      인지왜곡: Array.isArray(parsed.인지왜곡) ? parsed.인지왜곡 : (parsed.인지왜곡 ? [parsed.인지왜곡] : []),
      핵심믿음: typeof parsed.핵심믿음 === 'string' ? parsed.핵심믿음 : '',
      추천질문: typeof parsed.추천질문 === 'string' ? parsed.추천질문 : '',
    };
  } catch (err) {
    console.error('GPT JSON 파싱 오류:', err);
    console.log('GPT 원본 응답:', content);
    // 폴백: 비정형 응답이라도 UI가 죽지 않도록
    return {
      감정: [],
      인지왜곡: [],
      핵심믿음: '',
      추천질문: (content || '').slice(0, 500),
    };
  }
}

module.exports = { runCBTAnalysis };
