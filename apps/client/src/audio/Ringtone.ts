import { setAudioOutput } from "./devices";
import { callEndedNotes, ringtoneNotes, type RingtoneTone } from "./tones";

/** One synthesized stream, routed only to the chosen ringtone outputs. */
export class Ringtone {
  private context?: AudioContext;
  private destination?: MediaStreamAudioDestinationNode;
  private players: HTMLAudioElement[] = [];
  private oscillators: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private interval?: number;
  private testTimer?: number;
  private generation = 0;
  private playing = false;
  private outputId = "";
  private extraId = "";
  private tone: RingtoneTone = "classic";

  async configure(outputId: string, extraId: string, tone: RingtoneTone = "classic"): Promise<void> {
    if (this.players[0]) await setAudioOutput(this.players[0], outputId);
    if (extraId) await setAudioOutput(this.players[1] ?? new Audio(), extraId);
    this.outputId = outputId;
    this.tone = tone;
    this.extraId = extraId && extraId !== outputId ? extraId : "";
    if (!this.extraId) this.players[1]?.pause();
  }

  /** Called during a user gesture; no microphone is opened. */
  async unlock(): Promise<void> {
    this.prepare();
    await this.context!.resume();
  }

  async start(test = false): Promise<void> {
    await this.play("ringtone", test);
  }

  async playEnded(): Promise<void> {
    await this.play("ended", true);
  }

  private async play(kind: "ringtone" | "ended", test: boolean): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.prepare();
    const context = this.context!;
    let resumeTimer: number | undefined;
    try {
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) => {
          resumeTimer = window.setTimeout(() => reject(new Error("Браузер заблокировал звук. Нажмите «Включить звук».")), 1500);
        })
      ]);
    } catch (error) {
      if (generation !== this.generation) return;
      throw error;
    } finally {
      window.clearTimeout(resumeTimer);
    }
    if (generation !== this.generation) return;
    const ids = [this.outputId, ...(kind === "ringtone" && this.extraId ? [this.extraId] : [])];
    // A failure on the additional device must not silence the primary ringtone.
    const results = await Promise.allSettled(ids.map(async (id, index) => {
      const player = this.players[index]!;
      await setAudioOutput(player, id);
      if (generation !== this.generation) return;
      await player.play();
      // stop() already pauses this player. A late play() resolution must not pause a newer call.
    }));
    if (generation !== this.generation) return;
    this.playing = true;
    this.burst(kind);
    if (test) this.testTimer = window.setTimeout(() => {
      if (generation === this.generation) this.stop();
    }, kind === "ended" ? 700 : 1200);
    else this.interval = window.setInterval(() => this.burst("ringtone"), 3000);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  stop(): void {
    this.generation++;
    this.playing = false;
    window.clearInterval(this.interval);
    window.clearTimeout(this.testTimer);
    this.players.forEach((player) => player.pause());
    this.clearBurst();
  }

  dispose(): void {
    this.stop();
    this.players.forEach((player) => { player.srcObject = null; });
    this.players = [];
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.destination = undefined;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = undefined;
  }

  private prepare(): void {
    if (this.context) return;
    this.context = new AudioContext();
    this.destination = this.context.createMediaStreamDestination();
    this.players = [new Audio(), new Audio()];
    this.players.forEach((player) => { player.srcObject = this.destination!.stream; });
  }

  private clearBurst(): void {
    this.oscillators.forEach((oscillator) => {
      try { oscillator.stop(); } catch { /* Already stopped. */ }
      oscillator.disconnect();
    });
    this.oscillators = [];
    this.gains.forEach((gain) => gain.disconnect());
    this.gains = [];
  }

  private burst(kind: "ringtone" | "ended"): void {
    const context = this.context;
    if (!context || !this.playing || !this.destination) return;
    this.clearBurst();
    const notes = kind === "ended" ? callEndedNotes : ringtoneNotes[this.tone];
    for (const note of notes) {
      const start = context.currentTime + note.offset;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(kind === "ended" ? 0.08 : 0.12, start + 0.02);
      gain.gain.setValueAtTime(kind === "ended" ? 0.08 : 0.12, start + note.duration - 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);
      gain.connect(this.destination);
      this.gains.push(gain);
      note.frequencies.forEach((frequency) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start(start);
        oscillator.stop(start + note.duration);
        this.oscillators.push(oscillator);
      });
    }
  }
}
