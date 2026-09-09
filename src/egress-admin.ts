import type { EgressService } from "./egress-service.js";
import { parseEgressCredentials } from "./egress-service.js";

export interface EmergencyAction { a: string; id?: string; server?: string; page?: number; }
export interface EmergencyButton { label: string; action: EmergencyAction; }
export type EmergencyReply = (text: string, rows: EmergencyButton[][]) => Promise<void>;
const button = (label: string, a: string, fields: Omit<EmergencyAction, "a"> = {}): EmergencyButton => ({ label: Array.from(label).slice(0, 40).join(""), action: { a, ...fields } });
const home = () => [[button("Обновить список", "eg_list")]];

/** Transport-independent admin flow. Caller must authenticate every message/callback. */
export class EgressAdmin {
  private readonly pending = new Map<string, { telegram: boolean; expires: number }>();
  constructor(private readonly service: EgressService) {}
  waiting(actor: string): boolean { return this.pending.has(actor); }
  cancel(actor: string): void { this.pending.delete(actor); }

  async text(actor: string, text: string, reply: EmergencyReply): Promise<void> {
    const pending = this.pending.get(actor);
    if (!pending) return;
    if (text.trim() === "/cancel" || text.trim().toLowerCase() === "отмена") {
      this.cancel(actor); await reply("Добавление отменено.", home()); return;
    }
    if (pending.expires < Date.now()) {
      this.cancel(actor); await reply("Время ввода истекло. Начните добавление заново.", home()); return;
    }
    try {
      const credentials = parseEgressCredentials(text);
      this.cancel(actor);
      const result = await this.service.add(credentials, pending.telegram);
      credentials.password = "";
      await reply("Установка запущена в Москве и продолжится независимо от мессенджера. Текущие конфиги не меняются. Обновите статус, чтобы проверить результат.", [[button("Статус установки", "eg_node", { id: result.id })]]);
    } catch (error) { await reply(error instanceof Error ? error.message : "Не удалось начать установку.", home()); }
  }

  async action(actor: string, action: EmergencyAction, reply: EmergencyReply): Promise<void> {
    this.cancel(actor);
    try {
      if (action.a === "eg_add") {
        await reply("Что настроить на новом VPS?", [
          [button("VPN + доступ Telegram", "eg_credentials", { id: "tg" })],
          [button("Только VPN", "eg_credentials", { id: "vpn" })],
          [button("Назад", "eg_list")],
        ]); return;
      }
      if (action.a === "eg_credentials") {
        if (!["tg", "vpn"].includes(action.id ?? "")) throw new Error("Выберите режим установки.");
        this.pending.set(actor, { telegram: action.id === "tg", expires: Date.now() + 10 * 60_000 });
        await reply("Отправьте одним сообщением пять строк:\nНазвание сервера\nПубличный IPv4\nSSH-порт (обычно 22)\nSSH-логин\nПароль\n\nНужен чистый Ubuntu/Debian и root либо пользователь с sudo. Установка начнётся после отправки. Пароль не сохраняется в настройках или журналах бота. Для отмены: /cancel.", [[button("Отмена", "eg_list")]]); return;
      }
      if (action.a === "eg_check" && action.id) {
        const result = await this.service.check(action.id);
        await reply(result.message, [[button("К серверу", "eg_node", { id: action.id })]]); return;
      }
      if (["eg_move_confirm", "eg_move_tg_confirm"].includes(action.a) && action.id && action.server && action.page !== undefined) {
        const result = await this.service.move(action.id, action.server, action.page, action.a === "eg_move_tg_confirm");
        await reply(`✅ Выход переключён для действующих конфигов: ${result.moved}. Файлы, сертификаты и сроки сохранены. Открытые соединения могут потребовать переподключения.${action.a === "eg_move_tg_confirm" ? " Доступ Telegram тоже переключён." : ""}`, home()); return;
      }
      if (action.a === "eg_proxy_confirm" && action.id && action.page !== undefined) {
        await this.service.setProxy(action.id, action.page);
        await reply("✅ Прокси Telegram переключён. Работа ВК не зависит от этого прокси.", home()); return;
      }
      const state = await this.service.snapshot();
      if (action.a === "eg_list") {
        const page = Math.max(0, Math.min(action.page ?? 0, Math.ceil(state.nodes.length / 4) - 1));
        const rows = state.nodes.slice(page * 4, page * 4 + 4).map(n => [button(`${n.status === "ready" ? "🟢" : n.status === "error" ? "🔴" : "⏳"} ${n.name}${n.id === state.default ? " • основной" : ""}`, "eg_node", { id: n.id })]);
        if (state.nodes.length > 4) rows.push([button("←", "eg_list", { page: Math.max(0, page - 1) }), button("→", "eg_list", { page: page + 1 })]);
        rows.push([button("Добавить VPS", "eg_add"), button("Обновить", "eg_list")]);
        await reply("🌍 Аварийное управление\n\nЗдесь меняется зарубежный выход. Подключение пользователей и сертификаты остаются в Москве. Для восстановления Telegram выберите выход с поддержкой Telegram.", rows); return;
      }
      const source = state.nodes.find(n => n.id === action.id);
      if (!source) throw new Error("Сервер не найден. Обновите список.");
      if (action.a === "eg_node") {
        const rows: EmergencyButton[][] = [];
        if (source.status === "ready") rows.push([button("Проверить", "eg_check", { id: source.id })]);
        rows.push([button("Переключить всех с этого выхода", "eg_move", { id: source.id })]);
        if (source.telegram && source.status === "ready") rows.push([button("Использовать для Telegram", "eg_proxy", { id: source.id })]);
        rows.push([button("Обновить статус", "eg_node", { id: source.id }), button("Все выходы", "eg_list")]);
        await reply(`${source.name}\n${source.host}\nСтатус: ${source.status}\n${source.stage ?? ""}\n${source.error ?? ""}\nTelegram: ${source.telegram ? "поддерживается" : "не настроен"}${state.proxy === source.id ? " (выбран)" : ""}\n\nПри ошибке установки добавьте этот адрес повторно, чтобы продолжить.`, rows); return;
      }
      if (action.a === "eg_proxy") {
        await reply(`Проверить и переключить доступ Telegram через «${source.name}»? VPN-маршруты пользователей не изменятся.`, [[button("Подтвердить", "eg_proxy_confirm", { id: source.id, page: state.revision })], ...home()]); return;
      }
      if (action.a === "eg_move") {
        const candidates = state.nodes.filter(n => n.id !== source.id && n.status === "ready");
        const page = Math.max(0, Math.min(action.page ?? 0, Math.ceil(candidates.length / 4) - 1));
        await reply(candidates.length ? `Куда переключить всех с «${source.name}»?` : "Нет другого готового выхода. Сначала добавьте VPS и дождитесь проверки.", [
          ...candidates.slice(page * 4, page * 4 + 4).map(n => [button(n.name, "eg_move_preview", { id: source.id, server: n.id })]),
          ...(candidates.length > 4 ? [[button("←", "eg_move", { id: source.id, page: Math.max(0, page - 1) }), button("→", "eg_move", { id: source.id, page: page + 1 })]] : []), ...home(),
        ]); return;
      }
      if (action.a === "eg_move_preview" && action.server) {
        const target = state.nodes.find(n => n.id === action.server && n.status === "ready");
        if (!target || target.id === source.id) throw new Error("Выберите другой готовый выход.");
        const rows = [[button("Переключить VPN", "eg_move_confirm", { id: source.id, server: target.id, page: state.revision })]];
        if (target.telegram) rows.push([button("VPN + Telegram", "eg_move_tg_confirm", { id: source.id, server: target.id, page: state.revision })]);
        rows.push(...home());
        await reply(`Переключить конфиги с «${source.name}» на «${target.name}»?\n\nНовый выход будет проверен перед переключением. Доступ к старому серверу не требуется. Пользовательские файлы и сроки не изменятся. Возможен краткий перерыв открытых соединений.`, rows); return;
      }
      throw new Error("Неизвестная операция. Обновите меню.");
    } catch (error) { await reply(error instanceof Error ? error.message : "Операция не выполнена.", home()); }
  }
}
