import { describe, expect, it } from "vitest";
import { createBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { VkBot } from "../src/vk-bot.js";
import type { AppDatabase } from "../src/database.js";
import type { ConfigService } from "../src/config-service.js";
import type { TrafficService } from "../src/traffic-service.js";
import type { ServerManager } from "../src/server-manager.js";
import type { GameProfileService } from "../src/game-profile-service.js";

describe("user gaming access", () => {
  it("allows the admin to grant one personal Telegram profile and revokes it", async () => {
    const user = { id: 5, telegramId: "200", username: "racer", firstName: "Racer", gameEnabled: false, createdAt: "", updatedAt: "" };
    const db = {
      upsertUser: async () => user,
      getUserById: async (id: number) => id === 5 ? user : null,
      getUserByTelegramId: async (id: string) => id === "200" ? user : null,
      setGameEnabled: async (_id: number, enabled: boolean) => { user.gameEnabled = enabled; return user; },
      listConfigsForUserAdmin: async () => [],
    };
    const calls: string[] = [];
    const game = {
      ready: true,
      enable: async () => { calls.push("enable"); return Buffer.from("private-profile"); },
      download: async () => { calls.push("download"); return Buffer.from("private-profile"); },
      disable: async () => { calls.push("disable"); },
    };
    const config = loadConfig({ BOT_TOKEN: "test-token", ADMIN_TELEGRAM_ID: "100", DATABASE_URL: "postgresql://localhost/test" });
    const { bot } = createBot(config, db as unknown as AppDatabase, {} as ConfigService,
      { connectionStates: async () => new Map() } as unknown as TrafficService,
      {} as ServerManager, undefined, undefined, game as GameProfileService);
    bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
    const api: { method: string; payload: any }[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      api.push({ method, payload });
      return { ok: true, result: { message_id: 1, date: 1, chat: { id: 100, type: "private" } } } as any;
    });
    let update = 0;
    const callback = (data: string, actor: number) => bot.handleUpdate({
      update_id: ++update,
      callback_query: { id: String(update), from: { id: actor, is_bot: false, first_name: "Test" }, chat_instance: "1", data,
        message: { message_id: 1, date: 1, chat: { id: actor, type: "private" }, text: "menu" } },
    });
    await callback("ug", 200);
    expect(api.filter(x => x.method === "sendDocument")).toHaveLength(0);
    await callback("aug|5", 200);
    expect(calls).toEqual([]);
    await callback("aug|5", 100);
    expect(user.gameEnabled).toBe(true);
    await callback("ug", 200);
    expect(calls).toEqual(["enable", "download"]);
    expect(api.filter(x => x.method === "sendDocument")).toHaveLength(1);
    await callback("aug|5", 100);
    expect(user.gameEnabled).toBe(false);
    await callback("ug", 200);
    expect(calls).toEqual(["enable", "download", "disable"]);
  });

  it("checks linked VK entitlement before sending the same user's profile", async () => {
    const user = { id: 5, telegramId: "200", gameEnabled: false };
    const sent: string[] = [];
    const vk = new VkBot({
      groupId: 1,
      sendMessage: async () => { sent.push("message"); },
      sendDocument: async () => { sent.push("document"); },
    } as any, { getUserByVkId: async () => user } as any,
    {} as ConfigService, {} as TrafficService, {} as ServerManager, "Europe/Moscow",
    { gameProfiles: { ready: true, download: async () => Buffer.from("private-profile") } as GameProfileService });
    await (vk as any).handleAction(300, 300, { a: "game" });
    expect(sent).toEqual(["message"]);
    user.gameEnabled = true;
    await (vk as any).handleAction(300, 300, { a: "game" });
    expect(sent).toEqual(["message", "document"]);
  });
});
