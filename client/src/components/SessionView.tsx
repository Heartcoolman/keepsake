import { useAppStore } from '../store/useAppStore';
import { ChatOverlay } from './ChatOverlay';
import { DiaryView } from './DiaryView';
import { FaceChips } from './FaceChips';
import { MemoryDate } from './MemoryDate';
import { VoiceInput } from './VoiceInput';

export function SessionView() {
  const phase = useAppStore((s) => s.phase);
  const sessionTab = useAppStore((s) => s.sessionTab);
  const textHidden = useAppStore((s) => s.textHidden);
  const interimText = useAppStore((s) => s.interimText);
  const busy = useAppStore((s) => s.busy);
  const hasUserMsg = useAppStore((s) => s.messages.some((m) => m.role === 'user'));
  const backToTimeline = useAppStore((s) => s.backToTimeline);
  const setSessionTab = useAppStore((s) => s.setSessionTab);
  const toggleTextHidden = useAppStore((s) => s.toggleTextHidden);
  const generateDiary = useAppStore((s) => s.generateDiary);

  const showDiaryUI = phase === 'revealing' || phase === 'done';
  const chatting = phase === 'chatting';
  // a finished memory reopens its chat from the 对话 tab — send more, then re-condense
  const canChat = chatting || (phase === 'done' && sessionTab === 'chat');
  // date editor on chat side so undiarized entries can still fix time
  const showSessionDate =
    chatting || (showDiaryUI && sessionTab === 'chat') || phase === 'analyzing';

  return (
    <div className="session">
      <button className="icon-btn back-btn" title="回到时光轴" onClick={backToTimeline}>
        ←
      </button>

      {showDiaryUI && (
        <div className="tab-bar">
          <button
            className={`tab ${sessionTab === 'diary' ? 'tab--active' : ''}`}
            onClick={() => setSessionTab('diary')}
          >
            日记
          </button>
          <button
            className={`tab ${sessionTab === 'chat' ? 'tab--active' : ''}`}
            onClick={() => setSessionTab('chat')}
          >
            对话
          </button>
        </div>
      )}

      {showSessionDate && <MemoryDate className="session-memory-date" />}

      {chatting && (
        <button className="subtitle-toggle" onClick={toggleTextHidden}>
          {textHidden ? '字幕模式 · 点按显示文字' : '字幕模式 · 点按隐去文字'}
        </button>
      )}

      {chatting && <div className="orbit-hint">拖动环视 · 滚轮推近 · 双击复位</div>}

      {(phase === 'loading' || phase === 'analyzing') && (
        <div className="analyzing-hint">念念正在端详这张照片…</div>
      )}

      {phase === 'condensing' && <div className="condensing-text">思 绪 正 在 沉 淀 . . .</div>}

      {!textHidden &&
        (chatting ||
          phase === 'analyzing' ||
          phase === 'condensing' ||
          (showDiaryUI && sessionTab === 'chat')) && (
          <ChatOverlay fading={phase === 'condensing'} />
        )}

      {showDiaryUI && sessionTab === 'diary' && <DiaryView />}

      {canChat && <FaceChips />}

      {canChat && hasUserMsg && !busy && (
        <button className="condense-btn" onClick={() => void generateDiary()}>
          {phase === 'done' ? '✦ 重新凝聚' : '✦ 凝聚记忆'}
        </button>
      )}

      {canChat && <VoiceInput />}

      {interimText !== null && (
        <div className="interim-pill">
          <span className="interim-mic">🎙</span> {interimText || '…'}
        </div>
      )}
    </div>
  );
}
