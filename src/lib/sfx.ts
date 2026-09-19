/**
 * Zarządzanie odtwarzaniem efektów dźwiękowych walki.
 * Domyślnie wyciszone, z możliwością włączenia przez użytkownika.
 *
 * Gong i cios syntezowane w Web Audio API.
 * Odliczanie i nokaut odtwarzane z plików TTS.
 */

export type SFXType =
  | 'gong'
  | 'punch'
  | 'count-1'
  | 'count-2'
  | 'count-3'
  | 'count-4'
  | 'count-5'
  | 'count-6'
  | 'count-7'
  | 'count-8'
  | 'count-9'
  | 'count-10'
  | 'knockout';

interface SFXPlayer {
  play(type: SFXType): Promise<void>;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

class BrowserSFXPlayer implements SFXPlayer {
  private audioCache = new Map<SFXType, HTMLAudioElement>();
  private audioContext: AudioContext | null = null;
  private muted = true; // domyślnie wyciszone

  constructor() {
    // Preload plików TTS (tylko odliczanie i nokaut)
    const ttsFiles: SFXType[] = [
      'count-1',
      'count-2',
      'count-3',
      'count-4',
      'count-5',
      'count-6',
      'count-7',
      'count-8',
      'count-9',
      'count-10',
      'knockout',
    ];

    for (const sound of ttsFiles) {
      const audio = new Audio(`/sfx/${sound}.mp3`);
      audio.preload = 'auto';
      this.audioCache.set(sound, audio);
    }

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

      // Pliki TTS (odliczanie i nokaut)
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
      setMuted: () => {},
      isMuted: () => true,
    };
  }

  if (!instance) {
    instance = new BrowserSFXPlayer();
  }

  return instance;
}

/**
 * Wygodny helper do odliczania 1..10 z opóźnieniem między liczbami.
 * @param delayMs opóźnienie między kolejnymi liczbami
 */
export async function playCountdown(delayMs = 800): Promise<void> {
  const player = getSFXPlayer();
  for (let i = 1; i <= 10; i++) {
    await player.play(`count-${i}` as SFXType);
    if (i < 10) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
