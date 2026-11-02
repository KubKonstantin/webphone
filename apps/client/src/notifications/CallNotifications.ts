export type NotificationState = {
  permission: NotificationPermission | "unsupported";
  enabled: boolean;
  error?: string;
};

/** Desktop notifications for the currently ringing SIP call; no push backend. */
export class CallNotifications {
  private enabled = true;
  private storageKey?: string;
  private error?: string;
  private notification?: Notification;
  private callId?: string;
  private listeners = new Set<(state: NotificationState) => void>();
  private configuration = 0;

  getState(): NotificationState {
    return {
      permission: typeof Notification !== "undefined" && window.isSecureContext ? Notification.permission : "unsupported",
      enabled: this.enabled,
      error: this.error
    };
  }

  subscribe(listener: (state: NotificationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  configureUser(login: string): void {
    this.configuration++;
    this.close();
    this.storageKey = `web-phone.notifications.${login}`;
    this.error = undefined;
    try { this.enabled = localStorage.getItem(this.storageKey) !== "false"; }
    catch { this.enabled = true; }
    this.refresh();
  }

  refresh(): void {
    const state = this.getState();
    if (!state.enabled || state.permission !== "granted") this.close();
    this.listeners.forEach((listener) => listener(state));
  }

  /** Must be invoked directly from a button click to allow Chrome's prompt. */
  async setEnabled(enabled: boolean): Promise<void> {
    const configuration = this.configuration;
    this.error = undefined;
    if (enabled) {
      const { permission } = this.getState();
      if (permission === "unsupported") return;
      if (permission === "default") {
        try { await Notification.requestPermission(); }
        catch { this.error = "Не удалось запросить разрешение на уведомления. Проверьте настройки сайта в Chrome."; }
      }
      if (configuration !== this.configuration) return;
      enabled = Notification.permission === "granted";
    }
    this.enabled = enabled;
    try { if (this.storageKey) localStorage.setItem(this.storageKey, String(enabled)); }
    catch { this.error = "Настройка применена, но сохранить её в браузере не удалось."; }
    this.refresh();
  }

  show(callId: string, remote: string): void {
    const state = this.getState();
    if (!state.enabled || state.permission !== "granted" || this.callId === callId) return;
    this.close();
    try {
      const notification = new Notification("Входящий звонок — Web Phone", {
        body: `Звонит ${remote}. Нажмите, чтобы открыть веб-телефон.`,
        icon: "/favicon.svg",
        tag: `web-phone.call.${callId}`,
        requireInteraction: true,
        silent: true // Ringtone is already routed to the user's selected speakers.
      });
      this.notification = notification;
      this.callId = callId;
      notification.onclick = () => {
        if (this.callId !== callId) return;
        window.focus();
        notification.close(); // Opening the tab does not automatically answer.
      };
      this.error = undefined;
    } catch {
      this.error = "Не удалось показать уведомление. Проверьте разрешения Chrome и системные настройки уведомлений.";
    }
    this.refresh();
  }

  close(callId?: string): void {
    if (callId && callId !== this.callId) return;
    if (this.notification) {
      this.notification.onclick = null;
      this.notification.close();
    }
    this.notification = undefined;
    this.callId = undefined;
  }
}
