// App.js — 메인 탭 4개(캘린더 / 감정 그래프 / 강점·약점 / 공유)
// "기록 보기" → DiaryArchivePage(월간)로 열고, 해당 날짜 auto-expand/scroll.

import React, { useEffect, useMemo, useState } from 'react';
import './App.css';

import Auth from './components/Auth';
import CalendarPage from './components/CalendarPage';
import EmotionGraphPage from './components/EmotionGraphPage';
import StrengthWeaknessPage from './components/StrengthWeaknessPage';
import SharePage from './components/SharePage';
import ChatBot from './components/ChatBot';
import DiaryListPage from './components/DiaryListPage';

import { auth } from './firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';

export default function App() {
  const [page, setPage] = useState('calendar');     // 'calendar' | 'graph' | 'analysis' | 'share'
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // 캘린더에서 "일기 쓰기" 선택 시 세워지는 상태
  const [selectedDate, setSelectedDate] = useState(null);

  // 캘린더에서 "기록 보기" 눌렀을 때 상태(이제 월간 아카이브로 연결)
  const [viewDate, setViewDate] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setCheckingAuth(false);
    });
    return () => unsub();
  }, []);

  const renderPage = useMemo(() => {
    if (page === 'calendar') {
      if (selectedDate) {
        return <ChatBot date={selectedDate} onBack={() => setSelectedDate(null)} />;
      }
      if (viewDate) {
        // ✅ 월간 아카이브로 변경(해당 날짜 auto-expansion)
        return (
          <DiaryListPage
            focusDate={viewDate}
            onBack={() => setViewDate(null)}
          />
        );
      }
      return (
        <CalendarPage
          onWrite={(date) => setSelectedDate(date)}
          onView={(date) => setViewDate(date)}
        />
      );
    }
    if (page === 'graph') return <EmotionGraphPage includeStrengthGraph={true} />;
    if (page === 'analysis') return <StrengthWeaknessPage includeOnlyAnalysis={true} />;
    if (page === 'share') return <SharePage />;
    return (
      <CalendarPage
        onWrite={(date) => setSelectedDate(date)}
        onView={(date) => setViewDate(date)}
      />
    );
  }, [page, selectedDate, viewDate]);

  if (checkingAuth) return <div style={{ padding: 20 }}>인증 중...</div>;

  const Tab = ({ id, children }) => (
    <button
      className={`tab ${page === id ? 'active' : ''}`}
      onClick={() => {
        setSelectedDate(null);
        setViewDate(null);
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
          <div className="subtitle">AI 기반 인지행동치료 저널</div>
        </div>
        {user && (
          <button
            onClick={() => signOut(auth)}
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
            <Tab id="graph">감정 그래프</Tab>
            <Tab id="analysis">강점·약점</Tab>
            <Tab id="share">공유</Tab>
          </nav>
          <main>{renderPage}</main>
        </>
      )}
    </div>
  );
}
