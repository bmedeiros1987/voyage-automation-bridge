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

test('root redirects to mobile console', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/console');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('mobile console is public shell but does not embed secrets', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/console`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/html/);
    assert.match(response.headers.get('content-security-policy') || '', /connect-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const body = await response.text();
    assert.match(body, /Voyage Automation/);
    assert.match(body, /BRIDGE_API_KEY/);
    assert.match(body, /Google OAuth · Audience/);
    assert.equal(body.includes('sk-tinyfish-'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
