// components/StrengthAnalysisPage.js
import React, { useEffect, useState } from 'react';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const extractStrengthsAndWeaknesses = (beliefs) => {
  const strengths = [];
  const weaknesses = [];

  beliefs.forEach(belief => {
    if (
      belief.includes('노력') ||
      belief.includes('책임') ||
      belief.includes('도움') ||
      belief.includes('가치') ||
      belief.includes('성장')
    ) strengths.push(belief);
    else weaknesses.push(belief);
  });

  return { strengths, weaknesses };
};

const StrengthAnalysisPage = () => {
  const [chartData, setChartData] = useState(null);

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const snapshot = await getDocs(collection(db, 'user_feedback', user.uid, 'entries'));
        const data = snapshot.docs.map(doc => doc.data());

        const grouped = {};
        data.forEach(entry => {
          if (!entry.핵심믿음 || !entry.timestamp) return;
          const date = new Date(entry.timestamp).toLocaleDateString();
          if (!grouped[date]) grouped[date] = { strengths: 0, weaknesses: 0 };

          const { strengths, weaknesses } = extractStrengthsAndWeaknesses([entry.핵심믿음]);
          grouped[date].strengths += strengths.length;
          grouped[date].weaknesses += weaknesses.length;
        });

        const sortedDates = Object.keys(grouped).sort();
        const strengthsData = sortedDates.map(date => grouped[date].strengths);
        const weaknessesData = sortedDates.map(date => grouped[date].weaknesses);

        setChartData({
          labels: sortedDates,
          datasets: [
            {
              label: '강점',
              data: strengthsData,
              borderColor: '#4caf50',
              backgroundColor: '#4caf50',
              tension: 0.3,
              pointStyle: 'circle',
              pointRadius: 5,
              pointHoverRadius: 7,
            },
            {
              label: '약점',
              data: weaknessesData,
              borderColor: '#f44336',
              backgroundColor: '#f44336',
              tension: 0.3,
              pointStyle: 'rectRot',
              pointRadius: 5,
              pointHoverRadius: 7,
            }
          ]
        });
      }
    });
    return () => unsubscribe();
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h2>강점과 약점 분석 (시간 흐름)</h2>
      {chartData ? (
        <Line
          data={chartData}
          options={{
            responsive: true,
            plugins: {
              legend: { position: 'top' },
              title: { display: true, text: '날짜별 강점 vs 약점 변화' },
            },
          }}
        />
      ) : (
        <p>불러오는 중...</p>
      )}
    </div>
  );
};

export default StrengthAnalysisPage;