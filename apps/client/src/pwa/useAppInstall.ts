import { useEffect, useRef, useState } from "react";

export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Listen while authentication is loading too, so the install event is not lost. */
export function useAppInstall() {
  const prompt = useRef<InstallPrompt | undefined>(undefined);
  const [available, setAvailable] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    setInstalled(display.matches);
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      prompt.current = event as InstallPrompt;
      setAvailable(true);
    };
    const didInstall = () => { prompt.current = undefined; setAvailable(false); setInstalled(true); setMessage("Web Phone установлен. Запускайте его из списка приложений."); };
    const modeChanged = () => setInstalled(display.matches);
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", didInstall);
    display.addEventListener("change", modeChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", didInstall);
      display.removeEventListener("change", modeChanged);
    };
  }, []);

  const install = async () => {
    const event = prompt.current;
    if (!event) {
      setMessage("Откройте меню Chrome и выберите установку страницы как приложения. Если Web Phone уже установлен, запустите его из списка приложений.");
      return;
    }
    prompt.current = undefined;
    setAvailable(false);
    setPending(true);
    try {
      await event.prompt();
      const choice = await event.userChoice;
      setMessage(choice.outcome === "accepted" ? "Запрос на установку принят Chrome." : "Установка отменена. Её можно повторить через меню Chrome.");
    } catch {
      setMessage("Chrome не смог открыть окно установки. Попробуйте установить Web Phone через меню браузера.");
    } finally { setPending(false); }
  };
  return { available, installed, pending, message, install };
}
