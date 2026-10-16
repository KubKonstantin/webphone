import { z } from "zod";
import { config, type IceServer } from "./config.js";

const rawCredentialSchema = z.object({
  sipLogin: z.string().optional(),
  login: z.string().optional(),
  username: z.string().optional(),
  sipPassword: z.string().optional(),
  password: z.string().optional(),
  expiresIn: z.union([z.number(), z.string()]).optional(),
  expire: z.union([z.number(), z.string()]).optional(),
  wssServer: z.string().optional(),
  server: z.string().optional(),
  sipDomain: z.string().optional(),
  domain: z.string().optional(),
  displayName: z.string().optional()
}).passthrough();

export type SipCredentials = {
  sipLogin: string;
  sipPassword: string;
  wssServer: string;
  sipDomain: string;
  displayName?: string;
  expiresIn: number;
  expiresAt: number;
  refreshAfter: number;
  iceServers: IceServer[];
};

export class SipCredentialsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SipCredentialsError";
  }
}

function parseExpiresIn(value: string | number | undefined): number {
  if (value === undefined) {
    throw new Error("External SIP auth response has no expiresIn/expire");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid SIP credential expiry");
    if (value > 10_000_000_000) return Math.floor((value - Date.now()) / 1000);
    if (value > 1_000_000_000) return Math.floor(value - Date.now() / 1000);
    return Math.floor(value);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return parseExpiresIn(numeric);
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.floor((timestamp - Date.now()) / 1000);
  throw new Error("Invalid SIP credential expiry");
}

function normalizeWssServer(value: string): string {
  const url = new URL(value.includes("://") ? value : `wss://${value}`);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("SIP server must use ws:// or wss://");
  }
  if (config.isProduction && url.protocol !== "wss:") {
    throw new Error("Production SIP server must use wss://");
  }
  return url.toString();
}

export async function fetchSipCredentials(casdoorLogin: string): Promise<SipCredentials> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.SIP_AUTH_TIMEOUT_MS);
  try {
    const response = await fetch(config.SIP_AUTH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(config.SIP_AUTH_BEARER_TOKEN
          ? { authorization: `Bearer ${config.SIP_AUTH_BEARER_TOKEN}` }
          : {})
      },
      body: JSON.stringify({ login: casdoorLogin }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new SipCredentialsError(
        `External SIP auth failed: HTTP ${response.status}: ${detail.slice(0, 300)}`,
        [401, 403, 404].includes(response.status) ? 403 : 502
      );
    }

    const raw = rawCredentialSchema.parse(await response.json());
    const sipLogin = raw.sipLogin ?? raw.login ?? raw.username;
    const sipPassword = raw.sipPassword ?? raw.password;
    const server = raw.wssServer ?? raw.server;
    if (!sipLogin || !sipPassword || !server) {
      throw new Error("External SIP auth response must include SIP login, password and server");
    }

    const wssServer = normalizeWssServer(server);
    const sipDomain = raw.sipDomain ?? raw.domain ?? new URL(wssServer).hostname;
    const expiresIn = parseExpiresIn(raw.expiresIn ?? raw.expire);
    if (expiresIn < 15) {
      throw new Error("SIP credentials expire too soon (less than 15 seconds)");
    }
    const refreshIn = Math.max(5, expiresIn - config.SIP_REFRESH_SKEW_SECONDS);

    return {
      sipLogin,
      sipPassword,
      wssServer,
      sipDomain,
      displayName: raw.displayName,
      expiresIn,
      expiresAt: Date.now() + expiresIn * 1000,
      refreshAfter: Date.now() + refreshIn * 1000,
      iceServers: config.iceServers
    };
  } finally {
    clearTimeout(timeout);
  }
}
