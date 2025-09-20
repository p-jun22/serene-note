import React, { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

const StrengthWeaknessPage = () => {
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStrength = async () => {
      try {
        const auth = getAuth();
        const user = auth.currentUser;
        if (!user) return;

        const res = await fetch('http://localhost:5001/api/analyze-strength', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '나는 요즘 자주 외롭고, 사람들과 어울리기 힘들다고 느껴.' })  // ← 임시 입력 예시
        });

        const data = await res.json();
        console.log('[강점 분석 결과]', data);

        if (data && data.summary) {
          setSummary(data.summary);
        } else {
          setSummary('분석 결과가 없습니다.');
        }
      } catch (err) {
        console.error('분석 중 오류 발생:', err);
        setSummary('오류가 발생했습니다.');
      } finally {
        setLoading(false);
      }
    };

    fetchStrength();
  }, []);

  return (
    <div style={{ padding: 40 }}>
      <h2>강점/약점 분석 결과</h2>
      <p><strong>요약:</strong></p>
      <p>{loading ? '분석 중입니다...' : summary}</p>
    </div>
  );
};

export default StrengthWeaknessPage;
