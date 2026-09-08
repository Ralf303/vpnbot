import { describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import type { AppDatabase } from "../src/database.js";
import type { ConfigService } from "../src/config-service.js";
import type { TrafficService } from "../src/traffic-service.js";
import type { ServerManager } from "../src/server-manager.js";
import type { VkApiClient } from "../src/vk-api.js";

function fixture(vkEnabled = true, rejectTelegram = false) {
  const config = loadConfig({ BOT_TOKEN: "test-token", ADMIN_TELEGRAM_ID: "100", DATABASE_URL: "postgresql://localhost/test" });
  const db = {
    upsertUser: vi.fn(async () => ({})), countExtendableConfigs: vi.fn(async () => 3),
    extendAllActiveConfigs: vi.fn(async () => 3),
    listBroadcastTargets: vi.fn(async (channel: string) => [{ id: channel === "vk" ? "700" : "200", username: "ivan" }]),
  };
  const vk = { sendMessage: vi.fn(async () => 1) };
  const { bot } = createBot(config, db as unknown as AppDatabase, {} as ConfigService,
    {} as TrafficService, {} as ServerManager, vkEnabled ? vk as unknown as VkApiClient : undefined);
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const calls: { method: string; payload: Record<string, any> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (rejectTelegram && method === "sendMessage" && String((payload as any).chat_id) === "200") {
      return { ok: false, error_code: 403, description: "bot was blocked" };
    }
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 100, type: "private" } } } as any;
  });
  const from = { id: 100, is_bot: false, first_name: "Admin" };
  let updateId = 0;
  const callback = (data: string, userId = 100) => bot.handleUpdate({
    update_id: ++updateId,
    callback_query: { id: String(updateId), from: { ...from, id: userId }, chat_instance: "1", data,
      message: { message_id: 1, date: 1, chat: { id: userId, type: "private" }, text: "menu" } },
  });
  const text = (value: string) => bot.handleUpdate({ update_id: ++updateId,
    message: { message_id: updateId, date: 1, chat: { id: 100, type: "private" }, from, text: value } });
  return { db, vk, calls, callback, text };
}

describe("admin flows", () => {
  it("accepts custom days only after confirmation and rejects non-admins", async () => {
    const f = fixture();
    await f.callback("ax");
    await f.text("1.5");
    expect(f.db.extendAllActiveConfigs).not.toHaveBeenCalled();
    await f.text("15");
    expect(f.calls.at(-1)?.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("axc|15d");
    expect(f.db.extendAllActiveConfigs).not.toHaveBeenCalled();
    await f.callback("axc|15d", 200);
    expect(f.db.extendAllActiveConfigs).not.toHaveBeenCalled();
    await f.callback("axc|15d");
    expect(f.db.extendAllActiveConfigs).toHaveBeenCalledExactlyOnceWith({ days: 15 });
  });

  it.each(["telegram", "vk", "both"])("sends only to %s after confirmation", async audience => {
    const f = fixture();
    await f.callback("bc");
    await f.callback(`bct|${audience}`);
    await f.text("Новости");
    expect(f.vk.sendMessage).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method === "sendMessage" && String(call.payload.chat_id) === "200")).toHaveLength(0);
    await f.callback("bccf");
    await vi.waitFor(() => expect(f.calls.some(call => String(call.payload.text).includes("📣 Отчёт:"))).toBe(true));
    const telegram = f.calls.filter(call => call.method === "sendMessage" && String(call.payload.chat_id) === "200");
    expect(telegram).toHaveLength(audience === "vk" ? 0 : 1);
    expect(f.vk.sendMessage).toHaveBeenCalledTimes(audience === "telegram" ? 0 : 1);
    if (telegram.length) expect(telegram[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("dla");
    if (audience !== "telegram") {
      const message = f.vk.sendMessage.mock.calls[0]![0] as any;
      expect(JSON.parse(JSON.parse(message.keyboard).buttons[0][0].action.payload)).toEqual({ a: "all" });
    }
  });

  it("continues VK after Telegram blocks delivery and reports the failed identity", async () => {
    const f = fixture(true, true);
    await f.callback("bct|both");
    await f.text("Новости");
    await f.callback("bcc");
    await vi.waitFor(() => expect(f.calls.some(call => String(call.payload.text).includes("📣 Отчёт: VK"))).toBe(true));
    expect(f.vk.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.calls.some(call => String(call.payload.text).includes("200 @ivan"))).toBe(true);
    expect((f.vk.sendMessage.mock.calls[0]![0] as any).keyboard).toBeUndefined();
  });

  it("refuses VK when it is not configured", async () => {
    const f = fixture(false);
    await f.callback("bc");
    expect(JSON.stringify(f.calls.at(-1)?.payload.reply_markup)).not.toContain("bct|vk");
    await f.callback("bct|vk");
    expect(f.calls.at(-1)?.payload.text).toBe("VK не подключён.");
    expect(f.db.listBroadcastTargets).not.toHaveBeenCalled();
  });
});
