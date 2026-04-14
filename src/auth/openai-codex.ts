import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { execa } from 'execa';

import { nowIso } from '../lib/utils.js';
import { Notebook } from '../storage/notebook.js';
import type { OpenAICodexAuthRecord, OpenAICodexJwtClaims } from '../types.js';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
export const OPENAI_CODEX_PROVIDER = 'openai-codex';
export const OPENAI_CODEX_ORIGINATOR = 'codex_cli_rs';
export const OPENAI_CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const OPENAI_API_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface OpenAICodexAuthOptions {
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  notify?: (message: string) => void;
  now?: () => number;
  apiKey?: string | null;
}

interface AuthorizeOptions {
  port?: number;
  timeoutMs?: number;
}

export class OpenAICodexAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly notify: (message: string) => void;
  private readonly now: () => number;
  private readonly apiKey: string | null;

  constructor(
    private readonly notebook: Notebook,
    options: OpenAICodexAuthOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.openUrl = options.openUrl ?? openBrowserUrl;
    this.notify = options.notify ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.apiKey = resolveApiKey(options.apiKey);
  }

  async authorize(options: AuthorizeOptions = {}): Promise<OpenAICodexAuthRecord> {
    const pkce = generatePKCE();
    const state = generateState();
    const listenHost = '127.0.0.1';
    const redirectHost = 'localhost';
    const port = options.port ?? 1455;
    const timeoutMs = options.timeoutMs ?? 180_000;

    return new Promise<OpenAICodexAuthRecord>((resolve, reject) => {
      let settled = false;
      let redirectUri = '';

      const server = createServer(async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? '/', `http://${redirectHost}:${port}`);

          if (requestUrl.pathname !== '/auth/callback') {
            respondHtml(res, 404, 'Not Found', '<p>OpenAI Codex OAuth callback not found.</p>');
            return;
          }

          const returnedState = requestUrl.searchParams.get('state');
          const code = requestUrl.searchParams.get('code');
          const error = requestUrl.searchParams.get('error');
          const errorDescription = requestUrl.searchParams.get('error_description');

          if (error) {
            const message = errorDescription ? `${error}: ${errorDescription}` : error;
            respondHtml(res, 400, 'Authentication failed', `<p>${escapeHtml(message)}</p>`);
            finish(new Error(`OAuth authorization failed: ${message}`));
            return;
          }

          if (returnedState !== state) {
            respondHtml(res, 400, 'Authentication failed', '<p>State mismatch.</p>');
            finish(new Error('OAuth state mismatch.'));
            return;
          }

          if (!code) {
            respondHtml(res, 400, 'Authentication failed', '<p>Missing authorization code.</p>');
            finish(new Error('Missing OAuth authorization code.'));
            return;
          }

          const tokens = await exchangeCodeForTokens(
            code,
            pkce.codeVerifier,
            redirectUri,
            this.fetchImpl,
            this.now
          );
          this.notebook.upsertOpenAICodexAuth(tokens);
          respondHtml(
            res,
            200,
            'Authentication complete',
            '<p>OpenAI Codex authentication succeeded. You can return to the terminal.</p>'
          );
          finish(undefined, tokens);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respondHtml(res, 500, 'Authentication failed', `<p>${escapeHtml(message)}</p>`);
          finish(error instanceof Error ? error : new Error(message));
        }
      });

      const timeout = setTimeout(() => {
        finish(new Error(`Timed out waiting for OAuth callback after ${timeoutMs}ms.`));
      }, timeoutMs);

      const finish = (error?: Error, tokens?: OpenAICodexAuthRecord): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        server.close();

        if (error) {
          reject(error);
          return;
        }

        resolve(tokens as OpenAICodexAuthRecord);
      };

      server.listen(port, listenHost, async () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(new Error('OAuth callback server did not expose a TCP port.'));
          return;
        }

        redirectUri = `http://${redirectHost}:${(address as AddressInfo).port}/auth/callback`;
        const authUrl = buildAuthorizationUrl(pkce, state, redirectUri);
        this.notify(`Open this URL if the browser does not launch:\n${authUrl}`);

        try {
          await this.openUrl(authUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.notify(`Browser launch failed. Open the URL manually:\n${authUrl}\n\n${message}`);
        }
      });
    });
  }

  async access(): Promise<string | undefined> {
    if (this.apiKey) {
      return this.apiKey;
    }

    const current = this.notebook.getOpenAICodexAuth();
    if (!current) {
      return undefined;
    }

    if (!shouldRefreshToken(current.expiresAt, this.now())) {
      return current.accessToken;
    }

    if (!current.refreshToken) {
      return undefined;
    }

    const refreshed = await refreshTokens(
      current.refreshToken,
      this.fetchImpl,
      this.now
    );

    const next: OpenAICodexAuthRecord = {
      ...current,
      ...refreshed,
      refreshToken: refreshed.refreshToken || current.refreshToken,
      createdAt: current.createdAt,
      updatedAt: refreshed.updatedAt
    };

    this.notebook.upsertOpenAICodexAuth(next);
    return next.accessToken;
  }

  getStored(): OpenAICodexAuthRecord | null {
    return this.notebook.getOpenAICodexAuth();
  }

  formatStatus(): string {
    if (this.apiKey) {
      const oauthRecord = this.notebook.getOpenAICodexAuth();
      return [
        'OpenAI API key auth',
        'source: OPENAI_API_KEY',
        `codex oauth fallback: ${oauthRecord ? 'present' : 'missing'}`
      ].join('\n');
    }

    const record = this.notebook.getOpenAICodexAuth();
    if (!record) {
      return 'Model authentication is not configured. Set OPENAI_API_KEY or run `h2 auth login`.';
    }

    const expiry = new Date(record.expiresAt).toISOString();
    return [
      'OpenAI Codex OAuth',
      `account: ${record.accountId || '(unknown)'}`,
      `expires: ${expiry}`,
      `refresh token: ${record.refreshToken ? 'present' : 'missing'}`
    ].join('\n');
  }

  logout(): boolean {
    return this.notebook.deleteOpenAICodexAuth();
  }
}

function resolveApiKey(value: string | null | undefined): string | null {
  const key = value ?? process.env.OPENAI_API_KEY;
  if (typeof key !== 'string') {
    return null;
  }

  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isCodexResponsesEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.hostname === 'chatgpt.com' ||
      parsed.hostname.endsWith('.chatgpt.com') ||
      parsed.pathname.includes('/backend-api/codex/')
    );
  } catch {
    return endpoint.includes('/backend-api/codex/');
  }
}

export function generatePKCE(): PKCECodes {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return randomBytes(16).toString('hex');
}

export function buildAuthorizationUrl(
  pkce: PKCECodes,
  state: string,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OPENAI_CODEX_ORIGINATOR
  });

  return `${OPENAI_CODEX_AUTH_ENDPOINT}?${params.toString()}`;
}

export function parseJWT(token: string): OpenAICodexJwtClaims | null {
  try {
    if (!token || token.split('.').length !== 3) {
      return null;
    }

    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }

    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(decoded) as OpenAICodexJwtClaims;
  } catch {
    return null;
  }
}

export function extractAccountId(idToken: string): string {
  const claims = parseJWT(idToken);
  return claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? '';
}

export function shouldRefreshToken(expiresAt: number, now = Date.now()): boolean {
  return now + 5 * 60 * 1000 >= expiresAt;
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<OpenAICodexAuthRecord> {
  const response = await fetchImpl(OPENAI_CODEX_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: codeVerifier
    })
  });

  const payload = await parseTokenResponse(response);
  return buildAuthRecord(payload, now);
}

async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<OpenAICodexAuthRecord> {
  const response = await fetchImpl(OPENAI_CODEX_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    })
  });

  const payload = await parseTokenResponse(response);
  return buildAuthRecord(payload, now);
}

async function parseTokenResponse(response: Response): Promise<TokenResponse> {
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as TokenResponse;
  if (!payload.access_token) {
    throw new Error('Token exchange failed: missing access token.');
  }

  return payload;
}

function buildAuthRecord(payload: TokenResponse, now: () => number): OpenAICodexAuthRecord {
  const claims = parseJWT(payload.access_token);
  const expiresAt = claims?.exp
    ? claims.exp * 1000
    : now() + (payload.expires_in ?? 3600) * 1000;
  const timestamp = nowIso();

  return {
    provider: OPENAI_CODEX_PROVIDER,
    type: 'oauth',
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? '',
    idToken: payload.id_token ?? '',
    accountId: extractAccountId(payload.id_token ?? ''),
    expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function openBrowserUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execa('open', [url]);
    return;
  }

  if (process.platform === 'win32') {
    await execa('cmd', ['/c', 'start', '', url]);
    return;
  }

  await execa('xdg-open', [url]);
}

function respondHtml(
  res: ServerResponse,
  statusCode: number,
  title: string,
  body: string
): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
