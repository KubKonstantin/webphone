const pendingKey = "web-phone.pending-sip-link";
const maxAge = 15 * 60 * 1000;

/** Accept dial targets, never SIP headers, URI parameters, credentials or commands. */
export function parseSipLink(value: string): string | undefined {
  if (value.length > 512 || !/^sip:/i.test(value)) return;
  let target: string;
  try { target = decodeURIComponent(value.slice(4)); } catch { return; }
  if (/^\+?\d{1,20}$/.test(target)) return target;
  const match = /^([a-zA-Z0-9_.+~-]+)@([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(target);
  if (!match) return;
  const [, user, host, port] = match;
  if (!host || host.length > 253 || !host.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return;
  if (port && (Number(port) === 0 || Number(port) > 65535)) return;
  return `sip:${user}@${host.toLowerCase()}${port ? `:${port}` : ""}`;
}

export type SipLinkResult = { kind: "none" } | { kind: "invalid" } | { kind: "target"; target: string };

export function readSipLaunch(url: string, origin: string): SipLinkResult {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin || parsed.pathname !== "/" || !parsed.searchParams.has("sip")) return { kind: "none" };
    const values = parsed.searchParams.getAll("sip");
    const target = values.length === 1 ? parseSipLink(values[0]!) : undefined;
    return target ? { kind: "target", target } : { kind: "invalid" };
  } catch { return { kind: "invalid" }; }
}

export function targetUri(target: string): string {
  return target.startsWith("sip:") ? target : `sip:${target}`;
}

export function savePendingSip(target?: string): void {
  try {
    if (target) sessionStorage.setItem(pendingKey, JSON.stringify({ uri: targetUri(target), expires: Date.now() + maxAge }));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The login return URL also preserves the target when storage is unavailable. */ }
}

export function restorePendingSip(): string | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    if (typeof stored?.expires === "number" && stored.expires > Date.now() && stored.expires <= Date.now() + maxAge && typeof stored.uri === "string") {
      const target = parseSipLink(stored.uri);
      if (target) return target;
    }
  } catch { /* Invalid or blocked storage is treated as empty. */ }
  savePendingSip();
}

export function sipLoginUrl(target?: string): string {
  if (!target) return "/api/auth/login";
  const returnTo = `/?${new URLSearchParams({ sip: targetUri(target) })}`;
  return `/api/auth/login?${new URLSearchParams({ returnTo })}`;
}
