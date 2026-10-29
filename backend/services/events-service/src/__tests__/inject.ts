import type { Application } from "express";
import inject from "light-my-request";

export interface InjectedResponse {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  body: any;
}

/**
 * Runs one request through an Express app in-process - no socket, no port - and answers in the shape the tests use
 * from supertest. Thousands of real TCP connections per suite meant ephemeral-port exhaustion, reused sockets and
 * other apps holding a loopback port; none of that can happen when nothing is listening.
 */
export async function dispatch(
  app: Application,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<InjectedResponse> {
  const res = await inject(app, {
    method: method.toUpperCase() as "GET",
    url,
    headers: options.headers,
    payload: options.body as object | undefined,
  });
  let body: unknown = {};
  try {
    body = JSON.parse(res.payload);
  } catch {
    // not JSON: supertest answers {} too
  }
  return { status: res.statusCode, headers: res.headers, text: res.payload, body };
}
