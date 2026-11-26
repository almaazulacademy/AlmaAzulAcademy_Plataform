import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, beforeEach } from "node:test";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { rescheduleFixtures, fakeResend, ADMIN, STRANGER, type Row } from "./support/reschedule-email-fixtures.ts";
import { ALERT_RECIPIENT, buildLastMinuteAlert, createLastMinuteAlertQueue, processLastMinuteAlerts, type AlertLog, type AlertPayload } from "../lib/reservations/last-minute-alerts.ts";
import { EmailProviderError } from "../lib/email/email-provider.ts";

// Postgres local em memória. Nunca usa o Supabase, InfinitePay ou Resend reais.
const db = await fullDatabase();
const f = await rescheduleFixtures(async (sql, args = []) => (await db.query(sql, args)).rows as Row[]);
const admin = createPgliteAdmin(db);
const queue = createLastMinuteAlertQueue(admin.client);
after(() => db.close());
beforeEach(async () => {
  await db.exec("truncate public.last_minute_alert_attempts,public.last_minute_alerts,public.last_minute_session_events; update public.last_minute_alert_settings set enabled=false,first_activated_at=null,active_since=null,epoch=null;");
  admin.clearFailures();
});
const activate = () => f.call("public.admin_configure_last_minute_alerts($1::uuid,true)", [ADMIN]);
const alerts = () => f.rows("select * from public.last_minute_alerts order by sequence_id,id");
async function booking(startsIn = "10 hours", quantity = 2, experience = f.IMERSAO.id) {
  const session = await f.makeSession(experience, { price: f.uniquePrice(), startsIn });
  const reservation = await f.reserve(session, quantity);
  return { session, reservation };
}
function runtime(provider = fakeResend()) {
  const logs: AlertLog[] = [];
  return { queue, provider, siteUrl: "https://www.almaazulacademy.com.br", log: (entry: AlertLog) => { logs.push(entry); }, logs };
}
async function due() { await db.exec("update public.last_minute_alerts set next_attempt_at=now()-interval '1 minute' where status='FAILED';"); }
async function expireLease() { await db.exec("update public.last_minute_alerts set locked_until=now()-interval '1 minute' where status='SENDING';"); }

test("migration começa desligada e não captura reservas antigas; ativar não faz backfill", async () => {
  const old = await booking();
  assert.equal((await alerts()).length, 0);
  await activate();
  assert.equal((await alerts()).length, 0);
  await f.call("public.confirm_reservation_payment($1::uuid,'INFINITEPAY','duplicate',100,'','{}'::jsonb)", [old.reservation.id]);
  const target = await f.makeSession(f.IMERSAO.id, { price: old.reservation.total / 2, startsIn: "5 hours" });
  await f.call("public.admin_change_reservation_session($1::uuid,$2::uuid,$3::uuid,'Troca de teste')", [ADMIN, old.reservation.id, target]);
  await f.rows("update public.sessions set starts_at=now()+interval '3 hours' where id=$1::uuid", [target]);
  assert.equal((await alerts()).length, 0, "nem repetição, remarcação ou edição de sessão recuperam reserva antiga");
});

test("pré-reserva existente antes de ativar não gera alerta ao pagar depois", async () => {
  const session = await f.makeSession(f.IMERSAO.id, { price: f.uniquePrice(), startsIn: "10 hours" });
  const r = await f.call("public.create_pre_reservation($1::uuid,'Cliente Antigo','12345678901','61999999999','teste@teste.local',1,'',gen_random_uuid())", [session]);
  await activate();
  await f.call("public.confirm_reservation_payment($1::uuid,'INFINITEPAY','late-activation',$2,'','{}'::jsonb)", [r.reservationId,r.totalCents]);
  assert.equal((await alerts()).length,0);
});

test("mesmo dia e múltiplos participantes: um alerta URGENTE, sem dados pessoais", async () => {
  await activate();
  const { reservation } = await booking("3 hours", 3);
  const r = runtime();
  assert.deepEqual(await processLastMinuteAlerts(r), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(r.provider.delivered.length, 1);
  const m = r.provider.delivered[0];
  assert.equal(m.to, ALERT_RECIPIENT);
  assert.match(m.subject, /URGENTE.*Lago Norte/);
  assert.match(m.text, /Participantes: 3/);
  assert.match(m.text, new RegExp(`/admin/reservas/${reservation.id}`));
  assert.ok(!m.text.includes(reservation.name) && !m.text.includes(reservation.email) && !m.text.includes(reservation.cpf));
  assert.equal((await alerts())[0].status,"SENT");
});

test("limites exatos: 24h URGENTE, acima de 24h PRIORITÁRIO, 48h incluídas, acima excluído", async () => {
  await activate();
  // Sessão e confirmed_at usam o mesmo now() da transação para precisão exata.
  for (const [interval, expected] of [["24 hours","URGENTE"],["24 hours 1 second","PRIORITARIO"],["48 hours","PRIORITARIO"],["48 hours 1 second",null]] as const) {
    await db.exec("begin");
    try {
      const price=f.uniquePrice();
      const s=await f.one("insert into public.sessions(experience_id,starts_at,duration_minutes,price_cents,capacity,status) values($1::uuid,now()+$2::interval,90,$3,10,'OPEN') returning id", [f.IMERSAO.id,interval,price]);
      const reserved=await f.reserve(s.id);
      const found=await f.rows("select priority from public.last_minute_alerts where reservation_id=$1::uuid",[reserved.id]);
      assert.equal(found[0]?.priority ?? null,expected);
      await db.exec("commit");
    } catch(error) { await db.exec("rollback"); throw error; }
  }
});

test("janela de 48h é por instante: depois de amanhã também pode ser PRIORITÁRIO", async () => {
  await activate();
  await booking("36 hours");
  assert.equal((await alerts())[0].priority,"PRIORITARIO");
});

test("pagamento pendente e reserva cancelada não enviam", async () => {
  await activate();
  const { reservation }=await booking();
  await f.call("public.admin_cancel_reservation($1::uuid,$2::uuid,'Cancelamento de teste')",[ADMIN,reservation.id]);
  const r=runtime();
  await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,0);
  assert.equal((await alerts())[0].status,"SKIPPED");
  const session=await f.makeSession(f.IMERSAO.id,{price:f.uniquePrice(),startsIn:"2 hours"});
  await f.call("public.create_pre_reservation($1::uuid,'Cliente Pendente','12345678901','61999999999','pendente@teste.local',1,'',gen_random_uuid())",[session]);
  assert.equal((await alerts()).length,1,"pré-reserva não é confirmação");
});

test("pagamento confirmado e webhook repetidos não duplicam alerta nem entrega", async () => {
  await activate();
  const {reservation}=await booking();
  for(let i=0;i<3;i++) await f.call("public.confirm_reservation_payment($1::uuid,'INFINITEPAY','duplicate',$2,'','{}'::jsonb)",[reservation.id,reservation.total]);
  assert.equal((await alerts()).length,1);
  const r=runtime();
  await processLastMinuteAlerts(r);
  await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
});

test("remarcação direta cria evento próprio e invalida o alerta anterior", async () => {
  await activate();
  const {reservation}=await booking();
  const destination=await f.makeSession(f.IMERSAO.id,{price:reservation.total/2,startsIn:"30 hours"});
  await f.call("public.admin_change_reservation_session($1::uuid,$2::uuid,$3::uuid,'Troca de teste')",[ADMIN,reservation.id,destination]);
  const r=runtime();
  await processLastMinuteAlerts(r);
  const state=await alerts();
  assert.deepEqual(state.map(x=>[x.origin,x.status]),[["CONFIRMATION","SKIPPED"],["RESCHEDULE","SENT"]]);
  assert.match(r.provider.delivered[0].text,/PRIORITÁRIO — Reserva remarcada/);
});

test("Stand-by não envia; reagendamento confirmado tem uma ocorrência", async () => {
  await activate();
  const {reservation}=await booking();
  await f.setStandby(reservation.id);
  const r=runtime();
  await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,0);
  const dest=await f.makeSession(f.IMERSAO.id,{price:reservation.total/2,startsIn:"8 hours"});
  await f.reschedule(reservation.id,dest);
  await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
  assert.equal((await alerts()).filter(a=>a.origin==="RESCHEDULE").length,1);
});

test("alterar horário da própria sessão captura reservas novas confirmadas", async () => {
  await activate();
  const {session}=await booking("4 days");
  assert.equal((await alerts()).length,0);
  await f.rows("update public.sessions set starts_at=now()+interval '20 hours' where id=$1::uuid",[session]);
  await queue.claim(2);
  assert.equal((await alerts())[0].origin,"SESSION_TIME_CHANGED");
  assert.equal((await alerts())[0].priority,"URGENTE");
});

test("Cápsula Bar é identificada pela base, sem depender do título", async () => {
  await activate();
  await booking("6 hours",2,f.SUNSET_CONCHA.id);
  assert.equal((await alerts())[0].base_name,"Cápsula Bar");
});

test("timeout após aceite repete a mesma chave e conteúdo sem duplicar entrega", async () => {
  await activate(); await booking();
  const r=runtime(); r.provider.next("accepted-then-timeout");
  await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
  await due(); await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
  assert.equal(r.provider.requests.length,2);
  assert.deepEqual(r.provider.requests[0],r.provider.requests[1]);
  assert.equal((await alerts())[0].status,"SENT");
});

test("aceite seguido de falha na gravação fica em processamento até recuperar com a mesma chave", async () => {
  await activate(); await booking();
  const r=runtime();
  admin.failRpc("complete_last_minute_alert",{message:"falha simulada"});
  await processLastMinuteAlerts(r);
  assert.equal((await alerts())[0].status,"SENDING");
  assert.ok(r.logs.some(x=>x.errorCode==="SENT_NOT_RECORDED"));
  assert.equal((await queue.claim(2)).length,0);
  await expireLease(); await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
  assert.equal((await alerts())[0].status,"SENT");
});

test("janela de idempotência vencida exige revisão e não envia novamente", async () => {
  await activate(); await booking("40 hours");
  const r=runtime(); r.provider.next("accepted-then-timeout");
  await processLastMinuteAlerts(r);
  await db.exec("update public.last_minute_alerts set first_attempt_at=now()-interval '24 hours',next_attempt_at=now()-interval '1 minute'");
  await processLastMinuteAlerts(r);
  assert.equal((await alerts())[0].status,"UNCERTAIN");
  assert.equal(r.provider.requests.length,1);
});

test("recusa permanente não é retentada automaticamente", async () => {
  await activate(); await booking();
  const r=runtime(); r.provider.next(new EmailProviderError("HTTP_422",false,"NOT_SENT"));
  await processLastMinuteAlerts(r); await processLastMinuteAlerts(r);
  assert.equal(r.provider.requests.length,1);
  assert.equal((await alerts())[0].status,"FAILED");
});

test("reivindicação exclusiva e token antigo não podem concluir uma tentativa nova", async () => {
  await activate(); await booking();
  const first=(await queue.claim(1))[0];
  assert.equal((await queue.claim(1)).length,0);
  await expireLease();
  const next=(await queue.claim(1))[0];
  assert.notEqual(first.claimToken,next.claimToken);
  await assert.rejects(()=>queue.complete(first));
  await queue.complete(next);
});

test("cancelamento entre claim e freeze impede o envio", async () => {
  await activate(); const {reservation}=await booking();
  const claim=(await queue.claim(1))[0];
  await f.call("public.admin_cancel_reservation($1::uuid,$2::uuid,'Cancelamento de teste')",[ADMIN,reservation.id]);
  assert.equal(await queue.freeze(claim,buildLastMinuteAlert(claim.payload,"https://www.almaazulacademy.com.br")),null);
});

test("desligar e reativar descarta backlog e não captura reservas do período anterior à primeira ativação", async () => {
  await activate(); await booking();
  await f.call("public.admin_configure_last_minute_alerts($1::uuid,false)",[ADMIN]);
  await booking();
  await activate();
  const r=runtime(); await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,0);
  assert.equal((await alerts())[0].status,"SKIPPED");
  await booking(); await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
});

test("confirmação depois do início é uma exceção explícita; alerta normal vencido é suprimido", async () => {
  await activate();
  const s=await f.makeSession(f.IMERSAO.id,{price:f.uniquePrice(),startsIn:"1 hour"});
  const pre=await f.call("public.create_pre_reservation($1::uuid,'Cliente Tardio','12345678901','61999999999','tardio@teste.local',1,'',gen_random_uuid())",[s]);
  await f.rows("update public.sessions set starts_at=now()-interval '1 minute' where id=$1::uuid",[s]);
  await f.call("public.confirm_reservation_payment($1::uuid,'INFINITEPAY','paid-late',$2,'','{}'::jsonb)",[pre.reservationId,pre.totalCents]);
  const r=runtime(); await processLastMinuteAlerts(r);
  assert.match(r.provider.delivered[0].text,/Confirmação após o início/);
  const normal=await booking();
  await f.rows("update public.last_minute_alerts set deadline=now()-interval '1 minute' where reservation_id=$1::uuid",[normal.reservation.id]);
  await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
});

test("permissões: só backend opera a fila; ativação exige administrador", async () => {
  await assert.rejects(()=>f.call("public.admin_configure_last_minute_alerts($1::uuid,true)",[STRANGER]),/ADMIN_FORBIDDEN/);
  const grants=await f.one("select has_function_privilege('anon','public.claim_last_minute_alerts(integer)','EXECUTE') anon, has_function_privilege('authenticated','public.claim_last_minute_alerts(integer)','EXECUTE') authenticated, has_function_privilege('service_role','public.claim_last_minute_alerts(integer)','EXECUTE') service");
  assert.deepEqual(grants,{anon:false,authenticated:false,service:true});
});

test("HTML escapado e datas em Brasília mesmo quando UTC já mudou de dia", () => {
  const p: AlertPayload={reservationId:"11111111-1111-4111-8111-111111111111",priority:"URGENTE",lateConfirmation:false,origin:"CONFIRMATION",experienceTitle:'Remada <script>alert(1)</script>',baseName:"Lago Norte",startsAt:"2026-12-01T01:30:00Z",confirmedAt:"2026-12-01T00:30:00Z",occurredAt:"2026-12-01T00:30:00Z",quantity:2};
  const m=buildLastMinuteAlert(p,"https://www.almaazulacademy.com.br");
  assert.match(m.text,/30 de nov\. de 2026, 22:30/);
  assert.ok(!m.html.includes("<script>"));
  assert.match(m.html,/&lt;script&gt;/);
});

test("voltar à turma original não ressuscita alertas antigos",async()=>{
  await activate(); const {session,reservation}=await booking();
  const dest=await f.makeSession(f.IMERSAO.id,{price:reservation.total/2,startsIn:"6 hours"});
  await f.call("public.admin_change_reservation_session($1::uuid,$2::uuid,$3::uuid,'Ida')",[ADMIN,reservation.id,dest]);
  await f.call("public.admin_change_reservation_session($1::uuid,$2::uuid,$3::uuid,'Volta')",[ADMIN,reservation.id,session]);
  const r=runtime(); await processLastMinuteAlerts(r);
  assert.equal(r.provider.delivered.length,1);
  assert.deepEqual((await alerts()).map(x=>x.status),["SKIPPED","SKIPPED","SENT"]);
});

test("alteração coletiva com mais de cem confirmações novas não esconde reserva ainda sem alerta",async()=>{
  await activate();
  const session=await f.makeSession(f.IMERSAO.id,{price:f.uniquePrice(),startsIn:"4 days",capacity:300});
  const pre=await f.call("public.create_pre_reservation($1::uuid,'Cliente Anterior','12345678901','61999999999','anterior@teste.local',1,'',gen_random_uuid())",[session]);
  const id="ffffffff-ffff-4fff-8fff-ffffffffffff";
  await f.rows("update public.reservations set id=$2::uuid where id=$1::uuid",[pre.reservationId,id]);
  await f.call("public.confirm_reservation_payment($1::uuid,'INFINITEPAY','first-old-window',$2,'','{}'::jsonb)",[id,pre.totalCents]);
  await f.rows("update public.sessions set starts_at=now()+interval '20 hours' where id=$1::uuid",[session]);
  for(let i=0;i<101;i++) await f.reserve(session);
  await queue.claim(2);
  const recovered=await f.rows("select origin from public.last_minute_alerts where reservation_id=$1::uuid",[id]);
  assert.deepEqual(recovered,[{origin:"SESSION_TIME_CHANGED"}]);
});

test("agendador não chama HTTP desligado ou vazio e respeita pausa",async()=>{
  await db.exec(`create schema vault; create table vault.secrets(name text);
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    insert into vault.secrets values('last_minute_alert_worker_secret');
    insert into vault.decrypted_secrets values
      ('last_minute_alert_worker_secret','SIMULATED_LOCAL_SECRET'),
      ('last_minute_alert_worker_url','https://www.almaazulacademy.com.br/api/cron/last-minute-alerts');
    create schema net; create table net.simulated_requests(id bigint generated always as identity);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
      returns bigint language plpgsql as $$declare result bigint; begin insert into net.simulated_requests default values returning id into result; return result; end$$;
    create or replace function cron.schedule(text,text,text) returns bigint language plpgsql as $$begin insert into cron.job values(55,$1,$2,$3,true); return 55; end$$;`);
  const script=readFileSync(new URL("../supabase/maintenance/last_minute_alerts_schedule.sql",import.meta.url),"utf8");
  await db.exec(script.replace("create extension if not exists pg_net with schema extensions;",""));
  const job=await f.one("select command from cron.job where jobid=55");
  const count=async()=>Number((await f.one("select count(*) n from net.simulated_requests")).n);
  await db.exec(job.command); assert.equal(await count(),0);
  await activate(); await db.exec(job.command); assert.equal(await count(),0);
  await booking(); await db.exec(job.command); assert.equal(await count(),1);
  await f.call("public.admin_configure_last_minute_alerts($1::uuid,false)",[ADMIN]);
  await db.exec(job.command); assert.equal(await count(),1);
});
