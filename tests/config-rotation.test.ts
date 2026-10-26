import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "../src/config-service.js";
import type { AppDatabase } from "../src/database.js";
import type { VpnConfigRecord } from "../src/domain.js";
import type { VpnServerTarget } from "../src/openvpn.js";

function fixture() {
  const original: VpnConfigRecord = {
    id: "config-1", userId: 1, displayName: "Мой телефон",
    clientName: "oldclient", serverKey: "entry", expiresAt: "2099-01-01T00:00:00.000Z",
    status: "active", isLegacy: false, revokedAt: null,
    hiddenAt: "2099-01-11T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let current = { ...original };
  const target = { key: "entry", name: "Москва" } as VpnServerTarget;
  const db = {
    getConfig: vi.fn(async () => ({ ...current })),
    reserveClientName: vi.fn(async () => true),
    replaceClient: vi.fn(async (_id: string, name: string) => { current = { ...current, clientName: name }; }),
    restoreClient: vi.fn(async () => { current = { ...original }; }),
  };
  const vpn = {
    createClient: vi.fn(async () => Buffer.from("client\nremote example.test 443\n")),
    revokeClient: vi.fn(async () => {}),
  };
  const servers = { resolveTarget: vi.fn(async () => target) };
  const service = new ConfigService(db as unknown as AppDatabase, vpn as never, servers as never);
  return { original, current: () => current, db, vpn, target, service };
}

describe("same-server file rotation", () => {
  it("keeps the logical config and expiry while revoking the old certificate", async () => {
    const f = fixture();
    const result = await f.service.rotate(f.original, "oldclient");
    expect(result.config.id).toBe(f.original.id);
    expect(result.config.displayName).toBe(f.original.displayName);
    expect(result.config.expiresAt).toBe(f.original.expiresAt);
    expect(result.config.serverKey).toBe("entry");
    expect(result.config.clientName).not.toBe("oldclient");
    expect(f.vpn.revokeClient).toHaveBeenCalledWith(f.target, "oldclient");
    expect(result.file).toBeInstanceOf(Buffer);
    await expect(f.service.rotate(f.original, "oldclient")).rejects.toThrow("уже был перевыпущен");
    expect(f.vpn.createClient).toHaveBeenCalledTimes(1);
  });

  it("restores the old config when certificate revocation fails", async () => {
    const f = fixture();
    f.vpn.revokeClient.mockRejectedValueOnce(new Error("revoke failed"));
    await expect(f.service.rotate(f.original, "oldclient")).rejects.toThrow("revoke failed");
    expect(f.db.restoreClient).toHaveBeenCalledWith(f.original);
    expect(f.current().clientName).toBe("oldclient");
    expect(f.vpn.revokeClient).toHaveBeenCalledTimes(2);
  });
});
