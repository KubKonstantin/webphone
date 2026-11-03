import { useState } from "react";
import { Download, Link } from "lucide-react";
import type { useAppInstall } from "../pwa/useAppInstall";

export function AppActions({ installation }: { installation: ReturnType<typeof useAppInstall> }) {
  const [message, setMessage] = useState<string>();
  const supported = window.isSecureContext && typeof navigator.registerProtocolHandler === "function";
  const register = () => {
    try {
      navigator.registerProtocolHandler("sip", `${window.location.origin}/?sip=%s`);
      setMessage("Подтвердите выбор Web Phone для SIP-ссылок в запросе Chrome. Если запрос не появился, проверьте настройки обработчиков протоколов в браузере.");
    } catch {
      setMessage("Не удалось назначить обработчик SIP-ссылок. Проверьте разрешения и настройки Chrome.");
    }
  };
  return (
    <section className="app-actions" aria-label="Установка приложения и SIP-ссылки">
      <div className="app-action-buttons">
        {!installation.installed && <button type="button" className="secondary-button" disabled={installation.pending || !window.isSecureContext} onClick={() => void installation.install()}><Download size={16} /> {installation.pending ? "Установка…" : "Установить Web Phone"}</button>}
        {installation.installed && <span className="app-mode">Web Phone · приложение</span>}
        <button type="button" className="secondary-button" disabled={!supported} onClick={register}><Link size={16} /> Открывать SIP-ссылки здесь</button>
      </div>
      {!window.isSecureContext && <p className="audio-note">Для установки и обработки ссылок откройте сайт по HTTPS.</p>}
      {window.isSecureContext && !supported && <p className="audio-note">Этот браузер не поддерживает назначение SIP-обработчика. Используйте настольный Chrome.</p>}
      {installation.message && <p className="audio-note" role="status">{installation.message}</p>}
      {message && <p className="audio-note" role="status">{message}</p>}
    </section>
  );
}
