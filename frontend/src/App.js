// App.js — 캘린더(클릭→글쓰기), 기록 아카이브(메인 탭), 감정 그래프, 정확도 분석, 강점·약점, 공유

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { auth } from './firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import './App.css';

import Auth from './components/Auth';
import CalendarPage from './components/CalendarPage';
import EmotionGraphPage from './components/EmotionGraphPage';
import AccuracyAnalysis from './components/AccuracyAnalysis';
import StrengthWeaknessPage from './components/StrengthWeaknessPage';
// import SharePage from './components/SharePage';
import ChatBot from './components/ChatBot';
import DiaryListPage from './components/DiaryListPage';

export default function App() {
  const [page, setPage] = useState('calendar');
  // 'calendar' | 'archive' | 'graph' | 'accuracy' | 'analysis' | 'share'
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // 캘린더에서 "일기 쓰기" 선택 시 세워지는 상태
  const [selectedDate, setSelectedDate] = useState(null);

  // 공통 리셋 함수
  const resetAppState = useCallback(() => {
    setPage('calendar');
    setSelectedDate(null);
    // 필요하면 캐시/임시 상태도 같이 정리
    // sessionStorage.removeItem('emotionGraphCache');
  }, []);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setCheckingAuth(false);
    });
    return () => unsub();
  }, []);

  // 인증 상태 변화 시 처리
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
      } else {
        setUser(null);
        resetAppState(); // ← 로그아웃 시 라우팅/상태 초기화
      }
      setCheckingAuth(false);
    });
    return () => unsub();
  }, [resetAppState]);

  //  로그아웃 버튼 동작도 방어적으로 초기화
  const handleSignOut = useCallback(async () => {
    try { await signOut(auth); } finally { resetAppState(); }
  }, [resetAppState]);


  const renderPage = useMemo(() => {
    if (page === 'calendar') {
      if (selectedDate) {
        return <ChatBot key={`chat-${user?.uid || 'anon'}`}
          date={selectedDate}
          onBack={() => setSelectedDate(null)} />;
      }
      return <CalendarPage key={`cal-${user?.uid || 'anon'}`}
        onWrite={(date) => setSelectedDate(date)} />;
    }
    if (page === 'archive') return <DiaryListPage key={`arch-${user?.uid || 'anon'}`} />;
    if (page === 'graph') return <EmotionGraphPage key={`graph-${user?.uid || 'anon'}`} includeStrengthGraph={true} />;
    if (page === 'accuracy') return <AccuracyAnalysis key={`acc-${user?.uid || 'anon'}`} />;
    if (page === 'analysis') return <StrengthWeaknessPage key={`ana-${user?.uid || 'anon'}`} includeOnlyAnalysis={true} />;
    // if (page === 'share') return <SharePage key={`share-${user?.uid || 'anon'}`} />;
    return <CalendarPage key={`cal-${user?.uid || 'anon'}`} onWrite={(date) => setSelectedDate(date)} />;
  }, [page, selectedDate, user?.uid]);

  if (checkingAuth) return <div style={{ padding: 20 }}>인증 중...</div>;

  const Tab = ({ id, children }) => (
    <button
      className={`tab ${page === id ? 'active' : ''}`}
      onClick={() => {
        setSelectedDate(null);
        setPage(id);
      }}
      aria-current={page === id ? 'page' : undefined}
    >
      {children}
    </button>
  );

  return (
    <div className="App">
      <header className="app-header">
        <div className="brand">
          <div className="title">Serene Note</div>
          <div className="subtitle">AI 기반 인지행동치료 노트</div>
        </div>
        {user && (
          <button
            onClick={handleSignOut}
            className="ghost-btn"
            aria-label="로그아웃"
            title="로그아웃"
          >
            로그아웃
          </button>
        )}
      </header>

      {!user ? (
        <Auth />
      ) : (
        <>
          <nav className="top-nav" role="tablist" aria-label="주요 페이지">
            <Tab id="calendar">캘린더</Tab>
            <Tab id="archive">기록 보기</Tab>
            <Tab id="graph">감정 그래프</Tab>
            <Tab id="accuracy">정합·정확도 분석</Tab>
            <Tab id="analysis">정합·정확도 평가</Tab>
            {/* <Tab id="share">공유</Tab> */}
          </nav>
          <main>{renderPage}</main>
        </>
      )}
    </div>
  );
}
