import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ServerManager } from "../src/server-manager.js";
import { createBot } from "../src/bot.js";
import type { AppDatabase } from "../src/database.js";
import type { OpenVpnGateway } from "../src/openvpn.js";
import type { ConfigService } from "../src/config-service.js";
import type { TrafficService } from "../src/traffic-service.js";

function fixture() {
  const config = loadConfig({ BOT_TOKEN: "test-token", ADMIN_TELEGRAM_ID: "100", DATABASE_URL: "postgresql://localhost/test", VPN_ENTRY_SERVER_KEY: "srv_1" });
  const record = { key: "srv_2", name: "Finland", host: "192.0.2.2", port: 22, sshUser: "vpn-bot", sshPrivateKey: "key", hostFingerprint: "SHA256:test", relayManaged: true, status: "ready" };
  const impact = { configs: 2, legacyClients: 1, pendingRevocations: 1 };
  const db = { getServerByKey: vi.fn(async () => record), deleteServer: vi.fn(async () => impact),
    serverDeletionImpact: vi.fn(async () => impact), upsertUser: vi.fn(async () => ({})) };
  const gateway = { isConfigured: vi.fn(() => false), cleanupManagedServer: vi.fn(async () => {}), stopManagedRelay: vi.fn(async () => {}) };
  const manager = new ServerManager(db as unknown as AppDatabase, gateway as unknown as OpenVpnGateway, config);
  const { bot } = createBot(config, db as unknown as AppDatabase, {} as ConfigService, {} as TrafficService, manager);
  bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const calls: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 100, type: "private" } } } as any;
  });
  let update = 0;
  const callback = (data: string, userId = 100) => bot.handleUpdate({ update_id: ++update,
    callback_query: { id: String(update), from: { id: userId, is_bot: false, first_name: "Admin" }, chat_instance: "1", data,
      message: { message_id: 1, date: 1, chat: { id: userId, type: "private" }, text: "menu" } } });
  return { record, db, gateway, manager, calls, callback };
}

describe("server deletion", () => {
  it("removes an unreachable VPS only from the database, without any SSH", async () => {
    const f = fixture();
    f.gateway.stopManagedRelay.mockRejectedValue(new Error("offline"));
    f.gateway.cleanupManagedServer.mockRejectedValue(new Error("offline"));
    await f.callback("svdc|srv_2");
    expect(f.db.deleteServer).toHaveBeenCalledExactlyOnceWith("srv_2");
    expect(f.gateway.stopManagedRelay).not.toHaveBeenCalled();
    expect(f.gateway.cleanupManagedServer).not.toHaveBeenCalled();
  });

  it("shows two modes and requires another confirmation for remote cleanup", async () => {
    const f = fixture();
    await f.callback("svd|srv_2");
    expect(JSON.stringify(f.calls.at(-1)?.payload.reply_markup)).toContain("svdc|srv_2");
    expect(JSON.stringify(f.calls.at(-1)?.payload.reply_markup)).toContain("svdp|srv_2");
    await f.callback("svdp|srv_2");
    expect(JSON.stringify(f.calls.at(-1)?.payload.reply_markup)).toContain("svdcc|srv_2");
    expect(f.gateway.cleanupManagedServer).not.toHaveBeenCalled();
    expect(f.db.deleteServer).not.toHaveBeenCalled();
    await f.callback("svdcc|srv_2");
    expect(f.gateway.cleanupManagedServer).toHaveBeenCalledOnce();
    expect(f.gateway.cleanupManagedServer.mock.invocationCallOrder[0]).toBeLessThan(f.db.deleteServer.mock.invocationCallOrder[0]!);
  });

  it("keeps the database entry if cleanup fails", async () => {
    const f = fixture();
    f.gateway.cleanupManagedServer.mockRejectedValue(new Error("offline"));
    await expect(f.manager.deleteServer("srv_2", true)).rejects.toThrow("offline");
    expect(f.db.deleteServer).not.toHaveBeenCalled();
  });

  it("protects the main entry, non-admin callbacks and unfinished bootstrap", async () => {
    const f = fixture();
    await f.callback("svdcc|srv_2", 200);
    await f.callback("svdc|srv_1");
    await expect(f.manager.deleteServer("srv_1", true)).rejects.toThrow("точку входа");
    f.record.status = "pending";
    await expect(f.manager.deleteServer("srv_2")).rejects.toThrow("завершения установки");
    expect(f.gateway.cleanupManagedServer).not.toHaveBeenCalled();
    expect(f.db.deleteServer).not.toHaveBeenCalled();
  });
});
