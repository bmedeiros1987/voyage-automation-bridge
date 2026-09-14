import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validateTargetUrl } from '../server.js';

test('allows configured Google Cloud host over HTTPS', () => {
  const result = validateTargetUrl('https://console.cloud.google.com/apis/credentials');
  assert.equal(result.ok, true);
});

test('rejects non-HTTPS URLs', () => {
  const result = validateTargetUrl('http://console.cloud.google.com/apis/credentials');
  assert.deepEqual(result, { ok: false, error: 'https_required' });
});

test('rejects hosts outside the allowlist', () => {
  const result = validateTargetUrl('https://example.com');
  assert.deepEqual(result, { ok: false, error: 'host_not_allowed' });
});

test('health endpoint responds without exposing secret values', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'voyage-automation-bridge');
    assert.equal(typeof body.tinyfishConfigured, 'boolean');
    assert.equal(typeof body.bridgeAuthConfigured, 'boolean');
    assert.equal(JSON.stringify(body).includes('sk-tinyfish-'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
