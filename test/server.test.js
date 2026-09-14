import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  createSessionToken,
  resolveProfileId,
  validateTargetUrl,
  verifySessionToken,
} from '../server.js';

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

test('server profile id is used when request omits one', () => {
  assert.equal(resolveProfileId('', 'prof_example123'), 'prof_example123');
  assert.equal(resolveProfileId('prof_override456', 'prof_example123'), 'prof_override456');
});

test('session token is signed and expires', () => {
  const now = Date.UTC(2026, 8, 14, 21, 0, 0);
  const token = createSessionToken('bridge-secret-for-test', now, 60);
  assert.equal(verifySessionToken(token, 'bridge-secret-for-test', now + 30_000), true);
  assert.equal(verifySessionToken(token, 'wrong-secret', now + 30_000), false);
  assert.equal(verifySessionToken(token, 'bridge-secret-for-test', now + 61_000), false);
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
    assert.equal(typeof body.tinyfishProfileConfigured, 'boolean');
    assert.equal(JSON.stringify(body).includes('sk-tinyfish-'), false);
    assert.equal(JSON.stringify(body).includes('prof_'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('session status endpoint is public but does not expose credentials', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/session`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.authenticated, 'boolean');
    assert.equal(typeof body.profileConfigured, 'boolean');
    assert.equal(JSON.stringify(body).includes('prof_'), false);
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

test('mobile console uses cookie session and does not request profile id', async () => {
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
    assert.match(body, /Conectar este dispositivo/);
    assert.match(body, /Google OAuth · Audience/);
    assert.equal(body.includes('Profile ID'), false);
    assert.equal(body.includes('localStorage'), true);
    assert.equal(body.includes('sk-tinyfish-'), false);
    assert.equal(body.includes('prof_b7489f942af74283'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
