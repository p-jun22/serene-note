// src/components/emoji.js
// 공통 이모지 유틸/컴포넌트 (빈날은 렌더링하지 않음)

export const EMOJI_MAP = {
  '행복':'😊','기쁨':'😊','즐거움':'😊','만족':'🙂',
  '사랑':'🥰','설렘':'🤩','기대':'🤩',
  '평온':'😌','안정':'😌','중립':'😐',
  '불안':'😟','걱정':'😟','초조':'😟','두려움':'😨','공포':'😨',
  '슬픔':'😢','우울':'😞','상실':'😢',
  '분노':'😠','짜증':'😠','화':'😠',
  '수치심':'😳','부끄러움':'😳',
  '피곤':'🥱','지침':'🥱',
};

export function pickEmojiFromLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  for (const raw of labels) {
    const k = String(raw || '').trim();
    if (k && EMOJI_MAP[k]) return EMOJI_MAP[k];
  }
  return null;
}

/** 캘린더 summary(row) → 이모지 결정(top → last → 라벨 유추) */
export function emojiFromSessionSummary(row) {
  if (!row) return null;
  const direct = row.topEmoji || row.lastEmoji || null;
  if (direct) return direct;
  return pickEmojiFromLabels(row.moodLabels || []);
}

/** 라벨/직접 이모지 중 하나로 렌더. 없으면 null(아무것도 안보임) */
export default function Emoji({ labels, emoji, title, size = 16, style }) {
  const e = emoji || pickEmojiFromLabels(labels);
  if (!e) return null;
  return <span style={{ fontSize: size, lineHeight: 1, ...style }} title={title || ''} aria-hidden>{e}</span>;
}
