export interface BroadcastReport {
  total: number;
  delivered: number;
  unavailable: number;
  failed: number;
}

interface BroadcastOptions {
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type SendMessage = (telegramId: string, text: string) => Promise<void>;

const DEFAULT_DELAY_MS = 100;
const MAX_RATE_LIMIT_RETRIES = 3;

export async function broadcastText(
  recipients: string[],
  message: string,
  sendMessage: SendMessage,
  options: BroadcastOptions = {}
): Promise<BroadcastReport> {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? wait;
  const report: BroadcastReport = {
    total: recipients.length,
    delivered: 0,
    unavailable: 0,
    failed: 0,
  };

  for (let index = 0; index < recipients.length; index += 1) {
    const telegramId = recipients[index]!;
    try {
      await sendWithRateLimitRetry(telegramId, message, sendMessage, sleep);
      report.delivered += 1;
    } catch (error) {
      if (telegramErrorCode(error) === 403) report.unavailable += 1;
      else report.failed += 1;
      console.error(`Не удалось доставить рассылку пользователю ${telegramId}`, error);
    }

    if (index < recipients.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return report;
}

async function sendWithRateLimitRetry(
  telegramId: string,
  message: string,
  sendMessage: SendMessage,
  sleep: (milliseconds: number) => Promise<void>
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sendMessage(telegramId, message);
      return;
    } catch (error) {
      const retryAfter = telegramRetryAfter(error);
      if (retryAfter === null || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
      await sleep(retryAfter * 1000 + 250);
    }
  }
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
