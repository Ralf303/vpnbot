import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/database.js";
import type { VpnConfigRecord } from "../src/domain.js";
import { createCleanDatabase } from "./database-fixture.js";

let db: AppDatabase;

beforeEach(async () => {
  db = await createCleanDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("AppDatabase с Prisma", () => {
  it("обновляет username зарегистрированного пользователя", async () => {
    const first = await db.upsertUser({ telegramId: "100", username: "old", firstName: "Иван" });
    const updated = await db.upsertUser({ telegramId: "100", username: "new", firstName: "Иван" });
    expect(updated.id).toBe(first.id);
    expect(updated.username).toBe("new");
    expect(await db.searchUsers("@NEW")).toHaveLength(1);
  });

  it("скрывает конфиг после окончания десятидневного окна", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    const now = new Date().toISOString();
    const config: VpnConfigRecord = {
      id: randomUUID(), userId: user.id, displayName: "Телефон", clientName: "client1",
      serverKey: "new", expiresAt: "2026-01-01T20:59:59.999Z", status: "expired",
      isLegacy: false, revokedAt: now, hiddenAt: "2026-01-11T20:59:59.999Z",
      createdAt: now, updatedAt: now,
    };
    await db.insertConfig(config);
    expect(await db.listVisibleConfigs(user.id, new Date("2026-01-10T00:00:00.000Z"))).toHaveLength(1);
    expect(await db.listVisibleConfigs(user.id, new Date("2026-01-12T00:00:00.000Z"))).toHaveLength(0);
  });

  it("убирает из импорта клиентов, которых больше нет на сервере", async () => {
    await db.syncLegacyClients("old", ["first", "second"]);
    expect((await db.listUnassignedLegacyClients("old")).map((item) => item.clientName)).toEqual(["first", "second"]);
    await db.syncLegacyClients("old", ["second", "third"]);
    expect((await db.listUnassignedLegacyClients("old")).map((item) => item.clientName)).toEqual(["second", "third"]);
  });
});
