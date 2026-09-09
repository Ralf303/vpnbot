import { describe, it, expect, vi } from "vitest";
import { EgressService, parseEgressCredentials } from "../src/egress-service.js";
import { EgressAdmin } from "../src/egress-admin.js";
import { runTelegramWithRetry } from "../src/telegram-runtime.js";
import type { Bot } from "grammy";
import type { AppDatabase } from "../src/database.js";
import type { ServerManager } from "../src/server-manager.js";
import type { VpnConfigRecord } from "../src/domain.js";

describe("emergency egress", () => {
  it("uses direct Moscow SSH even when the foreign proxy is unavailable; never recreates a profile", async () => {
    const execute = vi.fn(async () => Buffer.from(JSON.stringify({ok:true,data:{}})));
    const servers = {resolveTarget:vi.fn(async()=>({host:'entry',port:22,username:'bot',privateKey:'key',hostFingerprint:'pin',proxyUrl:'socks5://broken:1080'}))};
    const db = {};
    const service = new EgressService(db as AppDatabase,servers as unknown as ServerManager,'entry',execute);
    const cfg = {serverKey:'entry',status:'active',expiresAt:'2099-01-01',clientName:'same_certificate'} as VpnConfigRecord;
    await service.assign(cfg,'e2',4);
    expect(execute.mock.calls[0]![0]).toMatchObject({proxyUrl:undefined,command:'sudo -n /usr/local/sbin/vpnbot-egress-control'});
    expect(JSON.parse(execute.mock.calls[0]![0].input!.toString())).toMatchObject({action:'assign',client:'same_certificate',target:'e2',revision:4});
    expect(cfg.clientName).toBe('same_certificate');
  });
  it("does not expose SSH errors containing credentials", async () => {
    const service = new EgressService({} as AppDatabase,{resolveTarget:async()=>({})} as unknown as ServerManager,'entry',async()=>{throw new Error('password=top-secret');});
    await expect(service.snapshot()).rejects.toThrow('Обновите статус');
    await expect(service.snapshot()).rejects.not.toThrow('top-secret');
  });
  it("validates credential structure and preserves special characters in password", () => {
    expect(parseEgressCredentials('Резерв\n8.8.8.8\n22\nroot\n a$! + ').password).toBe(' a$! + ');
    expect(()=>parseEgressCredentials('Резерв\n8.8.8.8;id\n22\nroot\npass')).toThrow();
  });
  it("requires confirmation before bulk switch, with revision protection", async () => {
    const service = {snapshot:vi.fn(async()=>({revision:9,default:'e1',proxy:'e1',assignments:{},nodes:[{id:'e1',name:'A',status:'error'},{id:'e2',name:'B',status:'ready',telegram:true}]})),move:vi.fn(async()=>({moved:84}))};
    const admin = new EgressAdmin(service as unknown as EgressService), reply = vi.fn(async()=>{});
    await admin.action('vk:100',{a:'eg_move_preview',id:'e1',server:'e2'},reply);
    expect(service.move).not.toHaveBeenCalled();
    expect(reply.mock.calls.at(-1)![1][0][0].action).toMatchObject({a:'eg_move_confirm',page:9});
    await admin.action('vk:100',{a:'eg_move_tg_confirm',id:'e1',server:'e2',page:9},reply);
    expect(service.move).toHaveBeenCalledExactlyOnceWith('e1','e2',9,true);
  });
  it("does not let one administrator session consume another actor's password input", async () => {
    const service = {add:vi.fn(async()=>({id:'e2'}))};
    const admin = new EgressAdmin(service as unknown as EgressService), reply = vi.fn(async()=>{});
    await admin.action('vk:100',{a:'eg_credentials',id:'tg'},reply);
    await admin.text('vk:200','Reserve\n8.8.8.8\n22\nroot\nsecret',reply);
    expect(service.add).not.toHaveBeenCalled();
    await admin.text('vk:100','Reserve\n8.8.8.8\n22\nroot\nsecret',reply);
    expect(service.add).toHaveBeenCalledTimes(1); expect(admin.waiting('vk:100')).toBe(false);
    expect(JSON.stringify(reply.mock.calls)).not.toContain('secret');
  });
});

describe("independent Telegram runtime", () => {
  it("retries Telegram initialization without terminating other channels", async () => {
    const controller = new AbortController();
    const bot = {api:{setMyCommands:vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)},start:vi.fn(async()=>{controller.abort();})};
    const pause = vi.fn(async()=>{});
    await runTelegramWithRetry(bot as unknown as Bot,controller.signal,pause);
    expect(pause).toHaveBeenCalledOnce(); expect(bot.start).toHaveBeenCalledOnce();
  });
});
