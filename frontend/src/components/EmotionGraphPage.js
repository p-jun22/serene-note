// components/EmotionGraphPage.js
import React, { useEffect, useState } from 'react';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

const EmotionGraphPage = () => {
  const [summary, setSummary] = useState({ positive: 0, negative: 0 });

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const snapshot = await getDocs(collection(db, 'user_feedback', user.uid, 'entries'));
        const data = snapshot.docs.map(doc => doc.data());

        const result = data.reduce(
          (acc, entry) => {
            entry.감정?.forEach(e => {
              if (["기쁨", "감사", "편안함", "행복"].includes(e)) acc.positive++;
              else acc.negative++;
            });
            return acc;
          },
          { positive: 0, negative: 0 }
        );

        setSummary(result);
      }
    });
    return () => unsubscribe();
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h2>감정 그래프</h2>
      <div style={{ fontSize: '18px' }}>
        <p><b>긍정 감정:</b> {summary.positive}</p>
        <p><b>부정 감정:</b> {summary.negative}</p>
      </div>
    </div>
  );
};

export default EmotionGraphPage;
