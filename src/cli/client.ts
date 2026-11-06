import type { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import type { Config } from '../../config/schema.js';

export interface ClientOptions {
  config?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ResolvedClient {
  config: Config;
  baseUrl: string;
  authHeader: { authorization: string };
}

export function resolveClient(opts: ClientOptions): ResolvedClient {
  const config = loadConfig({ path: opts.config });
  const baseUrl = `http://${config.broker.http.host}:${config.broker.http.port}`;
  return {
    config,
    baseUrl,
    authHeader: { authorization: `Bearer ${config.broker.http.auth_token}` },
  };
}

export async function httpJson(
  client: ResolvedClient,
  method: HttpMethod,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${client.baseUrl}${pathname}`, {
    method,
    headers: {
      ...client.authHeader,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

export function dieOnError(
  result: { status: number; body: any },
  failPrefix: string,
): void {
  if (result.status >= 400) {
    const code = result.body?.error?.code ?? result.status;
    const msg = result.body?.error?.message ?? JSON.stringify(result.body);
    console.error(`${failPrefix} (${code}): ${msg}`);
    process.exit(1);
  }
}

/** Pretty-print a JSON value to stdout (the CLI's standard output shape). */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Resolve the client, call the broker, exit on HTTP error, and (by default)
 * pretty-print the response. Returns the parsed body so callers can chain a
 * follow-up request (e.g. `submit --wait`). Collapses the
 * resolve→call→dieOnError→print boilerplate shared by every CLI command.
 */
export async function runJson(
  opts: ClientOptions,
  method: HttpMethod,
  pathname: string,
  failMsg: string,
  body?: unknown,
  print = true,
): Promise<any> {
  const client = resolveClient(opts);
  const r = await httpJson(client, method, pathname, body);
  dieOnError(r, failMsg);
  if (print) printJson(r.body);
  return r.body;
}

/** Attach the standard `-c, --config <path>` option to a command. */
export function withConfigOption(cmd: Command): Command {
  return cmd.option('-c, --config <path>', 'path to config file');
}
