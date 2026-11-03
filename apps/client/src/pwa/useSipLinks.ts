import { useEffect, useRef, useState } from "react";
import { readSipLaunch, restorePendingSip, savePendingSip, sipLoginUrl } from "./sipLinks";

type LaunchWindow = Window & { launchQueue?: { setConsumer: (consumer: (params: { targetURL?: string }) => void) => void } };

export function useSipLinks(authenticated: boolean, busy: boolean, setDestination: (target: string) => void) {
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  const initialURL = useRef(window.location.href);
  const initialEcho = useRef(readSipLaunch(initialURL.current, window.location.origin).kind !== "none" ? initialURL.current : undefined);

  useEffect(() => {
    let active = true;
    const receive = (url: string) => {
      if (!active) return;
      const result = readSipLaunch(url, window.location.origin);
      if (result.kind === "none") return;
      if (result.kind === "invalid") {
        setPending(undefined);
        savePendingSip();
        setMessage("Некорректная SIP-ссылка. Поддерживаются sip:номер и sip:абонент@домен без дополнительных параметров.");
      } else {
        setPending(result.target);
        savePendingSip(result.target);
        setMessage(undefined);
      }
    };
    if (readSipLaunch(window.location.href, window.location.origin).kind !== "none") {
      receive(window.location.href);
      const clean = new URL(window.location.href);
      clean.searchParams.delete("sip");
      window.history.replaceState(window.history.state, "", clean.pathname + clean.search + clean.hash);
    } else {
      setPending(restorePendingSip());
    }
    const queue = (window as LaunchWindow).launchQueue;
    queue?.setConsumer(({ targetURL }) => {
      if (!active || !targetURL) return;
      // An installed app may report its initial navigation through launchQueue too.
      if (initialEcho.current === targetURL) { initialEcho.current = undefined; return; }
      initialEcho.current = undefined;
      receive(targetURL);
    });
    return () => { active = false; queue?.setConsumer(() => undefined); };
  }, []);

  useEffect(() => {
    if (!authenticated || busy || !pending) return;
    setDestination(pending);
    savePendingSip();
    setPending(undefined);
    setMessage("Номер из SIP-ссылки подставлен. Для начала звонка нажмите «Позвонить».");
  }, [authenticated, busy, pending, setDestination]);

  const dismiss = () => {
    setPending(undefined);
    setMessage(undefined);
    savePendingSip();
  };
  return { pending, message, dismiss, loginUrl: sipLoginUrl(pending) };
}
