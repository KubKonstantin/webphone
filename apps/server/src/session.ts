import session, { type Store } from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";
import { config } from "./config.js";

export function sessionMiddleware(store?: Store) {
  return session({
    name: "sip-phone.sid",
    secret: config.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: "auto",
      sameSite: "lax",
      maxAge: config.SESSION_MAX_AGE_MS
    }
  });
}

export async function createSessionStorage() {
  if (!config.REDIS_URL) {
    console.warn("Sessions use process memory. Configure REDIS_URL for multiple replicas and restart persistence.");
    return { store: undefined, ready: () => true };
  }
  const client = createClient({
    url: config.REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5000 }
  });
  // Avoid logging connection URLs, passwords or session contents.
  client.on("error", () => console.error("Session Redis unavailable"));
  await client.connect();
  return {
    store: new RedisStore({ client, prefix: config.SESSION_REDIS_PREFIX }),
    ready: () => client.isReady
  };
}
