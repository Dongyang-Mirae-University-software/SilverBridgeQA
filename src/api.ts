/**
 * BE API 를 직접 호출하는 클라이언트. 테스트 준비(셋업)와 화면 결과의 교차 검증에 쓴다.
 * 화면 동작 자체는 반드시 브라우저로 검증하고, 이것은 보조 수단으로만 쓴다.
 */
import { APIRequestContext, request } from '@playwright/test';

import { Account } from './accounts';
import { env } from './env';
import { relaxRateLimits } from './seed';

export interface Envelope<T> {
  success: boolean;
  message?: string;
  data: T;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
  role: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

export class Api {
  private constructor(
    private readonly ctx: APIRequestContext,
    readonly login: LoginResult,
  ) {}

  static async signin(email: string, password: string): Promise<LoginResult> {
    const ctx = await request.newContext({ baseURL: env.apiUrl });
    try {
      const res = await ctx.post('/api/auth/signin', { data: { email, password } });
      const text = await res.text();
      if (!res.ok()) throw new ApiError(res.status(), text, 'POST', '/api/auth/signin');
      return (JSON.parse(text) as Envelope<LoginResult>).data;
    } finally {
      await ctx.dispose();
    }
  }

  /**
   * 로그인하되, IP 레이트리밋(1분 10회) 초과로 막히면 카운터를 풀고 다시 시도한다.
   * 로그인 잠금(5회 실패)은 검증 대상이라 재시도하지 않고 그대로 던진다.
   */
  static async signinWithRetry(email: string, password: string, attempts = 4): Promise<LoginResult> {
    for (let i = 1; ; i++) {
      try {
        return await Api.signin(email, password);
      } catch (error) {
        const rateLimited = error instanceof ApiError && error.status === 429 && error.body.includes('요청이 너무 많습니다');
        if (!rateLimited || i >= attempts) throw error;
        relaxRateLimits();
        await new Promise(resolve => setTimeout(resolve, 500 * i));
      }
    }
  }

  /**
   * 새로 로그인해서 클라이언트를 만든다. 그 계정의 기존 refresh token 이 폐기되므로
   * 열려 있는 브라우저가 없는 계정에만 쓴다. 보통은 fixtures 의 apiAs 를 쓴다.
   */
  static async as(account: Account, password = env.password): Promise<Api> {
    return Api.fromLogin(await Api.signin(account.email, password));
  }

  /** 이미 받은 토큰으로 호출 (로그인을 새로 하지 않는다) */
  static async fromLogin(login: LoginResult): Promise<Api> {
    const ctx = await request.newContext({
      baseURL: env.apiUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${login.accessToken}` },
    });
    return new Api(ctx, login);
  }

  async raw(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown) {
    return this.ctx.fetch(path, { method, data });
  }

  async call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
    const res = await this.raw(method, path, data);
    const text = await res.text();
    if (!res.ok()) throw new ApiError(res.status(), text, method, path);
    return text ? (JSON.parse(text) as Envelope<T>).data : (undefined as T);
  }

  get<T = unknown>(path: string) {
    return this.call<T>('GET', path);
  }

  post<T = unknown>(path: string, data?: unknown) {
    return this.call<T>('POST', path, data);
  }

  async dispose() {
    await this.ctx.dispose();
  }
}
