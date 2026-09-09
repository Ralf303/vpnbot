import { describe, expect, it, vi } from "vitest";
import { VkBot } from "../src/vk-bot.js";
import type { VkApiClient, VkLongPollUpdate } from "../src/vk-api.js";
import type { AppDatabase } from "../src/database.js";
import type { ConfigService } from "../src/config-service.js";
import type { ServerManager } from "../src/server-manager.js";
import type { TrafficService } from "../src/traffic-service.js";
import type { EgressService } from "../src/egress-service.js";

function fixture() {
  const api={sendMessage:vi.fn(async()=>1),answerMessageEvent:vi.fn(async()=>{}),getUser:vi.fn()};
  const users:Record<string,any>={'1000':{id:1,telegramId:'100'},'2000':{id:2,telegramId:'200'},'4000':{id:4,telegramId:null}};
  const db={getUserByVkId:vi.fn(async(id:string)=>users[id]),getConfig:vi.fn(async()=>({id:'cfg',userId:2,serverKey:'entry',clientName:'original',status:'active',expiresAt:'2099-01-01'}))};
  const configs={recreate:vi.fn()};
  const egress={snapshot:vi.fn(async()=>({revision:1,default:'e1',proxy:'e1',nodes:[{id:'e1',name:'A',host:'1.1.1.1',status:'ready',telegram:true}],assignments:{}})),manages:()=>true,assign:vi.fn(async()=>{}),configExit:vi.fn(async()=> 'e1')};
  const bot=new VkBot(api as unknown as VkApiClient,db as unknown as AppDatabase,configs as unknown as ConfigService,{} as TrafficService,{} as ServerManager,'UTC',
    {egress:egress as unknown as EgressService,adminTelegramId:'100',adminVkId:'4000'});
  const update=(u:VkLongPollUpdate)=>(bot as unknown as {handleUpdate(u:VkLongPollUpdate):Promise<void>}).handleUpdate(u);
  const callback=(id:number,peer=id,payload:unknown={a:'eg_list'})=>update({type:'message_event',object:{event_id:'event',user_id:id,peer_id:peer,payload}});
  return {api,db,egress,configs,update,callback};
}
describe('VK emergency authorization',()=>{
  it('rejects regular users and group callbacks even from an admin',async()=>{
    const f=fixture();await f.callback(2000);await f.callback(1000,2000000010);
    expect(f.egress.snapshot).not.toHaveBeenCalled();
    expect(f.api.sendMessage.mock.calls.every(([m])=>m.message.includes('Недостаточно прав'))).toBe(true);
  });
  it('allows linked admin and explicit emergency VK id without any live Telegram dependency',async()=>{
    const f=fixture();await f.callback(1000);await f.callback(4000);
    expect(f.egress.snapshot).toHaveBeenCalledTimes(2);
  });
  it('allows the explicit VK admin to enter via a private text command before the Telegram link gate',async()=>{
    const f=fixture();await f.update({type:'message_new',object:{message:{from_id:4000,peer_id:4000,text:'/admin'}}});
    expect(f.egress.snapshot).toHaveBeenCalledOnce();expect(f.api.getUser).not.toHaveBeenCalled();
  });
  it('guards ownership and changes only routing for a valid config',async()=>{
    const f=fixture();const action={a:'exit-confirm',id:'cfg',server:'e2',page:1};
    await f.callback(1000,1000,action);expect(f.egress.assign).not.toHaveBeenCalled();
    await f.callback(2000,2000,action);expect(f.egress.assign).toHaveBeenCalledOnce();expect(f.configs.recreate).not.toHaveBeenCalled();
  });
});
