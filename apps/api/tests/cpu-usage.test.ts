import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuBusyPercent, CpuUsageSampler } from '../src/health/helpers/cpu-usage.helper';

test('CPU mede trabalho no intervalo, não carga acumulada nem soma acima de 100%', () => {
  assert.ok(Math.abs(cpuBusyPercent({idle: 0,total: 0}, {idle: 310,total: 1000})! - 69) < 0.001);
  assert.equal(cpuBusyPercent({idle: 0,total: 0}, {idle: 0,total: 1000}), 100);
  assert.equal(cpuBusyPercent({idle: 0,total: 0}, {idle: 1000,total: 1000}), 0);
  assert.equal(cpuBusyPercent({idle: 0,total: 0}, {idle: 0,total: 0}), null);
  assert.equal(cpuBusyPercent({idle: 0,total: 0}, {idle: 200,total: 100}), null);
});

test('clientes simultâneos compartilham uma amostra e cache, sem timers permanentes', async () => {
  let time = 0, reads = 0, waits = 0;
  const sampler = new CpuUsageSampler(() => ({idle: ++reads * 31,total: reads * 100}),
    async (ms) => { waits++; time += ms; }, () => time);
  const results = await Promise.all(Array.from({length: 20}, () => sampler.sample()));
  assert.equal(reads, 2);
  assert.equal(waits, 1);
  assert.ok(results.every(r => Math.abs(r.percent! - 69) < 0.001));
  assert.equal(results[0].windowMs, 1000);
  await sampler.sample();
  assert.equal(reads, 2);
  time += 3000;
  await sampler.sample();
  assert.equal(reads, 4);
});
