import "express-session";

declare module "express-session" {
  interface SessionData {
    casdoor?: {
      state: string;
      returnTo: string;
    };
    user?: {
      sub: string;
      login: string;
      rawLogin?: string;
      name?: string;
      email?: string;
      picture?: string;
      roles?: string[];
    };
  }
}
