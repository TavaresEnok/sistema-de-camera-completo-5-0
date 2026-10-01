import assert from 'node:assert/strict';
import test from 'node:test';
import { of, throwError } from 'rxjs';
import { AiService } from '../src/ai/ai.service';

function service(post: (...args: any[]) => any) {
  const instance = Object.create(AiService.prototype) as any;
  instance.aiBaseUrl = 'http://ai-service:8000';
  instance.isDisabled = () => false;
  instance.internalHeaders = () => ({ 'x-service-token': 'test-only' });
  instance.httpService = { post };
  return instance as AiService;
}

test('one authenticated request, unique IDs, bounded timeout and response whitelist', async () => {
  let calls = 0;
  const ai = service((url, body, config) => {
    calls++;
    assert.equal(url, 'http://ai-service:8000/detections/latest-batch');
    assert.deepEqual(body, { camera_ids: ['a', 'b'], max_age_ms: 700, limit: 10 });
    assert.equal(config.timeout, 2000);
    assert.equal(config.headers['x-service-token'], 'test-only');
    return of({ data: { cameras: { a: { detections: [{ id: 'hit' }] }, forbidden: { detections: [{ id: 'secret' }] } } } });
  });
  const result = await ai.getLatestDetectionsBatch(['a', 'b', 'a'], 700, 10);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(result.cameras), ['a', 'b']);
  assert.equal(result.cameras.b.status, 'unavailable');
  assert.equal(result.cameras.a.detections[0].id, 'hit');
});

test('failure returns empty results without N individual retries', async () => {
  let calls = 0;
  const ai = service(() => { calls++; return throwError(() => new Error('timeout')); });
  const result = await ai.getLatestDetectionsBatch(['a', 'b']);
  assert.equal(calls, 1);
  assert.equal(result.cameras.a.status, 'unavailable');
  assert.deepEqual(result.cameras.b.detections, []);
});

test('empty batch does not contact AI', async () => {
  const ai = service(() => { throw new Error('unexpected call'); });
  assert.deepEqual((await ai.getLatestDetectionsBatch([])).cameras, {});
});
