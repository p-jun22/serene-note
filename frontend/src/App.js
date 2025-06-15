// App.js - SPA + Firebase 인증 렌더링 + 로딩 상태 처리 + 로그아웃 버튼 추가 + 페이지 이름 변경 반영

import React, { useState, useEffect } from 'react';
import './App.css';
import ChatBot from './components/ChatBot';
import DiaryListPage from './components/DiaryListPage';
import EmotionGraphPage from './components/EmotionGraphPage';
import StrengthAnalysisPage from './components/StrengthAnalysisPage';
import Auth from './components/Auth';
import { auth } from './firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';

function App() {
  const [page, setPage] = useState('diary');
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      console.log('현재 로그인 상태:', u);
      setUser(u);
      setCheckingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  const renderPage = () => {
    switch (page) {
      case 'diary':
        return <ChatBot />;
      case 'calendar':
        return <DiaryListPage />;
      case 'hobby':
        return <EmotionGraphPage />;
      case 'travel':
        return <StrengthAnalysisPage />;
      default:
        return <ChatBot />;
    }
  };

  if (checkingAuth) return <div style={{ padding: 20 }}>인증 중...</div>;

  return (
    <div className="App">
      <header className="app-header">
        Serene Note
        {user && (
          <button
            onClick={() => signOut(auth)}
            style={{
              marginLeft: '20px',
              padding: '6px 12px',
              fontSize: '0.9rem',
              cursor: 'pointer',
              float: 'right',
              backgroundColor: '#eee',
              border: '1px solid #ccc',
              borderRadius: '6px'
            }}
          >
            로그아웃
          </button>
        )}
      </header>
      {!user ? (
        <Auth />
      ) : (
        <>
          <nav className="top-nav">
            <button onClick={() => setPage('diary')}>일기 쓰기</button>
            <button onClick={() => setPage('calendar')}>일기 목록</button>
            <button onClick={() => setPage('hobby')}>감정 그래프</button>
            <button onClick={() => setPage('travel')}>강점 분석</button>
          </nav>
          <main>{renderPage()}</main>
        </>
      )}
    </div>
  );
}

export default App;