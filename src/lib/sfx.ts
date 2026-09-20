/**
 * Zarządzanie odtwarzaniem efektów dźwiękowych walki.
 * Domyślnie wyciszone, z możliwością włączenia przez użytkownika.
 *
 * Gong, cios i gwar trybun przy nokdaunie syntezowane w Web Audio API.
 * Nokaut odtwarzany z pliku TTS.
 */

export type SFXType = 'gong' | 'punch' | 'knockout';

/** Uchwyt na trwający gwar trybun — wywołujący decyduje, jak się kończy. */
export interface CrowdSwellHandle {
  /** Kończy gwar: `true` = wybuch (nokaut), `false` = opadnięcie (zawodnik wstaje). */
  end(knockout: boolean): void;
}

interface SFXPlayer {
  play(type: SFXType): Promise<void>;
  /** Startuje syntetyczny gwar trybun, narastający przez `riseMs`. */
  startCrowdSwell(riseMs: number): CrowdSwellHandle;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

const NOOP_SWELL: CrowdSwellHandle = { end: () => {} };

class BrowserSFXPlayer implements SFXPlayer {
  private audioCache = new Map<SFXType, HTMLAudioElement>();
  private audioContext: AudioContext | null = null;
  private pinkNoiseBuffer: AudioBuffer | null = null;
  private muted = true; // domyślnie wyciszone

  constructor() {
    // Preload pliku TTS (tylko nokaut)
    const audio = new Audio(`/sfx/knockout.mp3`);
    audio.preload = 'auto';
    this.audioCache.set('knockout', audio);

    // Wczytaj ustawienie z localStorage
    const saved = localStorage.getItem('sfx-muted');
    if (saved !== null) {
      this.muted = saved === 'true';
    }
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  /**
   * Różowy szum (filtr 1/f metodą Paula Kelleta), zapętlony bufor 4s —
   * wystarczy na najdłuższe odliczanie (nokaut, countTo 10).
   */
  private getPinkNoiseBuffer(): AudioBuffer {
    if (this.pinkNoiseBuffer) return this.pinkNoiseBuffer;

    const ctx = this.getAudioContext();
    const duration = 4;
    const length = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11;
    }

    this.pinkNoiseBuffer = buffer;
    return buffer;
  }

  /**
   * Syntezuje chiński tam-tam: 7 oscylatorów nieharmonicznych z dudnieniem,
   * narastaniem jasności (filtr otwiera się 800→5000 Hz), filtrowanym szumem
   * na ataku (500-3000 Hz, 150ms) i różnymi czasami wygaszania (3-5s).
   * Nieharmoniczne częstotliwości (90, 143, 218, 291, 377, 460, 612 Hz) + rozstrój ±2 Hz.
   */
  private async playGong(): Promise<void> {
    const ctx = this.getAudioContext();
    const now = ctx.currentTime;

    // Nieharmoniczne częstotliwości + lekki rozstrój dla dudnienia
    const frequencies = [
      90 + (Math.random() * 4 - 2),
      143 + (Math.random() * 4 - 2),
      218 + (Math.random() * 4 - 2),
      291 + (Math.random() * 4 - 2),
      377 + (Math.random() * 4 - 2),
      460 + (Math.random() * 4 - 2),
      612 + (Math.random() * 4 - 2),
    ];

    // Różne czasy wygaszania dla każdego oscylatora (3-5s)
    const decays = [3.2, 3.5, 4.1, 3.8, 4.5, 3.6, 4.8];

    // Główny gain z filtrem dla narastania jasności
    const masterGain = ctx.createGain();
    const brightnessFilter = ctx.createBiquadFilter();
    brightnessFilter.type = 'lowpass';
    brightnessFilter.Q.setValueAtTime(0.7, now);

    // Filtr otwiera się 800 Hz → 5000 Hz w ciągu 0.5s
    brightnessFilter.frequency.setValueAtTime(800, now);
    brightnessFilter.frequency.exponentialRampToValueAtTime(5000, now + 0.5);

    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(0.35, now + 0.02);
    masterGain.gain.exponentialRampToValueAtTime(0.001, now + 5);

    // Utworzenie 7 oscylatorów
    const oscillators = frequencies.map((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      // Każdy oscylator z własnym czasem wygaszania
      const decay = decays[i];
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + decay);

      osc.connect(gain);
      gain.connect(brightnessFilter);

      return { osc, decay };
    });

    brightnessFilter.connect(masterGain);
    masterGain.connect(ctx.destination);

    // Szum pasmowy na ataku (500-3000 Hz, 150ms) dla metalicznego uderzenia
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) {
      noiseData[i] = (Math.random() * 2 - 1) * 0.5;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    // Filtr pasmowy 500-3000 Hz
    const noiseBandpass = ctx.createBiquadFilter();
    noiseBandpass.type = 'bandpass';
    noiseBandpass.frequency.setValueAtTime(1750, now); // środek 500-3000
    noiseBandpass.Q.setValueAtTime(1.5, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    noise.connect(noiseBandpass);
    noiseBandpass.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);

    // Startuj wszystkie oscylatory
    const maxDecay = Math.max(...decays);
    oscillators.forEach(({ osc, decay }) => {
      osc.start(now);
      osc.stop(now + decay);
    });
  }

  /**
   * Syntezuje odgłos ciosu: krótki szum (biały, ~80 ms) przez filtr
   * dolnoprzepustowy ~800 Hz, gwałtowne wygaszanie.
   */
  private async playPunch(): Promise<void> {
    const ctx = this.getAudioContext();
    const now = ctx.currentTime;
    const duration = 0.08; // 80 ms

    // Biały szum
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Filtr dolnoprzepustowy ~800 Hz
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, now);

    // Gwałtowne wygaszanie
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
    noise.stop(now + duration);
  }

  /**
   * Gwar trybun przy nokdaunie: filtrowany różowy szum (bandpass ~300-2000 Hz)
   * przez kilka wolnych LFO dla falowania głośności, narastający przez `riseMs`.
   * Wywołujący kończy go przez `end(knockout)`: opadnięcie, gdy zawodnik wstaje,
   * albo krótki wybuch głośności, gdy to nokaut.
   */
  startCrowdSwell(riseMs: number): CrowdSwellHandle {
    if (this.muted || riseMs <= 0) return NOOP_SWELL;

    const ctx = this.getAudioContext();
    const now = ctx.currentTime;
    const riseSec = Math.max(0.05, riseMs / 1000);

    const noise = ctx.createBufferSource();
    noise.buffer = this.getPinkNoiseBuffer();
    noise.loop = true;

    // Pasmo ~300-2000 Hz (środek geometryczny ≈ 775 Hz)
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(775, now);
    bandpass.Q.setValueAtTime(0.55, now);

    // Falowanie głośności: kilka wolnych LFO sumowanych na jednym AudioParam
    const wobble = ctx.createGain();
    wobble.gain.setValueAtTime(1, now);
    const lfoConfig = [
      { freq: 0.17, depth: 0.12 },
      { freq: 0.31, depth: 0.08 },
      { freq: 0.53, depth: 0.05 },
    ];
    const lfoNodes = lfoConfig.map(({ freq, depth }) => {
      const lfo = ctx.createOscillator();
      lfo.frequency.setValueAtTime(freq, now);
      const depthGain = ctx.createGain();
      depthGain.gain.setValueAtTime(depth, now);
      lfo.connect(depthGain);
      depthGain.connect(wobble.gain);
      lfo.start(now);
      return lfo;
    });

    // Narastanie gwaru przez cały czas liczenia
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0.0001, now);
    swell.gain.exponentialRampToValueAtTime(0.02, now + Math.min(0.15, riseSec * 0.3));
    swell.gain.linearRampToValueAtTime(0.18, now + riseSec);

    noise.connect(bandpass);
    bandpass.connect(wobble);
    wobble.connect(swell);
    swell.connect(ctx.destination);
    noise.start(now);

    let ended = false;
    const stop = (at: number) => {
      noise.stop(at);
      lfoNodes.forEach((lfo) => lfo.stop(at));
    };

    return {
      end: (knockout: boolean) => {
        if (ended) return;
        ended = true;

        const endNow = ctx.currentTime;
        swell.gain.cancelScheduledValues(endNow);
        swell.gain.setValueAtTime(swell.gain.value, endNow);

        if (knockout) {
          // Krótki wybuch głośności — ryk tłumu
          swell.gain.linearRampToValueAtTime(0.5, endNow + 0.15);
          swell.gain.exponentialRampToValueAtTime(0.001, endNow + 0.5);
          stop(endNow + 0.55);
        } else {
          // Opadnięcie, gdy zawodnik wstaje
          swell.gain.exponentialRampToValueAtTime(0.001, endNow + 0.4);
          stop(endNow + 0.45);
        }
      },
    };
  }

  async play(type: SFXType): Promise<void> {
    if (this.muted) return;

    try {
      // Synteza dźwięków
      if (type === 'gong') {
        await this.playGong();
        return;
      }
      if (type === 'punch') {
        await this.playPunch();
        return;
      }

      // Plik TTS (nokaut)
      const audio = this.audioCache.get(type);
      if (!audio) return;

      audio.currentTime = 0;
      await audio.play();
    } catch (err) {
      // Ignore errors (np. autoplay policy)
      console.debug(`SFX play failed for ${type}:`, err);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    localStorage.setItem('sfx-muted', String(muted));
  }

  isMuted(): boolean {
    return this.muted;
  }
}

// Singleton
let instance: SFXPlayer | null = null;

export function getSFXPlayer(): SFXPlayer {
  if (typeof window === 'undefined') {
    // SSR fallback
    return {
      play: async () => {},
      startCrowdSwell: () => NOOP_SWELL,
      setMuted: () => {},
      isMuted: () => true,
    };
  }

  if (!instance) {
    instance = new BrowserSFXPlayer();
  }

  return instance;
}
