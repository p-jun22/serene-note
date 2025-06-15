// src/components/DiaryListPage.js
import React, { useEffect, useState } from 'react';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

const DiaryListPage = () => {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const snapshot = await getDocs(collection(db, 'user_feedback', user.uid, 'entries'));
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        data.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        setEntries(data);
      }
    });
    return () => unsubscribe();
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h2>📘 일기 목록</h2>
      {entries.map(entry => (
        <div key={entry.id} style={{ marginBottom: '16px', padding: '10px', border: '1px solid #ccc' }}>
          <strong>{new Date(entry.timestamp).toLocaleString()}</strong>
          <div><b>감정:</b> {entry.감정?.join(', ')}</div>
          <div><b>핵심믿음:</b> {entry.핵심믿음}</div>
          <div><b>추천질문:</b> {entry.추천질문}</div>
        </div>
      ))}
    </div>
  );
};

export default DiaryListPage;
