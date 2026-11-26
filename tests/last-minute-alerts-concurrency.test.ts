import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import type pg from "pg";
import { realDatabase, realDatabaseUrl } from "./support/real-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const url = realDatabaseUrl();
const db = url ? await realDatabase(url) : null;
if (!db) {
  test("alertas internos: locks com conexões independentes", { skip: !process.env.CI && "Requer TEST_DATABASE_URL local descartável" }, () => {
    assert.fail("O CI precisa de TEST_DATABASE_URL para testar os locks dos alertas.");
  });
} else {
  const [setup,A,B,C] = await Promise.all([db.connect(),db.connect(),db.connect(),db.connect()]);
  const f = await rescheduleFixtures(async(sql,args=[]) => (await setup.query(sql,args)).rows as Row[]);
  after(()=>db.destroy());
  beforeEach(async()=>{
    await Promise.all([A,B,C].map(c=>c.query("rollback")));
    await setup.query("truncate public.last_minute_alert_attempts,public.last_minute_alerts,public.last_minute_session_events; update public.last_minute_alert_settings set enabled=false,first_activated_at=null,active_since=null,epoch=null");
    await f.call("public.admin_configure_last_minute_alerts($1::uuid,true)",[ADMIN]);
  });
  async function scalar<T>(client:pg.Client,sql:string,args:unknown[]=[]):Promise<T> {
    return (await client.query(`select ${sql} as value`,args)).rows[0].value as T;
  }
  const claim=(client:pg.Client)=>scalar<Array<{id:string;claimToken:string;payload:Row}>>(client,"public.claim_last_minute_alerts(2)");
  async function pending() {
    const session=await f.makeSession(f.IMERSAO.id,{price:f.uniquePrice(),startsIn:"36 hours"});
    const reserved=await f.call("public.create_pre_reservation($1::uuid,'Cliente Concorrente','12345678901','61999999999','concorrente@teste.local',2,'',gen_random_uuid())",[session]);
    return {session,reserved};
  }
  const confirm=(client:pg.Client,reserved:Row)=>scalar<boolean>(client,"public.confirm_reservation_payment($1::uuid,'INFINITEPAY',$2,$3,'','{}'::jsonb)",[reserved.reservationId,`tx-${reserved.reservationId}`,reserved.totalCents]);

  test("dois workers não reivindicam o mesmo alerta, mesmo antes do commit",async()=>{
    const {reserved}=await pending(); await confirm(setup,reserved);
    await A.query("begin");
    const first=await claim(A); assert.equal(first.length,1);
    // statement_timeout detecta bloqueio real: SKIP LOCKED deve responder vazio.
    await B.query("set statement_timeout='2s'");
    assert.deepEqual(await claim(B),[]);
    await A.query("commit");
    assert.deepEqual(await claim(C),[]);
  });

  test("webhooks simultâneos persistem uma única ocorrência",async()=>{
    const {reserved}=await pending();
    const results=await Promise.all([confirm(A,reserved),confirm(B,reserved)]);
    assert.deepEqual(results,[true,true]);
    assert.equal((await setup.query("select count(*)::int n from public.last_minute_alerts")).rows[0].n,1);
  });

  test("mudança de horário não confirmada + pagamento concorrente: recupera o horário final",async()=>{
    const {session,reserved}=await pending();
    await A.query("begin");
    await A.query("update public.sessions set starts_at=now()+interval '6 hours' where id=$1",[session]);
    await confirm(B,reserved); // Ainda enxerga a sessão de 36h.
    await A.query("commit");
    const result=await claim(C);
    assert.equal(result.length,1);
    assert.equal(result[0].payload.origin,"SESSION_TIME_CHANGED");
    assert.equal(result[0].payload.priority,"URGENTE");
    const states=(await setup.query("select origin,status from public.last_minute_alerts order by origin")).rows;
    assert.deepEqual(states,[{origin:"CONFIRMATION",status:"SKIPPED"},{origin:"SESSION_TIME_CHANGED",status:"SENDING"}]);
  });

  test("pagamento ainda não visível durante mudança de horário é recuperado na próxima passagem",async()=>{
    const {session,reserved}=await pending();
    await B.query("begin"); await confirm(B,reserved);
    await A.query("update public.sessions set starts_at=now()+interval '6 hours' where id=$1",[session]);
    assert.deepEqual(await claim(C),[],"pagamento ainda não commitado não envia");
    await B.query("commit");
    const result=await claim(C);
    assert.equal(result.length,1);
    assert.equal(result[0].payload.priority,"URGENTE");
    assert.equal(result[0].payload.origin,"SESSION_TIME_CHANGED");
  });

  test("alterar sessão durante claim não cria ciclo de locks e freeze revalida",async()=>{
    const {session,reserved}=await pending(); await confirm(setup,reserved);
    await A.query("begin"); const [first]=await claim(A);
    await B.query("set statement_timeout='2s'");
    await B.query("update public.sessions set starts_at=now()+interval '6 hours' where id=$1",[session]);
    const frozen=await scalar(A,"public.freeze_last_minute_alert($1::uuid,$2::uuid,'{}'::jsonb)",[first.id,first.claimToken]);
    assert.equal(frozen,null);
    await A.query("commit");
    const [replacement]=await claim(C);
    assert.equal(replacement.payload.priority,"URGENTE");
  });
}
