/**
 * Som padrão escolhido: "05 — Atenção".
 * Quatro bipes curtos em um segundo, gerados no próprio navegador. Não baixa
 * mídia, não compete com vídeo e respeita o botão global de silenciar alertas.
 */
export function tocarSomDeAtencao(): void {
  if (window.localStorage.getItem('drac:alarm-sound-muted') === '1') return;
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  const context = new AudioContextCtor();
  void context.resume().then(() => {
    const inicio = context.currentTime;
    for (const atraso of [0.13, 0.30, 0.47, 0.64]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const comecaEm = inicio + atraso;
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
    window.setTimeout(() => void context.close(), 1_050);
  }).catch(() => void context.close());
}
