import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db.js';
import { seedDatabase, type Question } from '../server/seed.js';
import { LearningService, validateBackup, type AIProvider } from '../server/learning.js';

const config={level:'N5' as const,count:1,types:['single'] as ('single'|'reading')[],category:'word',mode:'practice' as const,source:'ai' as const,basis:'all' as const};
function setup(t:TestContext,ai?:AIProvider) {
  const directory=mkdtempSync(join(tmpdir(),'japanese-deduplication-'));
  const db=openDatabase(':memory:');seedDatabase(db);
  const service=new LearningService(db,ai,{backupDir:join(directory,'backups')});
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  return {db,service,directory};
}
function question(overrides:Record<string,unknown>={}) {
  return {type:'single',prompt:'「学校」の読み方は何ですか。',options:[{id:'a',text:'がっこう'},{id:'b',text:'がこう'}],answer:'a',acceptedAnswers:[],explanation:'「学校」は「がっこう」と読みます。',knowledgePoints:['学校'],points:10,rubric:'正しい選択で10点。',...overrides};
}
const output=(questions:Record<string,unknown>[])=>JSON.stringify({questions});
function storedQuestions(db:ReturnType<typeof openDatabase>,id:string):Question[] {
  return JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json));
}
function deferred<T>() {
  let resolve!:(value:T|PromiseLike<T>)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
function insertPaper(db:ReturnType<typeof openDatabase>,id:string,q:Record<string,unknown>,level='N5',stamp='2026-01-01T00:00:00.000Z') {
  db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'历史题目',level,'word','practice','builtin','draft',stamp,JSON.stringify([{...q,id:`question-${id}`,level,category:'word',source:'builtin'}]),JSON.stringify({...config,level,types:[q.type],source:'builtin'}));
}

test('AI checks persisted history despite new IDs and reordered options, then repairs once',async t=>{
  let calls=0;let history:Record<string,unknown>|undefined;
  const {db,service}=setup(t,{async generate(messages){
    calls++;
    if(calls===1)return output([question({id:'model-old-id'})]);
    if(calls===2){history=JSON.parse(messages[1].content);return output([question({id:'model-new-id',options:[{id:'x',text:'がこう'},{id:'y',text:'がっこう'}],answer:'y'})]);}
    assert.match(messages.at(-1)!.content,/历史题目.*重复/);
    return output([question({prompt:'「学校」はどんな場所ですか。'})]);
  }});
  const first=await service.createExam(config);const second=await service.createExam(config);
  assert.notEqual(first.id,second.id);assert.equal(calls,3);
  assert.equal(service.listExams().items.length,2);
  const summaries=history!.recentQuestions as Record<string,unknown>[];
  assert.equal(summaries.length,1);assert.equal(summaries[0].prompt,question().prompt);
  for(const key of ['id','answer','options','explanation','knowledgePoints'])assert.equal(Object.hasOwn(summaries[0],key),false,key);
  assert.notEqual(storedQuestions(db,first.id)[0].prompt,storedQuestions(db,second.id)[0].prompt);
  assert.equal(service.isBusy(),false);
});

test('same-paper repetitions that survive the repair are rejected without saving any paper',async t=>{
  let calls=0;const {db,service}=setup(t,{async generate(){calls++;return output([question({id:'one'}),question({id:'two',options:[{id:'b',text:'がこう'},{id:'a',text:'がっこう'}]})]);}});
  await assert.rejects(service.createExam({...config,count:2}),(error:any)=>error.code==='DUPLICATE_AI_QUESTION'&&error.status===502);
  assert.equal(calls,2);assert.equal(service.listExams().items.length,0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM exams').get()!.count),0);
  assert.equal(service.isBusy(),false);
});

test('NFC and whitespace variants still match history while Japanese letters remain distinct',async t=>{
  let calls=0;const {service}=setup(t,{async generate(){calls++;return output([question({prompt:calls===1?'学校で がくせいを見ます。':calls===4?'学校で がくせいを見ました。':' \n学校で \t か\u3099くせいを見ます。 \r\n'})]);}});
  await service.createExam(config);
  await assert.rejects(service.createExam(config),(error:any)=>error.code==='DUPLICATE_AI_QUESTION');
  assert.equal(calls,3);assert.equal(service.listExams().items.length,1);
  assert.ok(await service.createExam(config));
  assert.equal(calls,4);assert.equal(service.listExams().items.length,2);
});

test('a knowledge point can recur in different sentences and reading material',async t=>{
  let calls=0;const {service}=setup(t,{async generate(){
    calls++;
    if(calls<=2)return output([question({prompt:calls===1?'「学校」の読み方を選んでください。':'「学校」を使った文として正しいものを選んでください。'})]);
    return output([question({type:'reading',prompt:'文章の内容として正しいものを選んでください。',passage:calls===3?'毎日、私は学校へ歩いて行きます。':'今日、田中さんは学校を休みました。'})]);
  }});
  await service.createExam(config);await service.createExam(config);
  await service.createExam({...config,types:['reading']});await service.createExam({...config,types:['reading']});
  assert.equal(calls,4);assert.equal(service.listExams().items.length,4);
});

test('history in the prompt is relevant and bounded but older omitted history is still checked',async t=>{
  let calls=0;let summary:Record<string,unknown>[]=[];
  const old=question({prompt:'これは最も古い既存の問題です。',type:'reading',passage:'以前に読んだ学校の文章です。'});
  const {db,service}=setup(t,{async generate(messages){
    calls++;summary=JSON.parse(messages[1].content).recentQuestions;
    return output([calls===1?old:question({type:'reading',prompt:'修復後の新しい問題です。',passage:'学校から帰って、友達と図書館に行きます。'})]);
  }});
  insertPaper(db,'old',old);
  for(let i=0;i<45;i++)insertPaper(db,`large-${i}`,question({type:'reading',prompt:`同等级历史 ${i} ${'\\\n'.repeat(400)}`,passage:'\\\n'.repeat(1000)}),'N5',new Date(Date.UTC(2026,1,1+i)).toISOString());
  insertPaper(db,'unrelated-level',question({type:'reading',prompt:'其他等级不进入摘要',passage:'別の文章です。'}),'N4','2026-09-01T00:00:00.000Z');
  insertPaper(db,'unrelated-type',question({prompt:'其他题型不进入摘要'}),'N5','2026-09-02T00:00:00.000Z');
  const result=await service.createExam({...config,types:['reading']});
  assert.ok(result.id);assert.equal(calls,2);
  assert.ok(summary.length>0&&summary.length<=30);
  assert.ok(JSON.stringify(summary).length<=12_000);
  assert.ok(summary.every(item=>item.type==='reading'&&String(item.prompt).startsWith('同等级历史')));
  assert.ok(!JSON.stringify(summary).includes(old.prompt));
  assert.equal(storedQuestions(db,result.id)[0].prompt,'修復後の新しい問題です。');
});

test('queued AI papers stay distinct, see newly saved history and block restore or deletion backup',async t=>{
  const firstStarted=deferred<void>();const secondStarted=deferred<void>();
  const firstResponse=deferred<string>();const secondResponse=deferred<string>();
  let calls=0;let secondHistory:Record<string,unknown>[]=[];
  const {service,directory}=setup(t,{async generate(messages){
    calls++;
    if(calls===1){firstStarted.resolve();return firstResponse.promise;}
    if(calls===2){secondHistory=JSON.parse(messages[1].content).recentQuestions;secondStarted.resolve();return secondResponse.promise;}
    return output([question({prompt:'排队后的新问题：请选择学校的意思。'})]);
  }});
  const before=service.backup();
  const first=service.createExam(config);const second=service.createExam(config);
  assert.equal(service.isBusy(),true);await firstStarted.promise;
  assert.equal(calls,1,'a second AI call waits until the first paper is saved');
  assert.throws(()=>service.restore(before),(error:any)=>error.code==='RESTORE_BUSY');
  assert.throws(()=>service.createDeletionBackup(),(error:any)=>error.code==='DELETE_BUSY');
  firstResponse.resolve(output([question()]));
  const firstResult=await first;await secondStarted.promise;
  assert.equal(service.isBusy(),true,'a queued or generating second paper remains busy');
  assert.equal(secondHistory[0].prompt,question().prompt);
  assert.throws(()=>service.restore(before),(error:any)=>error.code==='RESTORE_BUSY');
  secondResponse.resolve(output([question()]));
  const secondResult=await second;
  assert.notEqual(firstResult.id,secondResult.id);assert.equal(calls,3);
  assert.equal(service.listExams().items.length,2);assert.equal(service.isBusy(),false);
  assert.deepEqual(readdirSync(directory),[],'busy deletion attempts do not create a backup');
});

test('failed generation releases the queue and transport failures do not trigger a repair',async t=>{
  let calls=0;const {service}=setup(t,{async generate(){calls++;if(calls===1)throw Object.assign(new Error('transport failed'),{code:'MODEL_STREAM_INTERRUPTED'});return output([question()]);}});
  const failed=service.createExam(config);const next=service.createExam(config);
  await assert.rejects(failed,(error:any)=>error.code==='MODEL_STREAM_INTERRUPTED');
  assert.ok((await next).id);assert.equal(calls,2);
  assert.equal(service.listExams().items.length,1);assert.equal(service.isBusy(),false);
});

test('knowledge labels are normalized once per question before storage and statistics',async t=>{
  const {db,service}=setup(t,{async generate(){return output([question({knowledgePoints:[' 学校 ','学校','か\u3099','が']})]);}});
  const {id}=await service.createExam(config);const q=storedQuestions(db,id)[0];
  assert.deepEqual(q.knowledgePoints,['学校','が']);
  service.saveAnswers(id,{[q.id]:q.answer});await service.submit(id);
  assert.deepEqual(service.dashboard().weakPoints.map(point=>({name:point.name,attempts:point.attempts,accuracy:point.accuracy})),[{name:'学校',attempts:1,accuracy:100},{name:'が',attempts:1,accuracy:100}]);
  validateBackup(service.backup());
});

test('internal deletion backup is atomic and complete even for an unfinished exam, excluding private tables',async t=>{
  const {db,service,directory}=setup(t);
  const {id}=await service.createExam({...config,source:'builtin',mode:'exam'});
  service.toggleSaved('word-N5-1','word');
  db.prepare('INSERT INTO local_ai_requests(created_at) VALUES(?)').run(12345);
  db.exec('CREATE TABLE credentials (value TEXT NOT NULL)');
  db.prepare('INSERT INTO credentials(value) VALUES(?)').run('private-test-marker');
  assert.throws(()=>service.backup(),(error:any)=>error.code==='BACKUP_EXAM_IN_PROGRESS');
  const file=service.createDeletionBackup();const text=readFileSync(file,'utf8');const snapshot=JSON.parse(text);
  assert.match(basename(file),/^before-delete-\d{4}-\d{2}-\d{2}T.*\.json$/);
  assert.deepEqual(readdirSync(join(directory,'backups')),[basename(file)]);
  assert.equal(snapshot.tables.exams[0].id,id);assert.equal(snapshot.tables.exams[0].status,'draft');
  assert.equal(snapshot.tables.saved.length,1);assert.equal(snapshot.version,3);validateBackup(snapshot);
  assert.equal(Object.hasOwn(snapshot.tables,'local_ai_requests'),false);
  assert.equal(Object.hasOwn(snapshot.tables,'credentials'),false);assert.ok(!text.includes('private-test-marker'));
  assert.equal(service.getExam(id).status,'draft','creating a safety copy does not change data');
});
