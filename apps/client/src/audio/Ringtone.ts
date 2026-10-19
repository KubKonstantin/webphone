import { setAudioOutput } from "./devices";

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

  async configure(outputId: string, extraId: string): Promise<void> {
    if (this.players[0]) await setAudioOutput(this.players[0], outputId);
    if (extraId) await setAudioOutput(this.players[1] ?? new Audio(), extraId);
    this.outputId = outputId;
    this.extraId = extraId && extraId !== outputId ? extraId : "";
    if (!this.extraId) this.players[1]?.pause();
  }

  /** Called during a user gesture; no microphone is opened. */
  async unlock(): Promise<void> {
    this.prepare();
    await this.context!.resume();
  }

  async start(test = false): Promise<void> {
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
    const ids = [this.outputId, ...(this.extraId ? [this.extraId] : [])];
    // A failure on the additional device must not silence the primary ringtone.
    const results = await Promise.allSettled(ids.map(async (id, index) => {
      const player = this.players[index]!;
      await setAudioOutput(player, id);
      if (generation !== this.generation) return;
      await player.play();
      if (generation !== this.generation) player.pause();
    }));
    if (generation !== this.generation) return;
    this.playing = true;
    this.burst();
    if (test) this.testTimer = window.setTimeout(() => this.stop(), 1200);
    else this.interval = window.setInterval(() => this.burst(), 3000);
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

  private burst(): void {
    const context = this.context;
    if (!context || !this.playing || !this.destination) return;
    this.clearBurst();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.03);
    gain.gain.setValueAtTime(0.12, context.currentTime + 0.75);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.95);
    gain.connect(this.destination);
    this.gains.push(gain);
    this.oscillators = [440, 480].map((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(context.currentTime + 1);
      return oscillator;
    });
  }
}
