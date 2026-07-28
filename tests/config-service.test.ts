import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, type VpnOperations } from "../src/config-service.js";
import { AppDatabase } from "../src/database.js";
import { createCleanDatabase } from "./database-fixture.js";

class FakeVpn implements VpnOperations {
  readonly calls: string[] = [];
  failOldRevoke = false;

  async createClient(server: "new" | "old", client: string): Promise<Buffer> {
    this.calls.push(`create:${server}:${client}`);
    return Buffer.from("client\ndev tun\n");
  }

  async downloadClient(server: "new" | "old", client: string): Promise<Buffer> {
    this.calls.push(`download:${server}:${client}`);
    return Buffer.from("client\ndev tun\n");
  }

  async revokeClient(server: "new" | "old", client: string): Promise<void> {
    this.calls.push(`revoke:${server}:${client}`);
    if (server === "old" && this.failOldRevoke) throw new Error("old unavailable");
  }
}

let db: AppDatabase;
let vpn: FakeVpn;
let service: ConfigService;

beforeEach(async () => {
  db = await createCleanDatabase();
  vpn = new FakeVpn();
  service = new ConfigService(db, vpn);
});

afterEach(async () => {
  await db.close();
});

describe("ConfigService", () => {
  it("создаёт новый клиент только на новом сервере", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");
    expect(config.serverKey).toBe("new");
    expect(vpn.calls[0]).toMatch(/^create:new:tg100_/);
    expect(await db.listVisibleConfigs(user.id)).toHaveLength(1);
  });

  it("откатывает миграцию, если старый клиент не удалось отозвать", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    await db.syncLegacyClients("old", ["legacy_one"]);
    const legacy = (await db.listUnassignedLegacyClients("old"))[0]!;
    const config = await service.bindLegacy(user, legacy, "2027-01-01T20:59:59.999Z");
    vpn.failOldRevoke = true;

    await expect(service.migrateLegacy(config)).rejects.toThrow("old unavailable");
    const restored = (await db.getConfig(config.id))!;
    expect(restored.serverKey).toBe("old");
    expect(restored.clientName).toBe("legacy_one");
    expect(vpn.calls.some((call) => call.startsWith("revoke:new:"))).toBe(true);
  });
});
