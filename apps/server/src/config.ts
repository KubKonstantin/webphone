import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(32),
  CASDOOR_ENDPOINT: z.string().url().optional(),
  CASDOOR_SERVER_URL: z.string().url().optional(),
  CASDOOR_CLIENT_ID: z.string().min(1),
  CASDOOR_CLIENT_SECRET: z.string().min(1),
  CASDOOR_REDIRECT_URI: z.string().url(),
  CASDOOR_ORG_NAME: z.string().optional().default(""),
  CASDOOR_APP_NAME: z.string().optional().default(""),
  CASDOOR_SCOPES: z.string().default("openid profile email"),
  CASDOOR_LOGIN_CLAIM: z.string().default("preferred_username"),
  SIP_AUTH_URL: z.string().url(),
  SIP_AUTH_BEARER_TOKEN: z.string().optional().default(""),
  SIP_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  SIP_REFRESH_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(30),
  ICE_SERVERS_JSON: z.string().default("[]"),
  CALL_HISTORY_FILE: z.string().default("./data/call-history.json"),
  CALL_HISTORY_LIMIT_PER_USER: z.coerce.number().int().positive().default(500)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

const casdoorEndpoint = parsed.data.CASDOOR_ENDPOINT ?? parsed.data.CASDOOR_SERVER_URL;
if (!casdoorEndpoint) {
  console.error("Invalid environment configuration:", {
    CASDOOR_ENDPOINT: ["Required when CASDOOR_SERVER_URL is not set"],
    CASDOOR_SERVER_URL: ["Required when CASDOOR_ENDPOINT is not set"]
  });
  throw new Error("Invalid environment configuration");
}

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

let iceServers: IceServer[];
try {
  iceServers = z.array(z.object({
    urls: z.union([z.string(), z.array(z.string())]),
    username: z.string().optional(),
    credential: z.string().optional()
  })).parse(JSON.parse(parsed.data.ICE_SERVERS_JSON));
} catch (error) {
  throw new Error(`ICE_SERVERS_JSON must be a valid RTCIceServer[]: ${String(error)}`);
}

export const config = {
  ...parsed.data,
  CASDOOR_ENDPOINT: casdoorEndpoint,
  isProduction: parsed.data.NODE_ENV === "production",
  iceServers
};
