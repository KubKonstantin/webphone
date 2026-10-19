import { useCallback, useEffect, useRef, useState } from "react";
import { Headphones, Mic, Volume2 } from "lucide-react";
import { loadAudioPreferences, microphoneConstraints, reconcileDevices, sameOutput, type AudioPreferences } from "../audio/devices";
import type { SipPhone } from "../sip/SipPhone";

type MicrophoneState = "idle" | "checking" | "permission" | "listening" | "ready" | "silent" | "error";
type OutputSelector = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

const microphoneLabels: Record<MicrophoneState, string> = {
  idle: "Микрофон ещё не проверен",
  checking: "Проверяем доступ к микрофону…",
  permission: "Доступ разрешён. Нажмите «Проверить микрофон» и скажите несколько слов.",
  listening: "Скажите несколько слов — проверяем уровень сигнала…",
  ready: "Микрофон работает: звуковой сигнал обнаружен",
  silent: "Доступ есть, но звук не обнаружен. Проверьте mute и выбранный микрофон.",
  error: "Микрофон недоступен"
};

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") return "Разрешите доступ к микрофону в настройках сайта и повторите проверку.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Выбранный микрофон не найден. Подключите его или выберите другой.";
  if (name === "NotReadableError") return "Не удалось открыть микрофон. Проверьте, не занят ли он другим приложением.";
  return error instanceof Error ? error.message : "Не удалось проверить микрофон";
}

export function AudioSetup({ phone, storageKey, busy }: { phone: SipPhone; storageKey: string; busy: boolean }) {
  const [preferences, setPreferences] = useState(() => {
    const saved = loadAudioPreferences(storageKey);
    return typeof HTMLMediaElement.prototype.setSinkId === "function" ? saved : { ...saved, outputId: "", ringtoneId: "" };
  });
  const preferencesRef = useRef(preferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [microphone, setMicrophone] = useState<MicrophoneState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [routing, setRouting] = useState(false);
  const [testingSound, setTestingSound] = useState(false);
  const mounted = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const generation = useRef(0);
  const capture = useRef<MediaStream | undefined>(undefined);
  const context = useRef<AudioContext | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const timeout = useRef<number | undefined>(undefined);
  const soundTimeout = useRef<number | undefined>(undefined);
  const hasPermission = useRef(false);
  const supportsOutput = typeof HTMLMediaElement.prototype.setSinkId === "function";

  const stopCheck = useCallback(() => {
    generation.current++;
    window.cancelAnimationFrame(frame.current ?? 0);
    window.clearTimeout(timeout.current);
    capture.current?.getTracks().forEach((track) => track.stop());
    capture.current = undefined;
    if (context.current) void context.current.close().catch(() => undefined);
    context.current = undefined;
  }, []);

  const apply = useCallback(async (next: AudioPreferences) => {
    setRouting(true);
    try {
      await phone.setAudioPreferences(next);
      if (!mounted.current) return;
      preferencesRef.current = next;
      setPreferences(next);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { setNotice("Настройки применены, но сохранить их в браузере не удалось."); }
    } finally {
      if (mounted.current) setRouting(false);
    }
  }, [phone, storageKey]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error("Для работы с аудиоустройствами нужен HTTPS и современный браузер.");
    const list = await navigator.mediaDevices.enumerateDevices();
    if (!mounted.current) return;
    setDevices(list);
    if (list.some((device) => device.kind === "audioinput" && device.label)) hasPermission.current = true;
    // Before permission, browsers may deliberately omit devices from this list.
    if (hasPermission.current) {
      const next = reconcileDevices(preferencesRef.current, list);
      if (JSON.stringify(next) !== JSON.stringify(preferencesRef.current)) {
        await apply(next);
        if (mounted.current) setNotice("Список устройств изменился. Недоступные устройства заменены на системные; дополнительный выход при необходимости отключён.");
      }
    }
  }, [apply]);

  const checkMicrophone = useCallback(async () => {
    if (busyRef.current) return;
    stopCheck();
    const current = generation.current;
    setError(undefined);
    setLevel(0);
    setMicrophone("checking");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Микрофон недоступен. Откройте сайт по HTTPS в современном браузере.");
      // Create/resume synchronously so an explicit button click unlocks analysis.
      const audioContext = new AudioContext();
      context.current = audioContext;
      void audioContext.resume().catch(() => undefined);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(preferencesRef.current.inputId), video: false });
      if (current !== generation.current || !mounted.current || busyRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      capture.current = stream;
      if (!stream.getAudioTracks().some((track) => track.readyState === "live")) throw new Error("Микрофон не передаёт аудиодорожку");
      hasPermission.current = true;
      await refresh();
      // Microphone permission may also unlock the associated speaker output.
      await phone.setAudioPreferences(preferencesRef.current).catch((failure) => {
        if (mounted.current) setError(microphoneError(failure));
      });
      if (current !== generation.current || !mounted.current) return;
      if (audioContext.state !== "running") {
        setMicrophone("permission");
        stopCheck();
        return;
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser); // Deliberately not connected to speakers: no feedback.
      const data = new Uint8Array(analyser.fftSize);
      let signalFrames = 0;
      setMicrophone("listening");
      const sample = () => {
        if (current !== generation.current) return;
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
        setLevel(Math.min(100, Math.round(rms * 500)));
        if (rms > 0.008) signalFrames++;
        frame.current = window.requestAnimationFrame(sample);
      };
      sample();
      timeout.current = window.setTimeout(() => {
        setMicrophone(signalFrames >= 5 ? "ready" : "silent");
        setLevel(0);
        stopCheck();
      }, 6000);
    } catch (failure) {
      if (current !== generation.current || !mounted.current) return;
      setError(microphoneError(failure));
      setMicrophone("error");
      stopCheck();
      void refresh().catch(() => undefined);
    }
  }, [phone, refresh, stopCheck]);

  useEffect(() => {
    mounted.current = true;
    void phone.setAudioPreferences(preferencesRef.current).catch((failure) => {
      if (mounted.current) setError(microphoneError(failure));
    });
    void refresh().catch((failure) => { if (mounted.current) setError(microphoneError(failure)); });
    void checkMicrophone();
    const changed = () => { void refresh().catch((failure) => { if (mounted.current) setError(microphoneError(failure)); }); };
    navigator.mediaDevices?.addEventListener("devicechange", changed);
    return () => {
      mounted.current = false;
      stopCheck();
      phone.stopAudioTest();
      window.clearTimeout(soundTimeout.current);
      navigator.mediaDevices?.removeEventListener("devicechange", changed);
    };
  }, [phone, refresh, checkMicrophone, stopCheck]);

  useEffect(() => {
    if (!busy) return;
    stopCheck();
    setLevel(0);
    setTestingSound(false);
    setMicrophone((value) => ["checking", "listening"].includes(value) ? "idle" : value);
  }, [busy, stopCheck]);

  const select = async (field: keyof AudioPreferences, value: string) => {
    setError(undefined);
    const next = { ...preferencesRef.current, [field]: value };
    if (next.ringtoneId && sameOutput(next.outputId, next.ringtoneId, devices)) next.ringtoneId = "";
    try {
      await apply(next);
      if (field === "inputId") await checkMicrophone();
    } catch (failure) { setError(microphoneError(failure)); }
  };

  const authorizeOutput = async () => {
    try {
      setError(undefined);
      await (navigator.mediaDevices as OutputSelector).selectAudioOutput?.();
      await refresh();
    } catch (failure) { setError(microphoneError(failure)); }
  };

  const testSound = async () => {
    setError(undefined);
    setTestingSound(true);
    try {
      await phone.testRingtone();
      setNotice("Если сигнал слышен на выбранных устройствах, вывод звука настроен.");
    } catch (failure) { setError(microphoneError(failure)); }
    finally { soundTimeout.current = window.setTimeout(() => setTestingSound(false), 1200); }
  };

  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications");
  const outputs = devices.filter((device) => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications");
  const unavailable = (id: string, list: MediaDeviceInfo[]) => id && !list.some((device) => device.deviceId === id)
    ? <option value={id}>Сохранённое устройство (сейчас недоступно)</option> : null;

  return (
    <details className="audio-setup panel" open>
      <summary><Headphones size={20} /><strong>Проверка готовности и звук</strong><span className={`readiness-status ${microphone}`}>{microphone === "ready" ? "Микрофон проверен" : "Настройка аудио"}</span></summary>
      <div className="audio-setup-body">
        <div className="audio-device-grid">
          <label>Микрофон
            <select value={preferences.inputId} disabled={busy || routing} onChange={(event) => void select("inputId", event.target.value)}>
              <option value="">Системный микрофон</option>
              {unavailable(preferences.inputId, inputs)}
              {inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>)}
            </select>
          </label>
          <label>Основное устройство — разговор и рингтон
            <select value={preferences.outputId} disabled={busy || routing || !supportsOutput} onChange={(event) => void select("outputId", event.target.value)}>
              <option value="">Системное устройство</option>
              {unavailable(preferences.outputId, outputs)}
              {outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Аудиовыход ${index + 1}`}</option>)}
            </select>
          </label>
          <label>Дополнительное — только рингтон
            <select value={preferences.ringtoneId} disabled={busy || routing || !supportsOutput} onChange={(event) => void select("ringtoneId", event.target.value)}>
              <option value="">Не использовать</option>
              {unavailable(preferences.ringtoneId, outputs)}
              {outputs.filter((device) => !sameOutput(preferences.outputId, device.deviceId, devices)).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Аудиовыход ${index + 1}`}</option>)}
            </select>
          </label>
        </div>
        {!supportsOutput && <p className="audio-note">Этот браузер воспроизводит звук только через системное устройство. Выбор второго выхода недоступен.</p>}
        <div className="audio-check-row">
          <div className="microphone-check"><span role="status">{microphoneLabels[microphone]}</span><meter min="0" max="100" value={level} aria-label="Уровень микрофона" /></div>
          <button className="secondary-button" disabled={busy || routing || microphone === "checking" || microphone === "listening"} onClick={() => void checkMicrophone()}><Mic size={16} /> Проверить микрофон</button>
          <button className="secondary-button" disabled={busy || routing || testingSound} onClick={() => void testSound()}><Volume2 size={16} /> Проверить рингтон</button>
          {supportsOutput && typeof (navigator.mediaDevices as OutputSelector | undefined)?.selectAudioOutput === "function" && <button className="secondary-button" disabled={busy || routing} onClick={() => void authorizeOutput()}>Разрешить аудиоустройство</button>}
        </div>
        <p className="audio-note">Проверка микрофона длится 6 секунд. Звук не записывается и не передаётся. {busy ? "Настройки и проверка доступны после завершения звонка." : "Настройки сохраняются в этом браузере."}</p>
        {notice && <p className="audio-note" role="status">{notice}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
      </div>
    </details>
  );
}
