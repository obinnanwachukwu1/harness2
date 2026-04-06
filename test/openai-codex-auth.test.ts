import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildAuthorizationUrl,
  extractAccountId,
  generatePKCE,
  OpenAICodexAuth,
  parseJWT,
  shouldRefreshToken
} from '../src/auth/openai-codex.js';
import { Notebook } from '../src/storage/notebook.js';
import { cleanupDir, createTempDir, createUnsignedJwt } from '../test-support/helpers.js';

test('OpenAICodexAuth authorization URL includes PKCE and Codex flags', () => {
  const pkce = generatePKCE();
  const url = new URL(
    buildAuthorizationUrl(pkce, 'state-123', 'http://localhost:1455/auth/callback')
  );

  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pkce.codeChallenge, /^[A-Za-z0-9_-]+$/);
});

test('OpenAICodexAuth parses JWT claims and account id', () => {
  const token = createUnsignedJwt({
    exp: 1_900_000_000,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_123'
    }
  });

  const claims = parseJWT(token);
  assert.equal(claims?.exp, 1_900_000_000);
  assert.equal(extractAccountId(token), 'acct_123');
  assert.equal(parseJWT('not-a-jwt'), null);
});

test('OpenAICodexAuth authorize stores tokens through localhost callback flow', async (t) => {
  const tempDir = await createTempDir('h2-auth-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const now = 1_700_000_000_000;
  const accessToken = createUnsignedJwt({
    exp: Math.floor((now + 60 * 60 * 1000) / 1000)
  });
  const idToken = createUnsignedJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_live'
    }
  });

  let openedUrl = '';
  const auth = new OpenAICodexAuth(notebook, {
    now: () => now,
    openUrl: async (url) => {
      openedUrl = url;
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      assert.ok(redirectUri);
      assert.ok(state);

      queueMicrotask(async () => {
        const callbackUrl = new URL(redirectUri as string);
        callbackUrl.searchParams.set('code', 'auth-code-123');
        callbackUrl.searchParams.set('state', state as string);
        await fetch(callbackUrl);
      });
    },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'https://auth.openai.com/oauth/token');
      assert.equal(init?.method, 'POST');
      const body = init?.body;
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'auth-code-123');

      return Response.json({
        access_token: accessToken,
        refresh_token: 'refresh_123',
        id_token: idToken
      });
    }
  });

  const record = await auth.authorize({ port: 0, timeoutMs: 5_000 });
  assert.match(openedUrl, /oauth\/authorize/);
  assert.equal(record.accountId, 'acct_live');
  assert.equal(notebook.getOpenAICodexAuth()?.refreshToken, 'refresh_123');
});

test('OpenAICodexAuth access refreshes tokens nearing expiry', async (t) => {
  const tempDir = await createTempDir('h2-auth-refresh-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: 'old-access',
    refreshToken: 'refresh-old',
    idToken: '',
    accountId: 'acct_old',
    expiresAt: now + 60_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const nextAccess = createUnsignedJwt({
    exp: Math.floor((now + 2 * 60 * 60 * 1000) / 1000)
  });

  const auth = new OpenAICodexAuth(notebook, {
    now: () => now,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'https://auth.openai.com/oauth/token');
      const body = init?.body;
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'refresh-old');

      return Response.json({
        access_token: nextAccess,
        refresh_token: 'refresh-new',
        id_token: ''
      });
    }
  });

  assert.equal(shouldRefreshToken(now + 60_000, now), true);
  const token = await auth.access();
  assert.equal(token, nextAccess);
  assert.equal(notebook.getOpenAICodexAuth()?.refreshToken, 'refresh-new');
});
