import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { config } from "./config.js";

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type CasdoorUserInfo = {
  sub?: string;
  id?: string;
  preferred_username?: string;
  username?: string;
  name?: string;
  displayName?: string;
  email?: string;
  picture?: string;
  avatar?: string;
  roles?: unknown;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function casdoorUrl(path: string): string {
  return `${trimTrailingSlash(config.CASDOOR_ENDPOINT)}${path}`;
}

function normalizeLogin(value: string): string {
  return value.trim().split("@")[0] ?? value.trim();
}

export function createAuthorizationUrl(req: Request, returnTo = "/"): string {
  const state = randomUrlSafe();

  req.session.casdoor = {
    state,
    returnTo: returnTo.startsWith("/") ? returnTo : "/"
  };

  const url = new URL(casdoorUrl("/login/oauth/authorize"));
  url.searchParams.set("client_id", config.CASDOOR_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.CASDOOR_REDIRECT_URI);
  url.searchParams.set("scope", config.CASDOOR_SCOPES);
  url.searchParams.set("state", state);
  if (config.CASDOOR_ORG_NAME) {
    url.searchParams.set("organization", config.CASDOOR_ORG_NAME);
  }
  if (config.CASDOOR_APP_NAME) {
    url.searchParams.set("application", config.CASDOOR_APP_NAME);
  }
  return url.toString();
}

export async function finishAuthorization(req: Request, code: string, state: string): Promise<{ user: NonNullable<Request["session"]["user"]>; returnTo: string }> {
  const flow = req.session.casdoor;
  delete req.session.casdoor;
  if (!flow || !constantTimeEqual(flow.state, state)) {
    throw new Error("Casdoor state mismatch");
  }

  const tokens = await getToken(code);
  if (!tokens.access_token) {
    const detail = tokens.error_description ?? tokens.error ?? "access_token is missing";
    throw new Error(`Casdoor authentication failed: ${detail}`);
  }

  const userInfo = await getUserInfo(tokens.access_token);
  const rawLogin = readLoginClaim(userInfo);
  const login = normalizeLogin(rawLogin);
  if (!login) {
    throw new Error(`Casdoor userinfo has no usable ${config.CASDOOR_LOGIN_CLAIM} claim`);
  }

  const user = {
    sub: userInfo.sub ?? userInfo.id ?? rawLogin,
    login,
    rawLogin,
    name: userInfo.name ?? userInfo.displayName ?? login,
    email: userInfo.email,
    picture: userInfo.picture ?? userInfo.avatar,
    roles: Array.isArray(userInfo.roles) ? userInfo.roles.filter((role): role is string => typeof role === "string") : []
  };

  req.session.user = user;
  return { user, returnTo: flow.returnTo };
}

async function getToken(code: string): Promise<TokenResponse> {
  const response = await fetch(casdoorUrl("/api/login/oauth/access_token"), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.CASDOOR_CLIENT_ID,
      client_secret: config.CASDOOR_CLIENT_SECRET,
      redirect_uri: config.CASDOOR_REDIRECT_URI,
      code
    })
  });

  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
    throw new Error(`Casdoor token exchange failed: ${detail}`);
  }
  return body;
}

async function getUserInfo(accessToken: string): Promise<CasdoorUserInfo> {
  const response = await fetch(casdoorUrl("/api/userinfo"), {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json"
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Casdoor userinfo failed: HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json() as Promise<CasdoorUserInfo>;
}

function readLoginClaim(userInfo: CasdoorUserInfo): string {
  const configured = userInfo[config.CASDOOR_LOGIN_CLAIM as keyof CasdoorUserInfo];
  const fallback = configured ?? userInfo.preferred_username ?? userInfo.username ?? userInfo.name ?? userInfo.sub ?? userInfo.id;
  return typeof fallback === "string" ? fallback : "";
}
