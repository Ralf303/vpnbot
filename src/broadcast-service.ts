export type BroadcastChannel = "telegram" | "vk";
export type BroadcastAudience = BroadcastChannel | "both";
export interface BroadcastRecipient {
  id: string;
  username: string | null;
  peerId?: string;
}
export interface BroadcastReport {
  total: number;
  delivered: number;
  unavailable: number;
  failed: number;
  failures: (BroadcastRecipient & { unavailable: boolean; errorCode: number | null })[];
}

interface BroadcastOptions {
  channel?: BroadcastChannel;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type SendMessage = (telegramId: string, text: string) => Promise<void>;

const DEFAULT_DELAY_MS = 100;
const MAX_RATE_LIMIT_RETRIES = 3;

export async function broadcastText(
  recipients: (string | BroadcastRecipient)[],
  message: string,
  sendMessage: SendMessage,
  options: BroadcastOptions = {}
): Promise<BroadcastReport> {
  const channel = options.channel ?? "telegram";
  const delayMs = options.delayMs ?? (channel === "vk" ? 350 : DEFAULT_DELAY_MS);
  const sleep = options.sleep ?? wait;
  const report: BroadcastReport = {
    total: recipients.length,
    delivered: 0,
    unavailable: 0,
    failed: 0,
    failures: [],
  };

  for (let index = 0; index < recipients.length; index += 1) {
    const item = recipients[index]!;
    const recipient = typeof item === "string" ? { id: item, username: null } : item;
    const telegramId = recipient.peerId ?? recipient.id;
    try {
      await sendWithRateLimitRetry(telegramId, message, sendMessage, sleep, channel);
      report.delivered += 1;
    } catch (error) {
      const errorCode = channel === "telegram" ? telegramErrorCode(error) : vkErrorCode(error);
      const unavailable = channel === "telegram" ? errorCode === 403 : [7, 18, 901, 902].includes(errorCode ?? 0);
      if (unavailable) report.unavailable += 1;
      else report.failed += 1;
      report.failures.push({ ...recipient, unavailable, errorCode });
      console.error(`Не удалось доставить рассылку пользователю ${telegramId}`, error);
    }

    if (index < recipients.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return report;
}

export async function sendWithRateLimitRetry(
  telegramId: string,
  message: string,
  sendMessage: SendMessage,
  sleep: (milliseconds: number) => Promise<void> = wait,
  channel: BroadcastChannel = "telegram"
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sendMessage(telegramId, message);
      return;
    } catch (error) {
      const retryAfter = channel === "telegram" ? telegramRetryAfter(error) : vkErrorCode(error) === 6 ? 1 : null;
      if (retryAfter === null || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
      await sleep(retryAfter * 1000 + 250);
    }
  }
}

function vkErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "number" ? error.code : null;
}

export function broadcastChannels(audience: BroadcastAudience): BroadcastChannel[] {
  return audience === "both" ? ["telegram", "vk"] : [audience];
}

export function formatBroadcastReport(channel: BroadcastChannel, report: BroadcastReport): string[] {
  const title = channel === "telegram" ? "Telegram" : "VK";
  const lines = [
    `📣 Отчёт: ${title}`, "",
    `👥 Получателей: ${report.total}`,
    `✅ Доставлено: ${report.delivered}`,
    `🚫 Заблокировали бота или сообщения недоступны: ${report.unavailable}`,
    `⚠️ Другие ошибки: ${report.failed}`,
  ];
  if (report.failures.length) lines.push("", "Не удалось доставить:");
  for (const failure of report.failures) {
    const username = failure.username ? ` @${failure.username.replace(/^@/, "")}` : "";
    lines.push(`${failure.id}${username} — ${failure.unavailable ? "сообщения недоступны" : "ошибка отправки"}${failure.errorCode === null ? "" : ` (код ${failure.errorCode})`}`);
  }
  const chunks: string[] = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3500) {
      chunks.push(chunk);
      chunk = `📣 ${title}: продолжение отчёта`;
    }
    chunk += `${chunk ? "\n" : ""}${line}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function vkBroadcastText(text: string, entities: readonly { type: string; offset: number; length: number; url?: string }[] = []): string {
  for (const entity of [...entities].filter(item => item.type === "text_link" && item.url).sort((a, b) => b.offset - a.offset)) {
    const end = entity.offset + entity.length;
    text = `${text.slice(0, end)} (${entity.url})${text.slice(end)}`;
  }
  return text;
}

function telegramErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("error_code" in error)) return null;
  const code = (error as { error_code?: unknown }).error_code;
  return typeof code === "number" ? code : null;
}

function telegramRetryAfter(error: unknown): number | null {
  if (telegramErrorCode(error) !== 429 || !error || typeof error !== "object") {
    return null;
  }
  const parameters = (error as { parameters?: unknown }).parameters;
  if (!parameters || typeof parameters !== "object" || !("retry_after" in parameters)) {
    return null;
  }
  const retryAfter = (parameters as { retry_after?: unknown }).retry_after;
  return typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
