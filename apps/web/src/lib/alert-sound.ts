/**
 * Som padrão escolhido: "05 — Atenção".
 * Quatro bipes curtos em um segundo, gerados no próprio navegador. Não baixa
 * mídia, não compete com vídeo e respeita o botão global de silenciar alertas.
 */
export const NOTICE_SOUNDS = [
  { value: 'attention', label: 'Atenção (atual)', priority: 0 },
  { value: 'urgent', label: 'Urgente', priority: 1 },
  { value: 'siren', label: 'Sirene', priority: 3 },
  { value: 'intrusion', label: 'Alarme de invasão', priority: 4 },
  { value: 'rapid', label: 'Bipes rápidos', priority: 2 },
] as const;
export type NoticeSound = typeof NOTICE_SOUNDS[number]['value'];
export function normalizeNoticeSound(value: unknown): NoticeSound {
  return NOTICE_SOUNDS.some(sound => sound.value === value) ? value as NoticeSound : 'attention';
}

export function tocarSomDeAtencao(): void { void tocarSomDeAlerta('attention'); }

/** Short signals (one second). Explicit previews work even when alerts are muted. */
export async function tocarSomDeAlerta(sound: string = 'attention', preview = false): Promise<boolean> {
  try { if (!preview && window.localStorage.getItem('drac:alarm-sound-muted') === '1') return false; } catch { /* Storage may be restricted. */ }
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return false;

  const context = new AudioContextCtor();
  try {
    await context.resume();
    const inicio = context.currentTime;
    const selected = normalizeNoticeSound(sound);
    const pulse = (atraso: number, duration: number, frequency: number, endFrequency: number, type: OscillatorType, volume: number) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const comecaEm = inicio + atraso;
      const terminaEm = comecaEm + duration;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, comecaEm);
      oscillator.frequency.linearRampToValueAtTime(endFrequency, terminaEm);
      gain.gain.setValueAtTime(0.0001, comecaEm);
      gain.gain.linearRampToValueAtTime(volume, comecaEm + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, terminaEm);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(comecaEm);
      oscillator.stop(terminaEm);
    };
    if (selected === 'attention') for (const delay of [0.13, 0.30, 0.47, 0.64]) pulse(delay, 0.10, 1020, 1190, 'sine', 0.12);
    if (selected === 'urgent') for (const delay of [0.02, 0.33, 0.64]) pulse(delay, 0.23, 760, 1450, 'square', 0.16);
    if (selected === 'siren') {
      pulse(0.01, 0.45, 550, 1550, 'sawtooth', 0.20);
      pulse(0.48, 0.45, 1550, 550, 'sawtooth', 0.20);
    }
    if (selected === 'intrusion') for (let i = 0; i < 6; i++) pulse(0.01 + i * 0.15, 0.13, i % 2 ? 1450 : 720, i % 2 ? 1450 : 720, 'square', 0.18);
    if (selected === 'rapid') for (let i = 0; i < 8; i++) pulse(0.01 + i * 0.12, 0.08, 1350, 1700, 'square', 0.17);
    window.setTimeout(() => void context.close(), 1_050);
    return true;
  } catch { void context.close(); return false; }
}
