export type AudioPreferences = {
  inputId: string;
  outputId: string;
  ringtoneId: string;
};

export const defaultAudioPreferences: AudioPreferences = { inputId: "", outputId: "", ringtoneId: "" };

export function loadAudioPreferences(storageKey: string): AudioPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return {
      inputId: typeof stored?.inputId === "string" ? stored.inputId : "",
      outputId: typeof stored?.outputId === "string" ? stored.outputId : "",
      ringtoneId: typeof stored?.ringtoneId === "string" ? stored.ringtoneId : ""
    };
  } catch {
    return { ...defaultAudioPreferences };
  }
}

export function microphoneConstraints(inputId: string): MediaTrackConstraints {
  return { ...(inputId ? { deviceId: { exact: inputId } } : {}), echoCancellation: true, noiseSuppression: true };
}

export async function setAudioOutput(audio: HTMLAudioElement, deviceId: string): Promise<void> {
  if (typeof audio.setSinkId === "function") await audio.setSinkId(deviceId);
  else if (deviceId) throw new Error("Браузер не поддерживает выбор аудиовыхода. Используйте устройство по умолчанию.");
}

export function sameOutput(a: string, b: string, devices: MediaDeviceInfo[]): boolean {
  if (a === b) return true;
  const first = devices.find((device) => device.kind === "audiooutput" && device.deviceId === (a || "default"));
  const second = devices.find((device) => device.kind === "audiooutput" && device.deviceId === (b || "default"));
  return !!first?.groupId && first.groupId === second?.groupId;
}

export function reconcileDevices(preferences: AudioPreferences, devices: MediaDeviceInfo[]): AudioPreferences {
  const available = (id: string, kind: MediaDeviceKind) => !id || devices.some((device) => device.kind === kind && device.deviceId === id);
  const next = {
    inputId: available(preferences.inputId, "audioinput") ? preferences.inputId : "",
    outputId: available(preferences.outputId, "audiooutput") ? preferences.outputId : "",
    ringtoneId: available(preferences.ringtoneId, "audiooutput") ? preferences.ringtoneId : ""
  };
  if (next.ringtoneId && sameOutput(next.outputId, next.ringtoneId, devices)) next.ringtoneId = "";
  return next;
}
