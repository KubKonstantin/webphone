export type User = {
  sub: string;
  login: string;
  rawLogin?: string;
  name?: string;
  email?: string;
  picture?: string;
  roles?: string[];
};

export type SipCredentials = {
  sipLogin: string;
  sipPassword: string;
  wssServer: string;
  sipDomain: string;
  displayName?: string;
  expiresIn: number;
  expiresAt: number;
  refreshAfter: number;
  iceServers: RTCIceServer[];
};

export type CallStatus = "completed" | "missed" | "rejected" | "cancelled" | "failed" | "transferred";
export type CallRecord = {
  id: string;
  direction: "incoming" | "outgoing";
  remote: string;
  startedAt: string;
  answeredAt?: string;
  endedAt: string;
  durationSeconds: number;
  status: CallStatus;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<{ authenticated: true; user: User }>("/api/auth/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  sipCredentials: () => request<SipCredentials>("/api/sip/credentials", { method: "POST" }),
  calls: () => request<{ records: CallRecord[] }>("/api/calls"),
  saveCall: (record: CallRecord) => request<{ ok: true }>("/api/calls", {
    method: "POST",
    body: JSON.stringify(record),
    keepalive: true
  })
};
