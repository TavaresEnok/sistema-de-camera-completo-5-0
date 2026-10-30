import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTICE_SOUNDS, tocarSomDeAlerta } from '../src/lib/alert-sound.ts';
import { renderSecurityAlarm, SECURITY_ALARM_PEAK, type SecurityAlarm } from '../src/lib/security-alarm-signal.ts';

const alarmKinds: SecurityAlarm[] = ['urgent', 'siren', 'intrusion', 'rapid'];

test('security alarms have a sustained body, one-second duration and clean bounded edges at device sample rates', () => {
  for (const rate of [8_000, 44_100, 48_000, 96_000]) {
    const signals = alarmKinds.map(kind => renderSecurityAlarm(kind, rate));
    for (const signal of signals) {
      assert.equal(signal.length, rate);
      assert.ok(signal.every(Number.isFinite));
      let peak = 0, energy = 0;
      for (const value of signal) { peak = Math.max(peak, Math.abs(value)); energy += value * value; }
      assert.ok(peak <= SECURITY_ALARM_PEAK, 'no clipped PCM samples');
      assert.ok(peak > 0.6, 'alarm is not accidentally attenuated');
      assert.ok(Math.sqrt(energy / signal.length) > 0.25, 'sustained alarm rather than tiny decaying chirps');
      assert.equal(signal[0], 0);
      assert.ok(Math.abs(signal.at(-1)!) < 0.0001, 'clean release, no end click');
    }
    for (let i = 0; i < signals.length; i++) for (let j = i + 1; j < signals.length; j++) {
      let difference = 0;
      for (let n = 0; n < rate; n++) difference += (signals[i][n] - signals[j][n]) ** 2;
      assert.ok(Math.sqrt(difference / rate) > 0.3, 'choices must sound materially different');
    }
  }
  assert.throws(() => renderSecurityAlarm('siren', Number.NaN), RangeError);
  assert.throws(() => renderSecurityAlarm('siren', 0), RangeError);
});

test('original attention is preserved exactly; security buffers, mute, previews and resource cleanup work', async () => {
  let muted = false;
  const records: any[] = [];
  class AudioContext {
    currentTime = 0; sampleRate = 48_000; state = 'running'; destination = {};
    record: any = { pulses: [], buffers: [], sources: [], closed: 0 };
    constructor() { records.push(this.record); }
    resume() { return Promise.resolve(); }
    close() { this.record.closed++; return Promise.resolve(); }
    createOscillator() {
      const pulse: any = { frequency: [] }; this.record.pulses.push(pulse);
      return { type: 'sine', frequency: { setValueAtTime(v: number, t: number) { pulse.frequency.push([v, t]); }, linearRampToValueAtTime(v: number, t: number) { pulse.frequency.push([v, t]); } }, connect() {}, start(t: number) { pulse.start = t; }, stop(t: number) { pulse.stop = t; pulse.type = this.type; } };
    }
    createGain() {
      const pulse = this.record.pulses.at(-1); pulse.envelope = [];
      return { gain: { setValueAtTime(v: number, t: number) { pulse.envelope.push(['set', v, t]); }, linearRampToValueAtTime(v: number, t: number) { pulse.envelope.push(['linear', v, t]); }, exponentialRampToValueAtTime(v: number, t: number) { pulse.envelope.push(['exponential', v, t]); } }, connect() {} };
    }
    createBuffer(channels: number, length: number, rate: number) {
      const data = new Float32Array(length);
      this.record.buffers.push({ channels, length, rate, data });
      return { getChannelData() { return data; } };
    }
    createBufferSource() { const source = { buffer: null, onended: null as null | (() => void), connect() {}, start() {} }; this.record.sources.push(source); return source; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext, localStorage: { getItem() { return muted ? '1' : null; } }, setTimeout() { return 0; }, clearTimeout() {} } });
  try {
    assert.equal(await tocarSomDeAlerta('attention'), true);
    const original = records[0];
    assert.equal(original.buffers.length, 0);
    assert.deepEqual(original.pulses, [0.13, 0.30, 0.47, 0.64].map(delay => ({ frequency: [[1020, delay], [1190, delay + 0.10]], start: delay, stop: delay + 0.10, type: 'sine', envelope: [['set', 0.0001, delay], ['linear', 0.12, delay + 0.012], ['exponential', 0.0001, delay + 0.10]] })));
    for (const kind of alarmKinds) {
      assert.equal(await tocarSomDeAlerta(kind), true);
      const current = records.at(-1)!;
      assert.equal(current.buffers.length, 1);
      assert.equal(current.buffers[0].length, 48_000);
      assert.equal(current.sources.length, 1);
      current.sources[0].onended();
      assert.equal(current.closed, 1);
    }
    assert.equal(NOTICE_SOUNDS.find(x => x.value === 'siren')!.priority, Math.max(...NOTICE_SOUNDS.map(x => x.priority)));
    muted = true;
    const before = records.length;
    assert.equal(await tocarSomDeAlerta('siren'), false);
    assert.equal(records.length, before);
    assert.equal(await tocarSomDeAlerta('siren', true), true);
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});
