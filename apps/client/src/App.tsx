import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  BellOff,
  LogOut,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  Pause,
  Play,
  ShieldCheck,
  Volume2
} from "lucide-react";
import { api, type CallRecord, type User } from "./api";
import { AudioSetup } from "./components/AudioSetup";
import { CallHistory } from "./components/CallHistory";
import { DialPad } from "./components/DialPad";
import { PhoneBook } from "./components/PhoneBook";
import { SipPhone, type PhoneSnapshot } from "./sip/SipPhone";

const initialSnapshot: PhoneSnapshot = {
  registration: "offline",
  dnd: false,
  audioPlaybackBlocked: false,
  callState: "idle",
  muted: false,
  held: false,
  dtmfMode: "rtp",
  volume: 1,
  sipProfileForbidden: false,
  historyRevision: 0
};

function registrationLabel(state: PhoneSnapshot["registration"]): string {
  return {
    offline: "Не в сети",
    connecting: "Подключение",
    registered: "Готов к звонкам",
    error: "Ошибка подключения"
  }[state];
}

function callLabel(snapshot: PhoneSnapshot): string {
  return {
    idle: "Введите номер",
    incoming: "Входящий звонок",
    calling: "Вызов…",
    establishing: "Соединение…",
    active: "Разговор",
    ending: "Завершение…"
  }[snapshot.callState];
}

function formatTimer(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<User>();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [destination, setDestination] = useState("");
  const [transferTarget, setTransferTarget] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);
  const [history, setHistory] = useState<CallRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sidePanel, setSidePanel] = useState<"history" | "contacts">("contacts");
  const [elapsed, setElapsed] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const phone = useMemo(() => new SipPhone(), []);

  useEffect(() => {
    api.me()
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch(() => setUser(undefined))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    phone.configureUser(user.login);
    const unsubscribe = phone.subscribe(setSnapshot);
    phone.setRemoteAudioElement(audioRef.current);
    void phone.start();
    return () => {
      unsubscribe();
      void phone.stop();
    };
  }, [phone, user]);

  useEffect(() => {
    if (!user) return;
    setHistoryLoading(true);
    api.calls()
      .then(({ records }) => setHistory(records))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [user, snapshot.historyRevision]);

  useEffect(() => {
    if (snapshot.callState !== "active") {
      setElapsed(0);
      return;
    }
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.callState]);

  const inCall = snapshot.callState !== "idle";
  const canCall = snapshot.registration === "registered" && snapshot.callState === "idle" && destination.trim().length > 0;

  const startCall = async () => {
    try {
      await phone.call(destination);
    } catch (error) {
      console.error(error);
    }
  };

  const logout = async () => {
    await phone.stop();
    await api.logout();
    window.location.reload();
  };

  if (authLoading) {
    return <main className="center-page"><div className="loader" /><p>Проверяем сессию…</p></main>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <span className="brand-mark"><PhoneCall size={32} /></span>
            <strong>Web Phone</strong>
          </div>
          <p>Безопасный сервис совершения звонков от VoIP-hub. Авторизуйтесь с вашей корпоративной учетной записью. Если у вас возникли проблемы, пожалуйста, обратитесь в техническую поддержку https://helpdesk.docdoc.ru/</p>
          <button className="primary-button large" onClick={() => { window.location.href = "/api/auth/login"; }}>
            <ShieldCheck size={20} /> Войти через Casdoor
          </button>
        </div>
      </main>
    );
  }

  if (snapshot.sipProfileForbidden) {
    return (
      <main className="center-page forbidden-page">
        <div className="forbidden-card">
          <strong>403</strong>
          <h1>SIP-профиль недоступен</h1>
          <p>Обратитесь в техническую поддержку для получения доступа.</p>
          <a href="https://helpdesk.docdoc.ru/" target="_blank" rel="noreferrer">helpdesk.docdoc.ru</a>
          <button className="secondary-button" onClick={() => void logout()}>Выйти</button>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <audio ref={audioRef} autoPlay />
      <header className="topbar">
        <div className="brand"><span className="brand-mark small"><PhoneCall size={20} /></span><strong>Web Phone</strong></div>
        <div className="user-area">
          <div className="connection-pill">
            <span className={`status-dot ${snapshot.dnd && snapshot.registration === "registered" ? "dnd" : snapshot.registration}`} />
            <span>{snapshot.dnd && snapshot.registration === "registered" ? "Не беспокоить" : registrationLabel(snapshot.registration)}</span>
          </div>
          <button className={`dnd-button ${snapshot.dnd ? "active" : ""}`} aria-pressed={snapshot.dnd} title="Не беспокоить: отклонять входящие звонки" onClick={() => phone.setDnd(!snapshot.dnd)}><BellOff size={17} /><span>{snapshot.dnd ? "DND включён" : "Не беспокоить"}</span></button>
          <div className="profile">
            {user.picture ? <img src={user.picture} alt="" /> : <span>{(user.name ?? user.login).slice(0, 1).toUpperCase()}</span>}
            <div><strong>{user.name ?? user.login}</strong><small>{snapshot.sipIdentity ?? user.login}</small></div>
          </div>
          <button className="icon-button" aria-label="Выйти" onClick={() => void logout()}><LogOut size={18} /></button>
        </div>
      </header>

      <AudioSetup key={user.login} phone={phone} storageKey={`web-phone.audio.${user.login}`} busy={inCall} />
      <div className="workspace">
        <section className="phone-panel panel">
          <div className="phone-status">
            <span className="eyebrow">{callLabel(snapshot)}</span>
            <h1>{snapshot.remote ?? (destination || "—")}</h1>
            <p>{snapshot.callState === "active" ? formatTimer(elapsed) : snapshot.sipIdentity ?? "SIP не подключён"}</p>
          </div>

          {snapshot.dnd && <div className="dnd-banner">Не беспокоить: входящие отклоняются. Исходящие звонки доступны.</div>}
          {snapshot.audioPlaybackBlocked && <button className="secondary-button audio-retry" onClick={() => void phone.resumeAudio()}>Включить звук</button>}
          {snapshot.error && <div className="error-banner">{snapshot.error}</div>}
          {snapshot.callState === "idle" && snapshot.hangupReason && <div className="hangup-reason">{snapshot.hangupReason}</div>}

          {snapshot.callState === "idle" && (
            <>
              <div className="number-input-wrap">
                <input
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && canCall) void startCall(); }}
                  placeholder="Номер или sip:user@domain"
                  aria-label="Номер телефона"
                />
                {destination && <button onClick={() => setDestination(destination.slice(0, -1))}>⌫</button>}
              </div>
              <DialPad disabled={snapshot.registration !== "registered"} onPress={(key) => setDestination((value) => value + key)} />
              <button className="call-button" disabled={!canCall} onClick={() => void startCall()}>
                <Phone size={24} /> Позвонить
              </button>
            </>
          )}

          {snapshot.callState === "incoming" && (
            <div className="incoming-actions">
              <button className="round-action reject" onClick={() => void phone.reject()}><PhoneOff size={28} /><span>Отклонить</span></button>
              <div className="incoming-pulse"><PhoneIncoming size={36} /></div>
              <button className="round-action accept" onClick={() => void phone.answer()}><Phone size={28} /><span>Ответить</span></button>
            </div>
          )}

          {!["idle", "incoming"].includes(snapshot.callState) && (
            <div className="active-call-controls">
              <div className="control-row">
                <button className={`control-button ${snapshot.muted ? "active" : ""}`} onClick={() => phone.setMuted(!snapshot.muted)}>
                  {snapshot.muted ? <MicOff size={22} /> : <Mic size={22} />}<span>Микрофон</span>
                </button>
                <button className={`control-button ${snapshot.held ? "active" : ""}`} disabled={snapshot.callState !== "active"} onClick={() => void phone.setHeld(!snapshot.held).catch(() => undefined)}>
                  {snapshot.held ? <Play size={22} /> : <Pause size={22} />}<span>{snapshot.held ? "Продолжить" : "Удержать"}</span>
                </button>
                <button className={`control-button ${showTransfer ? "active" : ""}`} disabled={snapshot.callState !== "active"} onClick={() => setShowTransfer((value) => !value)}>
                  <ArrowRightLeft size={22} /><span>Перевести</span>
                </button>
              </div>
              {showTransfer && snapshot.callState === "active" && (
                <div className="transfer-box">
                  <input value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)} placeholder="Номер назначения" />
                  <button disabled={!transferTarget.trim()} onClick={() => void phone.transfer(transferTarget)}>Перевести</button>
                </div>
              )}
              <div className="in-call-dial-pad">
                <button className="dtmf-mode-toggle" onClick={() => phone.setDtmfMode(snapshot.dtmfMode === "rtp" ? "info" : "rtp")}>
                  DTMF: {snapshot.dtmfMode === "rtp" ? "RTP" : "INFO"}
                </button>
                <DialPad disabled={snapshot.callState !== "active"} onPress={(key) => void phone.sendDtmf(key).catch(() => undefined)} />
              </div>
              <div className="volume-control">
                <Volume2 size={19} />
                <input type="range" min="0" max="1" step="0.05" value={snapshot.volume} onChange={(event) => phone.setVolume(Number(event.target.value))} />
                <span>{Math.round(snapshot.volume * 100)}%</span>
              </div>
              <button className="hangup-button" onClick={() => void phone.endCall(snapshot.callState === "active" ? "completed" : "cancelled")}>
                <PhoneOff size={24} /> Завершить
              </button>
            </div>
          )}
        </section>

        <div className="side-column">
          <div className="side-tabs" role="tablist" aria-label="Данные телефона">
            <button className={sidePanel === "contacts" ? "active" : ""} onClick={() => setSidePanel("contacts")}>Контакты</button>
            <button className={sidePanel === "history" ? "active" : ""} onClick={() => setSidePanel("history")}>История</button>
          </div>
          {sidePanel === "contacts" ? (
            <PhoneBook
              storageKey={`web-phone.contacts.${user.login}`}
              onCall={(number) => { setDestination(number); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            />
          ) : (
            <CallHistory
              records={history}
              loading={historyLoading}
              onRedial={(remote) => { setDestination(remote); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            />
          )}
        </div>
      </div>
    </main>
  );
}
