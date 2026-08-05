import { describe, expect, it, vi } from "vitest";
import { broadcastText } from "../src/broadcast-service.js";

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
    expect(report).toEqual({ total: 4, delivered: 2, unavailable: 1, failed: 1 });
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
