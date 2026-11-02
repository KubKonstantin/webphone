import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import type { CallNotifications } from "../notifications/CallNotifications";

export function NotificationSettings({ notifications }: { notifications: CallNotifications }) {
  const [state, setState] = useState(() => notifications.getState());
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const unsubscribe = notifications.subscribe(setState);
    const refresh = () => notifications.refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [notifications]);

  const active = state.permission === "granted" && state.enabled;
  const toggle = async () => {
    setPending(true);
    try { await notifications.setEnabled(!active); }
    finally { setPending(false); }
  };

  return (
    <div className="notification-settings">
      <div>
        <strong><Bell size={16} /> Уведомления о входящих звонках</strong>
        <p className="audio-note" role="status">
          {state.permission === "unsupported" ? "Уведомления недоступны. Откройте веб-телефон по HTTPS в настольном Chrome."
            : state.permission === "denied" ? "Уведомления заблокированы. В настройках сайта в Chrome разрешите уведомления и вернитесь на вкладку."
            : active ? "Уведомления включены. Нажатие откроет вкладку со звонком."
            : "Включите уведомления, чтобы видеть входящий звонок поверх других окон."}
        </p>
        <p className="audio-note">Работают, пока веб-телефон открыт и подключён. В режиме DND уведомления не показываются.</p>
        {state.error && <p className="notification-error" role="alert">{state.error}</p>}
      </div>
      <button type="button" className="secondary-button" disabled={pending || state.permission === "unsupported" || state.permission === "denied"} onClick={() => void toggle()}>
        {pending ? "Ожидаем разрешение…" : active ? "Выключить уведомления" : "Включить уведомления"}
      </button>
    </div>
  );
}
