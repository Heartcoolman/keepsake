import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

export function ChatOverlay({ fading = false }: { fading?: boolean }) {
  const messages = useAppStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const lastContent = messages[messages.length - 1]?.content;

  // a new message always snaps to the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  // streaming growth sticks to the bottom — unless the user scrolled up to read
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastContent]);

  return (
    <div className={`chat-overlay${fading ? ' chat-overlay--fading' : ''}`}>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m, i) =>
          m.role === 'assistant' ? (
            <div key={i} className="msg msg-ai">
              {m.content || <span className="typing-dots">· · ·</span>}
            </div>
          ) : (
            <div key={i} className="msg msg-user">
              {m.content}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
