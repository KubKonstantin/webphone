import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import helmet from "helmet";
import { config } from "./config.js";
import { callRecordInputSchema, HistoryStore } from "./historyStore.js";
import { createAuthorizationUrl, finishAuthorization } from "./oidc.js";
import { fetchSipCredentials, SipCredentialsError } from "./sipCredentials.js";

const app = express();
const historyStore = new HistoryStore();
const expectedOrigin = new URL(config.APP_BASE_URL).origin;

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: config.isProduction
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "wss:", "ws:"],
          mediaSrc: ["'self'", "blob:"]
        }
      }
    : false
}));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "sip-phone.sid",
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: "auto",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin) {
      res.status(403).json({ error: "Invalid request origin" });
      return;
    }
  }
  next();
});

function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, requestId: randomUUID() });
});

app.get("/api/auth/login", async (req, res, next) => {
  try {
    res.redirect(await createAuthorizationUrl(req, typeof req.query.returnTo === "string" ? req.query.returnTo : "/"));
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const oidcError = typeof req.query.error === "string" ? req.query.error : "";
    if (oidcError) throw new Error(`Casdoor authorization failed: ${oidcError}`);
    if (!code || !state) throw new Error("Missing Casdoor code or state");
    const { returnTo } = await finishAuthorization(req, code, state);
    res.redirect(new URL(returnTo, config.APP_BASE_URL).toString());
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.user) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, user: req.session.user });
});

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("sip-phone.sid");
    res.status(204).end();
  });
});

app.post("/api/sip/credentials", requireUser, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await fetchSipCredentials(req.session.user!.login));
  } catch (error) {
    next(error);
  }
});

app.get("/api/calls", requireUser, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ records: await historyStore.list(req.session.user!.login) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/calls", requireUser, async (req, res, next) => {
  try {
    const record = callRecordInputSchema.parse(req.body);
    await historyStore.append(req.session.user!.login, record);
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get("/{*splat}", (_req, res) => res.sendFile(resolve(clientDist, "index.html")));
} else if (config.isProduction) {
  throw new Error(`Client build not found at ${clientDist}; run npm run build before starting the server`);
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  const status = error instanceof SipCredentialsError
    ? error.status
    : message.includes("Authentication required") ? 401 : 500;
  res.status(status).json({
    error: config.isProduction ? "Request failed" : message
  });
});

app.listen(config.PORT, () => {
  console.log(`SIP phone server listening on http://localhost:${config.PORT}`);
});
