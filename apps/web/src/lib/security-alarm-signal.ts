/** Deterministic one-second security signals; no downloads or media permissions. */
export type SecurityAlarm = 'urgent' | 'siren' | 'intrusion' | 'rapid';
export const SECURITY_ALARM_SECONDS = 1;
export const SECURITY_ALARM_PEAK = 0.88;

/** Render layered horns, a mechanical air-raid wail and an intrusion warble.
 * Stable phase, band-limited harmonics, short edge fades and a soft limiter keep
 * the alarms forceful without digital clipping or clicks. Device volume still
 * belongs to the operator; this never changes the OS or browser volume.
 */
export function renderSecurityAlarm(kind: SecurityAlarm, sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError('Unsupported audio sample rate');
  }
  const samples = new Float32Array(Math.round(sampleRate * SECURITY_ALARM_SECONDS));
  const tau = Math.PI * 2;
  let phase = 0, twinPhase = 0, bassPhase = 0, air = 0;
  let random = 0x51c2a73;
  const smooth = (x: number) => { const v = Math.max(0, Math.min(1, x)); return v * v * (3 - 2 * v); };
  const horn = (p: number, hz: number) => {
    let value = 0;
    for (let harmonic = 1; harmonic <= 7; harmonic++) {
      if (hz * harmonic > sampleRate * 0.42) break;
      value += Math.sin(p * harmonic) * (harmonic % 2 ? 1 : 0.55) / Math.pow(harmonic, 1.15);
    }
    return value;
  };
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    let hz: number, twinHz: number, bassHz: number, pressure: number, texture: number;
    if (kind === 'siren') {
      // Twin mechanical rotors: a full civil-defence rise/fall, not a chirp.
      const climb = t < 0.47 ? smooth(t / 0.47) : 1 - smooth((t - 0.47) / 0.53);
      hz = 265 + 655 * climb;
      twinHz = hz * 1.037;
      bassHz = 112 + 74 * climb;
      pressure = 0.83 + 0.17 * Math.sin(tau * (24 * t + 8 * t * t));
      texture = 0.075;
    } else if (kind === 'intrusion') {
      // Fast two-tone security warble with sustained body between transitions.
      const alternate = Math.tanh(5 * Math.sin(tau * 6 * t));
      hz = 1_005 + 345 * alternate;
      twinHz = hz * 1.023;
      bassHz = 165;
      pressure = 0.86 + 0.14 * Math.sin(tau * 37 * t);
      texture = 0.045;
    } else if (kind === 'urgent') {
      // Industrial evacuation horn: simultaneous dissonant tones, no melody.
      hz = 520;
      twinHz = 780 + 12 * Math.sin(tau * 3 * t);
      bassHz = 130;
      pressure = 0.38 + 0.62 * smooth((Math.sin(tau * 3 * t) + 0.25) * 2);
      texture = 0.055;
    } else {
      // Five solid alarm bursts with clean gaps, rather than arcade bleeps.
      hz = 820;
      twinHz = 1_095;
      bassHz = 205;
      const burstTime = (t * 5) % 1;
      pressure = smooth(burstTime / 0.06) * (1 - smooth((burstTime - 0.72) / 0.12));
      texture = 0.035;
    }
    phase = (phase + tau * hz / sampleRate) % tau;
    twinPhase = (twinPhase + tau * twinHz / sampleRate) % tau;
    bassPhase = (bassPhase + tau * bassHz / sampleRate) % tau;
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    const white = (random >>> 0) / 0x80000000 - 1;
    air += (1 - Math.exp(-tau * 2_200 / sampleRate)) * (white - air);
    const body = 0.62 * horn(phase, hz) + 0.31 * horn(twinPhase, twinHz)
      + 0.18 * Math.sin(bassPhase) + texture * air;
    const edge = smooth(t / 0.008) * smooth((SECURITY_ALARM_SECONDS - t) / 0.045);
    samples[i] = SECURITY_ALARM_PEAK * Math.tanh(1.65 * body) * pressure * edge;
  }
  return samples;
}
