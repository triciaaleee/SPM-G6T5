/**
 * Stands in for `supertest` in the tests (see `test.alias` in vitest.config.ts) and answers the same calls -
 * request(app).get(url).set(...).send(...).query(...) - but runs them through the Express app in-process instead
 * of opening a socket. Real connections made the suite depend on the machine: ephemeral-port exhaustion, sockets
 * reused against a closed server, another app holding the same loopback port. With nothing listening none of
 * that can happen.
 */
// @ts-nocheck

import type { Application } from "express";
import inject from "light-my-request";

export interface TestResponse {
  status: number;
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  body: any;
}

class Test implements PromiseLike<TestResponse> {
  private readonly headers: Record<string, string> = {};
  private payload: unknown;
  private queryParams: Record<string, string> | undefined;

  constructor(
    private readonly app: Application,
    private readonly method: string,
    private readonly url: string,
  ) {}

  set(name: string | Record<string, string>, value?: string): this {
    if (typeof name === "string") this.headers[name] = value as string;
    else Object.assign(this.headers, name);
    return this;
  }

  send(body: unknown): this {
    this.payload = body;
    return this;
  }

  query(params: Record<string, unknown>): this {
    this.queryParams = { ...this.queryParams, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) };
    return this;
  }

  then<R1 = TestResponse, R2 = never>(
    onfulfilled?: ((value: TestResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<TestResponse> {
    const res = await inject(this.app, {
      method: this.method.toUpperCase() as "GET",
      url: this.url,
      headers: this.headers,
      query: this.queryParams,
      payload: this.payload as object | undefined,
    });
    let body: unknown = {};
    try {
      body = JSON.parse(res.payload);
    } catch {
      // not JSON: supertest answers {} too
    }
    return { status: res.statusCode, statusCode: res.statusCode, headers: res.headers, text: res.payload, body };
  }
}

export default function request(app: Application) {
  const make = (method: string) => (url: string) => new Test(app, method, url);
  return { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), delete: make("delete") };
}
