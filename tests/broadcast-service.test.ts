import { describe, expect, it, vi } from "vitest";
import { broadcastText, formatBroadcastReport, vkBroadcastText } from "../src/broadcast-service.js";
import { VkApiError } from "../src/vk-api.js";

describe("broadcastText", () => {
  it("продолжает рассылку после блокировки и возвращает отчёт", async () => {
    const send = vi.fn(async (telegramId: string) => {
      if (telegramId === "2") throw { error_code: 403, description: "bot was blocked" };
      if (telegramId === "3") throw new Error("network error");
    });
    const sleep = vi.fn(async () => undefined);

    const report = await broadcastText(["1", "2", "3", "4"], "Важное сообщение", send, {
      delayMs: 100,
      sleep,
    });

    expect(send).toHaveBeenCalledTimes(4);
    expect(report).toMatchObject({ total: 4, delivered: 2, unavailable: 1, failed: 1 });
    expect(report.failures.map(item => item.id)).toEqual(["2", "3"]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("ждёт Retry After и повторяет сообщение после ограничения Telegram", async () => {
    let attempt = 0;
    const send = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw { error_code: 429, parameters: { retry_after: 2 } };
      }
    });
    const sleep = vi.fn(async () => undefined);

    const report = await broadcastText(["1"], "Сообщение", send, { sleep });

    expect(report.delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2250);
  });
});

describe("VK and detailed reports", () => {
  it("preserves hidden Telegram URLs in VK text, including UTF-16 offsets", () => {
    expect(vkBroadcastText("👋 Сайт и чат", [
      { type: "text_link", offset: 3, length: 4, url: "https://example.com" },
      { type: "text_link", offset: 10, length: 3, url: "https://example.com/chat" },
    ])).toBe("👋 Сайт (https://example.com) и чат (https://example.com/chat)");
  });
  it("retries VK limits, reports privacy errors with identity and continues", async () => {
    const send = vi.fn().mockRejectedValueOnce(new VkApiError(6, "Too many requests"))
      .mockRejectedValueOnce(new VkApiError(902, "Privacy"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => {});
    const report = await broadcastText([
      { id: "11", username: "ivan", peerId: "111" }, { id: "12", username: null },
    ], "News", send, { channel: "vk", sleep, delayMs: 0 });
    expect(send.mock.calls.map(call => call[0])).toEqual(["111", "111", "12"]);
    expect(sleep).toHaveBeenCalledWith(1250);
    expect(report).toMatchObject({ delivered: 1, unavailable: 1, failed: 0 });
    expect(formatBroadcastReport("vk", report)[0]).toContain("11 @ivan");
    expect(formatBroadcastReport("vk", report)[0]).toContain("902");
  });

  it("splits long reports without losing recipient IDs", async () => {
    const recipients = Array.from({ length: 200 }, (_, id) => ({ id: `user${id}`, username: `name${id}` }));
    const report = await broadcastText(recipients, "News", async () => { throw { error_code: 403 }; }, { delayMs: 0 });
    const chunks = formatBroadcastReport("telegram", report);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 3500)).toBe(true);
    for (const recipient of recipients) expect(chunks.join("\n")).toContain(`${recipient.id} @${recipient.username} —`);
  });
});
