import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, type VpnOperations } from "../src/config-service.js";
import { AppDatabase } from "../src/database.js";
import { createCleanDatabase } from "./database-fixture.js";

class FakeVpn implements VpnOperations {
  readonly calls: string[] = [];
  readonly clients = { new: [] as string[], old: [] as string[] };
  readonly configured = { new: true, old: true };
  readonly listFailures = new Set<"new" | "old">();
  failOldRevoke = false;

  isConfigured(server: "new" | "old"): boolean {
    return this.configured[server];
  }

  async listClients(server: "new" | "old"): Promise<string[]> {
    this.calls.push(`list:${server}`);
    if (this.listFailures.has(server)) throw new Error(`${server} unavailable`);
    return [...this.clients[server]];
  }

  async createClient(server: "new" | "old", client: string): Promise<Buffer> {
    this.calls.push(`create:${server}:${client}`);
    this.clients[server].push(client);
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
  it("при равной нагрузке создаёт новый клиент на новом сервере", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");
    expect(config.serverKey).toBe("new");
    expect(config.clientName).toMatch(/^[a-z]{12}$/);
    expect(vpn.calls).toContain(`create:new:${config.clientName}`);
    expect(await db.listVisibleConfigs(user.id)).toHaveLength(1);
  });

  it("выбирает сервер с меньшим количеством действующих клиентов", async () => {
    vpn.clients.new.push("new_one", "new_two");
    const user = await db.upsertUser({ telegramId: "102", firstName: "Пётр" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("old");
    expect(vpn.calls).toContain(`create:old:${config.clientName}`);
  });

  it("использует доступный сервер, если второй не отвечает", async () => {
    vpn.listFailures.add("old");
    const user = await db.upsertUser({ telegramId: "103", firstName: "Ольга" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("new");
  });

  it("выдаёт разные технические имена и не меняет их при переименовании", async () => {
    const user = await db.upsertUser({ telegramId: "101", firstName: "Анна" });
    const first = await service.issue(user, "2027-01-01T20:59:59.999Z");
    const second = await service.issue(user, "2027-02-01T20:59:59.999Z");

    expect(first.clientName).not.toBe(second.clientName);
    await db.updateDisplayName(first.id, "Рабочий ноутбук 💻");
    const renamed = (await db.getConfig(first.id))!;
    await service.download(renamed);

    expect(renamed.displayName).toBe("Рабочий ноутбук 💻");
    expect(renamed.clientName).toBe(first.clientName);
    expect(vpn.calls.at(-1)).toBe(`download:new:${first.clientName}`);
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

  it("повторно выдаёт старый конфиг без переноса", async () => {
    const user = await db.upsertUser({ telegramId: "104", firstName: "Мария" });
    await db.syncLegacyClients("old", ["legacy_download"]);
    const legacy = (await db.listUnassignedLegacyClients("old"))[0]!;
    const config = await service.bindLegacy(user, legacy, "2027-01-01T20:59:59.999Z");

    await expect(service.download(config)).resolves.toBeInstanceOf(Buffer);
    expect(vpn.calls.at(-1)).toBe("download:old:legacy_download");
  });
});
