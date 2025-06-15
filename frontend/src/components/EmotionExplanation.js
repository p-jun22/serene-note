// EmotionExplanation.js - 감정 키워드 어근 기반 강조 및 GPT 비교

import React from 'react';

const colorMap = {
  슬픔: '#cce5ff',
  불안: '#ffeeba',
  분노: '#f8d7da',
  기쁨: '#d4edda',
  혐오: '#f5c6cb',
  놀람: '#d1ecf1',
  신뢰: '#e2e3e5',
  기대: '#fff3cd',
  사랑: '#fce4ec',
  외로움: '#e8eaf6',
  자부심: '#f3e5f5',
  수치심: '#f8bbd0',
  후회: '#d7ccc8',
  경멸: '#cfd8dc',
  흥미: '#e6ee9c'
};

const emotionKeywords = {
  슬픔: ['슬픔', '슬프', '우울', '눈물', '절망', '상실', '허무'],
  불안: ['불안', '초조', '떨림', '긴장', '예측불가', '두렵', '불확실'],
  분노: ['분노', '짜증', '화', '증오', '억울', '분개', '참을 수 없'],
  기쁨: ['기쁨', '행복', '좋', '기쁘', '웃음', '설레', '감사', '만족'],
  혐오: ['혐오', '역겨움', '싫', '불쾌', '거부', '질색'],
  놀람: ['놀람', '놀라', '깜짝', '경악', '충격'],
  신뢰: ['신뢰', '안심', '믿음', '안정감', '의지', '든든'],
  기대: ['기대', '희망', '바라', '기다림', '계획', '고대'],
  사랑: ['사랑', '좋아', '그립', '애정'],
  외로움: ['외로움', '외롭'],
  자부심: ['자부심', '자랑스럽', '뿌듯', '당당'],
  수치심: ['수치심', '부끄럽', '민망', '창피'],
  후회: ['후회', '잘못했', '되돌리'],
  경멸: ['경멸', '멸시'],
  흥미: ['흥미', '관심', '재미']
};

const EmotionExplanation = ({ input, gptEmotions }) => {
  const scoreTable = {};
  const matchedKeywords = {};
  let highlighted = input;

  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    scoreTable[emotion] = 0;
    matchedKeywords[emotion] = [];

    keywords.forEach((kw) => {
      if (input.includes(kw)) {
        const reg = new RegExp(kw, 'g');
        highlighted = highlighted.replace(
          reg,
          `<mark style="background-color:${colorMap[emotion] || '#ddd'}">${kw}</mark>`
        );
        scoreTable[emotion]++;
        matchedKeywords[emotion].push(kw);
      }
    });
  }

  const totalMatched = Object.values(scoreTable).reduce((a, b) => a + b, 0);
  const gptScore = gptEmotions.reduce((acc, emotion) => acc + (scoreTable[emotion] || 0), 0);
  const matchRatio = totalMatched ? Math.round((gptScore / totalMatched) * 100) : 0;

  return (
    <div style={{ padding: 20 }}>
      <h3>사용자 입력 문장</h3>
      <p
        style={{ fontSize: '1.1rem', background: '#f9f9f9', padding: 10, borderRadius: 8 }}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />

      <h3>GPT 감정 판단: {gptEmotions.join(', ')}</h3>
      <h4>감정 매칭 일치율: {matchRatio}%</h4>

      <h3>감정 근거 분석 표</h3>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ borderBottom: '1px solid #ccc' }}>감정</th>
            <th style={{ borderBottom: '1px solid #ccc' }}>점수</th>
            <th style={{ borderBottom: '1px solid #ccc' }}>매칭된 키워드</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(scoreTable).map(([emotion, score]) =>
            score > 0 ? (
              <tr key={emotion}>
                <td>{emotion}</td>
                <td>{score}</td>
                <td>{matchedKeywords[emotion].join(', ')}</td>
              </tr>
            ) : null
          )}
        </tbody>
      </table>
    </div>
  );
};

export default EmotionExplanation;