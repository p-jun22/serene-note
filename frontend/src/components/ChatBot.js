// ChatBot.js - GPT 결과 + 감정 시각화 + 일기 나열 확장

import React, { useState, useEffect } from 'react';
import axios from 'axios';
import Message from './Message';
import EmotionExplanation from './EmotionExplanation';
import { getAuth, onAuthStateChanged } from 'firebase/auth';

const ChatBot = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [lastResponse, setLastResponse] = useState(null);
  const [showScore, setShowScore] = useState(false);
  const [scoreSubmitted, setScoreSubmitted] = useState(false);
  const [uid, setUid] = useState(null);
  const [diaryData, setDiaryData] = useState([]);

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUid(user ? user.uid : null);
    });
    return () => unsubscribe();
  }, []);

  const handleSend = async () => {
    if (!input.trim()) return;
    const userMessage = { sender: 'user', text: input };
    setMessages(prev => [...prev, userMessage]);

    try {
      const res = await axios.post('http://localhost:5000/api/gpt', { input });
      const { 감정, 인지왜곡, 핵심믿음, 추천질문, schemaScore, consistencyScore, totalScore } = res.data;

      const botText = `
감정: ${감정.join(', ')}
인지 왜곡: ${인지왜곡.join(', ')}
핵심 믿음: ${핵심믿음}
추천 질문: ${추천질문}

(GPT 신뢰도 지표)
- 스키마 일치도: ${schemaScore}
- 일관성 점수: ${consistencyScore}
- 통합 신뢰도: ${totalScore}
`;

      setMessages(prev => [...prev, { sender: 'bot', text: botText }]);
      setLastResponse({ input, response: res.data });
      setShowScore(true);
      setScoreSubmitted(false);

      // 일기 데이터 저장
      const now = new Date();
      const diaryEntry = {
        date: now.toLocaleDateString(),
        emotion: 감정,
        full: res.data
      };
      setDiaryData(prev => [...prev, diaryEntry]);

    } catch (err) {
      setMessages(prev => [...prev, { sender: 'bot', text: '오류가 발생했어요!' }]);
    }

    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSend();
  };

  const handleScore = async (score) => {
    if (!lastResponse || scoreSubmitted || !uid) return;
    const timestamp = new Date().toISOString();
    await axios.post('http://localhost:5000/api/score', {
      uid,
      input: lastResponse.input,
      score,
      response: lastResponse.response,
      timestamp
    });
    setShowScore(false);
    setScoreSubmitted(true);
  };

  return (
    <div className="chat-container">
      <div className="chat-box">
        {messages.map((msg, idx) => (
          <Message key={idx} sender={msg.sender} text={msg.text} />
        ))}

        {showScore && !scoreSubmitted && (
          <div className="score-area">
            <p>이 분석이 당신에게 얼마나 잘 맞나요? (1~5점)</p>
            {[1, 2, 3, 4, 5].map((v) => (
              <button key={v} onClick={() => handleScore(v)}>{v}</button>
            ))}
          </div>
        )}

        {lastResponse && (
          <EmotionExplanation
            input={lastResponse.input}
            gptEmotions={lastResponse.response.감정}
          />
        )}
      </div>

      <div className="input-area">
        <input
          type="text"
          placeholder="고민을 입력하세요."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button onClick={handleSend}>전송</button>
      </div>

      <DiaryList diaryData={diaryData} />
      <EmotionGraph diaryData={diaryData} />
    </div>
  );
};

const DiaryList = ({ diaryData }) => (
  <div style={{ margin: '20px' }}>
    <h3>📘 일기 목록</h3>
    {diaryData.map((entry, idx) => (
      <div key={idx}>
        <strong>{entry.date}</strong>: {entry.emotion.join(', ')}
      </div>
    ))}
  </div>
);

const EmotionGraph = ({ diaryData }) => {
  const summary = diaryData.reduce(
    (acc, entry) => {
      entry.emotion.forEach(e => {
        if (["기쁨", "감사", "편안함", "행복"].includes(e)) acc.positive += 1;
        else acc.negative += 1;
      });
      return acc;
    },
    { positive: 0, negative: 0 }
  );

  return (
    <div style={{ margin: '20px' }}>
      <h3>📊 감정 그래프</h3>
      <div>긍정적 감정: {summary.positive}</div>
      <div>부정적 감정: {summary.negative}</div>
    </div>
  );
};

export default ChatBot;
