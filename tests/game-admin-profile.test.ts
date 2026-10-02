import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import type { AppDatabase } from "../src/database.js";
import type { ConfigService } from "../src/config-service.js";
import type { TrafficService } from "../src/traffic-service.js";
import type { ServerManager } from "../src/server-manager.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("admin gaming profile", () => {
  it("offers the file only to the configured admin in a private Telegram chat", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vpnbot-game-"));
    folders.push(folder);
    const path = join(folder, "game.conf");
    await writeFile(path, "[Interface]\nPrivateKey = test-private\n[Peer]\nEndpoint = example.com:51823\n", { mode: 0o600 });
    const config = loadConfig({ BOT_TOKEN: "test-token", ADMIN_TELEGRAM_ID: "100", DATABASE_URL: "postgresql://localhost/test", GAME_ADMIN_PROFILE_PATH: path });
    const db = { upsertUser: async () => ({}), stats: async () => ({ telegramUsers: 1, linkedVkUsers: 0, active: 0, expired: 0 }) };
    const { bot } = createBot(config, db as unknown as AppDatabase, {} as ConfigService, {} as TrafficService, {} as ServerManager);
    bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
    const calls: { method: string; payload: any }[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 1, date: 1, chat: { id: 100, type: "private" } } } as any;
    });
    let update = 0;
    const callback = (data: string, userId: number, chatType: "private" | "group" = "private") => bot.handleUpdate({
      update_id: ++update,
      callback_query: { id: String(update), from: { id: userId, is_bot: false, first_name: "Admin" }, chat_instance: "1", data,
        message: { message_id: 1, date: 1, chat: { id: chatType === "private" ? userId : -100, type: chatType }, text: "menu" } },
    });
    await callback("a", 100);
    expect(JSON.stringify(calls.at(-1)?.payload.reply_markup)).toContain('"gp"');
    await callback("gp", 200);
    await callback("gp", 100, "group");
    expect(calls.filter(call => call.method === "sendDocument")).toHaveLength(0);
    await callback("gp", 100);
    const documents = calls.filter(call => call.method === "sendDocument");
    expect(documents).toHaveLength(1);
    expect(documents[0]?.payload.chat_id).toBe(100);
    expect(String(documents[0]?.payload.caption)).toContain("Личный игровой профиль");
  });
});
