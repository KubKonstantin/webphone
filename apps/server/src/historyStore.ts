import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.js";

export const callRecordInputSchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(["incoming", "outgoing"]),
  remote: z.string().min(1).max(256),
  startedAt: z.string().datetime(),
  answeredAt: z.string().datetime().optional(),
  endedAt: z.string().datetime(),
  durationSeconds: z.number().int().nonnegative().max(86400),
  status: z.enum(["completed", "missed", "rejected", "cancelled", "failed", "transferred"])
});

export type CallRecord = z.infer<typeof callRecordInputSchema> & {
  userLogin: string;
};

type StoreFile = { records: CallRecord[] };

export class HistoryStore {
  private readonly path = resolve(config.CALL_HISTORY_FILE);
  private queue: Promise<void> = Promise.resolve();

  private async read(): Promise<StoreFile> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as StoreFile;
      return Array.isArray(data.records) ? data : { records: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
      throw error;
    }
  }

  async list(userLogin: string): Promise<CallRecord[]> {
    await this.queue;
    const store = await this.read();
    return store.records
      .filter((record) => record.userLogin === userLogin)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, config.CALL_HISTORY_LIMIT_PER_USER);
  }

  async append(userLogin: string, input: z.infer<typeof callRecordInputSchema>): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const store = await this.read();
      if (store.records.some((record) => record.id === input.id && record.userLogin === userLogin)) {
        return;
      }
      store.records.push({ ...input, userLogin });

      const grouped = new Map<string, CallRecord[]>();
      for (const record of store.records) {
        const records = grouped.get(record.userLogin) ?? [];
        records.push(record);
        grouped.set(record.userLogin, records);
      }
      const limited = [...grouped.values()].flatMap((records) =>
        records
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
          .slice(0, config.CALL_HISTORY_LIMIT_PER_USER)
      );

      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify({ records: limited }, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.queue;
  }
}
