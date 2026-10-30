import { renderSecurityAlarm, type SecurityAlarm } from './security-alarm-signal.ts';

/** The original “05 — Atenção” remains unchanged; other choices are security alarms. */
export const NOTICE_SOUNDS = [
  { value: 'attention', label: 'Atenção (atual)', priority: 0 },
  { value: 'urgent', label: 'Alarme de evacuação', priority: 1 },
  { value: 'siren', label: 'Sirene de emergência', priority: 5 },
  { value: 'intrusion', label: 'Sirene de invasão', priority: 4 },
  { value: 'rapid', label: 'Alarme pulsante', priority: 2 },
] as const;
export type NoticeSound = typeof NOTICE_SOUNDS[number]['value'];
export function normalizeNoticeSound(value: unknown): NoticeSound {
  return NOTICE_SOUNDS.some(sound => sound.value === value) ? value as NoticeSound : 'attention';
}

const renderedSignals = new Map<string, Float32Array>();
function securitySignal(kind: SecurityAlarm, sampleRate: number): Float32Array {
  const key = `${kind}:${sampleRate}`;
  let signal = renderedSignals.get(key);
  if (!signal) {
    signal = renderSecurityAlarm(kind, sampleRate);
    // Bound memory even if a browser changes audio devices/sample rates repeatedly.
    if (renderedSignals.size >= 12) renderedSignals.delete(renderedSignals.keys().next().value!);
    renderedSignals.set(key, signal);
  }
  return signal;
}

export function tocarSomDeAtencao(): void { void tocarSomDeAlerta('attention'); }

/** One-second signals. Explicit previews also work when automatic alerts are muted. */
export async function tocarSomDeAlerta(sound: string = 'attention', preview = false): Promise<boolean> {
  try { if (!preview && window.localStorage.getItem('drac:alarm-sound-muted') === '1') return false; } catch { /* Storage may be restricted. */ }
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return false;

  const context = new AudioContextCtor();
  let cleanupTimer: number | undefined;
  const close = () => {
    if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
    void context.close().catch(() => undefined);
  };
  try {
    await context.resume();
    if (context.state === 'suspended') { close(); return false; }
    const inicio = context.currentTime;
    const selected = normalizeNoticeSound(sound);
    if (selected === 'attention') {
      // Preserve all original times, frequencies, waveform, gain and envelopes.
      for (const delay of [0.13, 0.30, 0.47, 0.64]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const comecaEm = inicio + delay;
        const terminaEm = comecaEm + 0.10;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1020, comecaEm);
        oscillator.frequency.linearRampToValueAtTime(1190, terminaEm);
        gain.gain.setValueAtTime(0.0001, comecaEm);
        gain.gain.linearRampToValueAtTime(0.12, comecaEm + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, terminaEm);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(comecaEm);
        oscillator.stop(terminaEm);
      }
      cleanupTimer = window.setTimeout(close, 1_050);
    } else {
      const signal = securitySignal(selected, context.sampleRate);
      const buffer = context.createBuffer(1, signal.length, context.sampleRate);
      buffer.getChannelData(0).set(signal);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = close;
      // Rendering can take a few ms on older clients; schedule after rendering.
      source.start(context.currentTime);
      cleanupTimer = window.setTimeout(close, 1_500);
    }
    return true;
  } catch { close(); return false; }
}
