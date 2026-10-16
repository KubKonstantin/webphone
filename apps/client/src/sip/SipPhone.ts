import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  Session,
  SessionState,
  UserAgent,
  type InvitationAcceptOptions,
  type InviterOptions,
  type UserAgentOptions
} from "sip.js";
import { ApiError, api, type CallRecord, type CallStatus, type SipCredentials } from "../api";

export type RegistrationState = "offline" | "connecting" | "registered" | "error";
export type CallUiState = "idle" | "incoming" | "calling" | "establishing" | "active" | "ending";
export type DtmfMode = "rtp" | "info";

export type PhoneSnapshot = {
  registration: RegistrationState;
  callState: CallUiState;
  direction?: "incoming" | "outgoing";
  remote?: string;
  muted: boolean;
  held: boolean;
  dtmfMode: DtmfMode;
  volume: number;
  error?: string;
  hangupReason?: string;
  sipProfileForbidden: boolean;
  sipIdentity?: string;
  credentialsExpiresAt?: number;
  historyRevision: number;
};

type ActiveCall = {
  id: string;
  session: Session;
  direction: "incoming" | "outgoing";
  remote: string;
  startedAt: Date;
  answeredAt?: Date;
  requestedStatus?: CallStatus;
  transferAccepted: boolean;
  hangupWhenEstablished: boolean;
  persisted: boolean;
  hangupReason?: string;
};

type SessionWithPeerConnection = Session & {
  sessionDescriptionHandler?: { peerConnection?: RTCPeerConnection };
};

export class SipPhone {
  private userAgent?: UserAgent;
  private registerer?: Registerer;
  private credentials?: SipCredentials;
  private pendingCredentials?: SipCredentials;
  private activeCall?: ActiveCall;
  private remoteAudio?: HTMLAudioElement;
  private ringtoneContext?: AudioContext;
  private ringtoneInterval?: number;
  private ringtoneStopTimer?: number;
  private ringtoneOscillators: OscillatorNode[] = [];
  private refreshTimer?: number;
  private reconnectTimer?: number;
  private subscribers = new Set<(snapshot: PhoneSnapshot) => void>();
  private disposed = false;
  private snapshot: PhoneSnapshot = {
    registration: "offline",
    callState: "idle",
    muted: false,
    held: false,
    dtmfMode: "rtp",
    volume: 1,
    sipProfileForbidden: false,
    historyRevision: 0
  };

  subscribe(listener: (snapshot: PhoneSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot);
    return () => this.subscribers.delete(listener);
  }

  setRemoteAudioElement(element: HTMLAudioElement | null): void {
    this.remoteAudio = element ?? undefined;
    if (this.remoteAudio) this.remoteAudio.volume = this.snapshot.volume;
  }

  async start(): Promise<void> {
    this.disposed = false;
    document.addEventListener("pointerdown", this.unlockRingtone, { once: true });
    document.addEventListener("keydown", this.unlockRingtone, { once: true });
    await this.refreshCredentials(true);
  }

  async stop(): Promise<void> {
    this.disposed = true;
    window.clearTimeout(this.refreshTimer);
    window.clearTimeout(this.reconnectTimer);
    this.stopRingtone();
    document.removeEventListener("pointerdown", this.unlockRingtone);
    document.removeEventListener("keydown", this.unlockRingtone);
    await this.endCall("cancelled").catch(() => undefined);
    await this.disconnectCurrentAgent();
    this.update({ registration: "offline", callState: "idle" });
  }

  async call(destination: string): Promise<void> {
    if (!this.userAgent || !this.credentials || this.snapshot.registration !== "registered") {
      throw new Error("SIP ещё не зарегистрирован");
    }
    if (this.activeCall) throw new Error("Уже есть активный звонок");

    const target = this.makeTarget(destination);
    const inviterOptions: InviterOptions = {
      sessionDescriptionHandlerOptions: this.mediaOptions()
    };
    const inviter = new Inviter(this.userAgent, target, inviterOptions);
    const active = this.createActiveCall(inviter, "outgoing", destination.trim());
    this.activeCall = active;
    this.bindSession(active);
    this.update({
      callState: "calling",
      direction: "outgoing",
      remote: active.remote,
      error: undefined,
      hangupReason: undefined,
      muted: false,
      held: false
    });
    try {
      await inviter.invite({
        requestDelegate: {
          onRedirect: (response) => { active.hangupReason = this.sipResponseReason(response.message.statusCode); },
          onReject: (response) => { active.hangupReason = this.sipResponseReason(response.message.statusCode); }
        }
      });
    } catch (error) {
      active.requestedStatus = "failed";
      await this.finalizeCall(active);
      throw error;
    }
  }

  async answer(): Promise<void> {
    const call = this.activeCall;
    if (!call || !(call.session instanceof Invitation) || call.session.state !== SessionState.Initial) {
      return;
    }
    this.stopRingtone();
    const options: InvitationAcceptOptions = {
      sessionDescriptionHandlerOptions: this.mediaOptions()
    };
    this.update({ callState: "establishing", error: undefined });
    await call.session.accept(options);
  }

  async reject(): Promise<void> {
    const call = this.activeCall;
    if (!call || !(call.session instanceof Invitation)) return;
    call.requestedStatus = "rejected";
    this.stopRingtone();
    if (call.session.state === SessionState.Initial) {
      await call.session.reject();
    }
  }

  async endCall(status: CallStatus = "cancelled"): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    call.requestedStatus = status;
    this.stopRingtone();
    this.update({ callState: "ending" });
    const session = call.session;
    if (session.state === SessionState.Initial) {
      if (session instanceof Inviter) await session.cancel();
      else if (session instanceof Invitation) await session.reject();
    } else if (session.state === SessionState.Establishing) {
      if (session instanceof Inviter) await session.cancel();
      else call.hangupWhenEstablished = true;
    } else if (session.state === SessionState.Established) {
      await session.bye();
    }
  }

  async transfer(destination: string): Promise<void> {
    const call = this.activeCall;
    if (!call || call.session.state !== SessionState.Established) {
      throw new Error("Перевод доступен только во время активного звонка");
    }
    const target = this.makeTarget(destination);
    await call.session.refer(target, {
      requestDelegate: {
        onAccept: () => {
          call.transferAccepted = true;
          call.requestedStatus = "transferred";
          this.update({ callState: "ending", held: false, error: undefined });
          void call.session.bye().catch((error) => this.update({ error: this.errorMessage(error) }));
        },
        onReject: () => this.update({ error: "SIP-сервер отклонил перевод" })
      }
    });
  }

  setVolume(value: number): void {
    const volume = Math.min(1, Math.max(0, value));
    if (this.remoteAudio) this.remoteAudio.volume = volume;
    this.update({ volume });
  }

  setMuted(muted: boolean): void {
    const peerConnection = this.peerConnection(this.activeCall?.session);
    peerConnection?.getSenders().forEach((sender) => {
      if (sender.track?.kind === "audio") sender.track.enabled = !muted;
    });
    this.update({ muted });
  }

  setDtmfMode(dtmfMode: DtmfMode): void {
    this.update({ dtmfMode });
  }

  async sendDtmf(tone: string): Promise<void> {
    const call = this.activeCall;
    if (!call || call.session.state !== SessionState.Established || !/^[0-9*#]$/.test(tone)) return;
    if (this.snapshot.dtmfMode === "info") {
      await call.session.info({
        requestOptions: {
          body: {
            contentDisposition: "render",
            contentType: "application/dtmf-relay",
            content: `Signal=${tone}\r\nDuration=160`
          }
        }
      }).then(() => this.update({ error: undefined })).catch((error) => {
        this.update({ error: `DTMF INFO: ${this.errorMessage(error)}` });
        throw error;
      });
    } else if (!call.session.sessionDescriptionHandler?.sendDtmf(tone, { duration: 160, interToneGap: 70 })) {
      this.update({ error: "Не удалось отправить RTP DTMF-сигнал" });
    }
  }

  async setHeld(held: boolean): Promise<void> {
    const call = this.activeCall;
    if (!call || call.session.state !== SessionState.Established) {
      throw new Error("Удержание доступно только во время активного звонка");
    }
    await new Promise<void>((resolve, reject) => {
      void call.session.invite({
        sessionDescriptionHandlerOptions: { hold: held } as InvitationAcceptOptions["sessionDescriptionHandlerOptions"] & { hold: boolean },
        requestDelegate: {
          onAccept: () => {
            this.update({ held, error: undefined });
            resolve();
          },
          onReject: (response) => reject(new Error(`SIP-сервер отклонил ${held ? "удержание" : "возврат"}: ${response.message.statusCode}`))
        }
      }).catch(reject);
    }).catch((error) => {
      this.update({ error: this.errorMessage(error) });
      throw error;
    });
  }

  private async refreshCredentials(initial = false): Promise<void> {
    window.clearTimeout(this.refreshTimer);
    try {
      const credentials = await api.sipCredentials();
      if (this.activeCall) {
        this.pendingCredentials = credentials;
        this.scheduleCredentialRefresh(credentials);
        return;
      }
      await this.connect(credentials);
      this.update({ sipProfileForbidden: false });
      this.scheduleCredentialRefresh(credentials);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        this.update({ registration: "error", sipProfileForbidden: true, error: undefined });
        return;
      }
      this.update({
        registration: initial ? "error" : this.snapshot.registration,
        error: this.errorMessage(error)
      });
      if (!this.disposed) {
        this.refreshTimer = window.setTimeout(() => void this.refreshCredentials(false), 15_000);
      }
    }
  }

  private scheduleCredentialRefresh(credentials: SipCredentials): void {
    const delay = Math.max(5_000, credentials.refreshAfter - Date.now());
    this.refreshTimer = window.setTimeout(() => void this.refreshCredentials(false), delay);
  }

  private async connect(credentials: SipCredentials): Promise<void> {
    this.update({ registration: "connecting", error: undefined });
    await this.disconnectCurrentAgent();
    this.credentials = credentials;

    const uri = UserAgent.makeURI(`sip:${credentials.sipLogin}@${credentials.sipDomain}`);
    if (!uri) throw new Error("Не удалось сформировать SIP URI");

    const options: UserAgentOptions = {
      uri,
      displayName: credentials.displayName,
      authorizationUsername: credentials.sipLogin,
      authorizationPassword: credentials.sipPassword,
      transportOptions: { server: credentials.wssServer },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: credentials.iceServers }
      }
    };

    const userAgent = new UserAgent(options);
    const registerer = new Registerer(userAgent);
    this.userAgent = userAgent;
    this.registerer = registerer;

    userAgent.delegate = {
      onInvite: (invitation) => this.handleIncoming(invitation),
      onConnect: () => this.update({ registration: "connecting" }),
      onDisconnect: (error) => {
        this.update({ registration: "offline", error: error ? this.errorMessage(error) : undefined });
        if (!this.disposed && this.userAgent === userAgent) this.scheduleReconnect();
      }
    };
    registerer.stateChange.addListener((state) => {
      if (state === RegistererState.Registered) {
        this.update({ registration: "registered", error: undefined });
      } else if (state === RegistererState.Terminated || state === RegistererState.Unregistered) {
        this.update({ registration: "offline" });
      }
    });

    await userAgent.start();
    await registerer.register();
    // Remove password from the long-lived object after SIP.js copied its options.
    credentials.sipPassword = "";
    this.update({
      sipIdentity: `${credentials.sipLogin}@${credentials.sipDomain}`,
      credentialsExpiresAt: credentials.expiresAt
    });
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(async () => {
      if (!this.userAgent || this.disposed) return;
      try {
        this.update({ registration: "connecting" });
        await this.userAgent.reconnect();
        await this.registerer?.register();
        this.update({ registration: "registered", error: undefined });
      } catch (error) {
        this.update({ registration: "error", error: this.errorMessage(error) });
        this.scheduleReconnect();
      }
    }, 4_000);
  }

  private handleIncoming(invitation: Invitation): void {
    if (this.activeCall) {
      void invitation.reject({ statusCode: 486 });
      return;
    }
    const remote = invitation.remoteIdentity.uri.user
      || invitation.remoteIdentity.displayName
      || invitation.remoteIdentity.uri.toString();
    const active = this.createActiveCall(invitation, "incoming", remote);
    this.activeCall = active;
    this.bindSession(active);
    this.update({
      callState: "incoming",
      direction: "incoming",
      remote,
      muted: false,
      hangupReason: undefined,
      error: undefined
    });
    this.startRingtone();
  }

  private createActiveCall(session: Session, direction: "incoming" | "outgoing", remote: string): ActiveCall {
    return {
      id: crypto.randomUUID(),
      session,
      direction,
      remote,
      startedAt: new Date(),
      transferAccepted: false,
      hangupWhenEstablished: false,
      persisted: false
    };
  }

  private bindSession(call: ActiveCall): void {
    call.session.delegate = {
      ...call.session.delegate,
      onBye: (bye) => {
        const reasonHeader = bye.request.getHeader("Reason");
        call.hangupReason = this.reasonHeaderText(reasonHeader) ?? "Разговор завершён удалённой стороной";
      },
      onCancel: () => {
        call.hangupReason = "Вызов отменён вызывающей стороной";
      }
    };
    call.session.stateChange.addListener((state) => {
      if (state === SessionState.Establishing) {
        this.update({ callState: "establishing" });
      } else if (state === SessionState.Established) {
        call.answeredAt = new Date();
        this.attachRemoteMedia(call.session);
        this.update({ callState: call.hangupWhenEstablished ? "ending" : "active", error: undefined });
        if (call.hangupWhenEstablished) void call.session.bye();
      } else if (state === SessionState.Terminating) {
        this.update({ callState: "ending" });
      } else if (state === SessionState.Terminated) {
        void this.finalizeCall(call);
      }
    });
  }

  private attachRemoteMedia(session: Session): void {
    const peerConnection = this.peerConnection(session);
    if (!peerConnection || !this.remoteAudio) return;
    const stream = new MediaStream();
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track) stream.addTrack(receiver.track);
    });
    this.remoteAudio.srcObject = stream;
    this.remoteAudio.volume = this.snapshot.volume;
    void this.remoteAudio.play().catch(() => {
      this.update({ error: "Браузер заблокировал автовоспроизведение. Нажмите на страницу и ответьте снова." });
    });
  }

  private peerConnection(session?: Session): RTCPeerConnection | undefined {
    return (session as SessionWithPeerConnection | undefined)?.sessionDescriptionHandler?.peerConnection;
  }

  private cleanupMedia(): void {
    if (!this.remoteAudio) return;
    this.remoteAudio.pause();
    this.remoteAudio.srcObject = null;
  }

  private readonly unlockRingtone = (): void => {
    const context = this.ringtoneContext ?? new AudioContext();
    this.ringtoneContext = context;
    void context.resume().then(() => {
      document.removeEventListener("pointerdown", this.unlockRingtone);
      document.removeEventListener("keydown", this.unlockRingtone);
    }).catch(() => undefined);
  };

  private startRingtone(): void {
    this.stopRingtone();
    this.unlockRingtone();
    this.playRingBurst();
    this.ringtoneInterval = window.setInterval(() => this.playRingBurst(), 3_000);
  }

  private playRingBurst(): void {
    const context = this.ringtoneContext;
    if (!context || !this.activeCall || this.snapshot.callState !== "incoming") return;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.03);
    gain.gain.setValueAtTime(0.12, context.currentTime + 0.75);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.95);
    gain.connect(context.destination);
    this.ringtoneOscillators = [440, 480].map((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(context.currentTime + 1);
      return oscillator;
    });
    this.ringtoneStopTimer = window.setTimeout(() => {
      this.ringtoneOscillators = [];
      gain.disconnect();
    }, 1_100);
  }

  private stopRingtone(): void {
    window.clearInterval(this.ringtoneInterval);
    window.clearTimeout(this.ringtoneStopTimer);
    this.ringtoneInterval = undefined;
    this.ringtoneStopTimer = undefined;
    this.ringtoneOscillators.forEach((oscillator) => {
      try {
        oscillator.stop();
      } catch {
        // The oscillator may already have reached its scheduled stop time.
      }
      oscillator.disconnect();
    });
    this.ringtoneOscillators = [];
  }

  private async finalizeCall(call: ActiveCall): Promise<void> {
    if (call.persisted) return;
    call.persisted = true;
    await Promise.resolve();
    const endedAt = new Date();
    const status = this.resolveStatus(call);
    const durationSeconds = call.answeredAt
      ? Math.max(0, Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000))
      : 0;
    const record: CallRecord = {
      id: call.id,
      direction: call.direction,
      remote: call.remote,
      startedAt: call.startedAt.toISOString(),
      ...(call.answeredAt ? { answeredAt: call.answeredAt.toISOString() } : {}),
      endedAt: endedAt.toISOString(),
      durationSeconds,
      status
    };
    this.stopRingtone();
    this.cleanupMedia();
    if (this.activeCall?.id === call.id) this.activeCall = undefined;
    this.update({
      callState: "idle",
      direction: undefined,
      remote: undefined,
      muted: false,
      held: false,
      hangupReason: call.hangupReason,
      historyRevision: this.snapshot.historyRevision + 1
    });
    await api.saveCall(record).catch((error) => this.update({ error: `История: ${this.errorMessage(error)}` }));

    if (this.pendingCredentials && !this.disposed) {
      const pending = this.pendingCredentials;
      this.pendingCredentials = undefined;
      await this.connect(pending).catch((error) => this.update({ registration: "error", error: this.errorMessage(error) }));
      this.scheduleCredentialRefresh(pending);
    }
  }

  private resolveStatus(call: ActiveCall): CallStatus {
    if (call.transferAccepted) return "transferred";
    if (call.requestedStatus) return call.requestedStatus;
    if (call.answeredAt) return "completed";
    return call.direction === "incoming" ? "missed" : "failed";
  }

  private makeTarget(destination: string) {
    const value = destination.trim();
    if (!value || !this.credentials) throw new Error("Введите номер или SIP URI");
    const normalized = value.startsWith("sip:") ? value : `sip:${value}@${this.credentials.sipDomain}`;
    const target = UserAgent.makeURI(normalized);
    if (!target) throw new Error("Некорректный номер или SIP URI");
    return target;
  }

  private mediaOptions() {
    return {
      constraints: { audio: true, video: false },
      peerConnectionConfiguration: { iceServers: this.credentials?.iceServers ?? [] }
    };
  }

  private async disconnectCurrentAgent(): Promise<void> {
    window.clearTimeout(this.reconnectTimer);
    const registerer = this.registerer;
    const userAgent = this.userAgent;
    this.registerer = undefined;
    this.userAgent = undefined;
    if (userAgent) userAgent.delegate = undefined;
    if (registerer && registerer.state === RegistererState.Registered) {
      await registerer.unregister().catch(() => undefined);
    }
    await userAgent?.stop().catch(() => undefined);
  }

  private update(patch: Partial<PhoneSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.subscribers.forEach((listener) => listener(this.snapshot));
  }

  private sipResponseReason(statusCode: number | undefined): string {
    const reasons: Record<number, string> = {
      403: "403 — вызов запрещён",
      404: "404 — номер не найден",
      408: "408 — истекло время ожидания ответа",
      480: "480 — абонент временно недоступен",
      484: "484 — неполный или некорректный номер",
      486: "486 — абонент занят",
      487: "487 — вызов отменён",
      488: "488 — несовместимые параметры вызова",
      500: "500 — внутренняя ошибка SIP-сервера",
      502: "502 — ошибка SIP-шлюза",
      503: "503 — SIP-сервис временно недоступен",
      603: "603 — вызов отклонён абонентом"
    };
    if (statusCode === undefined) return "Вызов завершён SIP-сервером";
    return reasons[statusCode] ?? `${statusCode} — вызов завершён`;
  }

  private reasonHeaderText(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const cause = /cause\s*=\s*(\d+)/i.exec(header)?.[1];
    if (cause && /^\s*Q\.850/i.test(header)) return this.q850Reason(Number(cause));
    if (cause) return this.sipResponseReason(Number(cause));
    return /text\s*=\s*"([^"]+)"/i.exec(header)?.[1];
  }

  private q850Reason(cause: number): string {
    const reasons: Record<number, string> = {
      16: "Разговор завершён удалённой стороной",
      17: "Абонент занят",
      18: "Абонент не отвечает",
      19: "Нет ответа от абонента",
      21: "Вызов отклонён",
      27: "Направление недоступно",
      28: "Некорректный номер",
      34: "Нет свободных каналов",
      38: "Сетевая ошибка",
      41: "Временная ошибка сети",
      47: "Недостаточно ресурсов",
      57: "Услуга не разрешена",
      58: "Услуга недоступна",
      88: "Несовместимые параметры вызова",
      102: "Истекло время ожидания"
    };
    return reasons[cause] ?? `Вызов завершён (Q.850: ${cause})`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
