import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {openDatabase} from '../server/db.js';
import {seedDatabase,type Question} from '../server/seed.js';
import {LearningService,validateBackup,type AIProvider} from '../server/learning.js';
import {createLearningRouter} from '../server/learning-router.js';
import {localBoundary,errorHandler} from '../server/security.js';

type Messages=Parameters<AIProvider['generate']>[0];
type PlanGroup={kind:string;questionCount:number;minCharacters:number;maxCharacters:number;targetCharacters:number};
type Payload={count?:number;types?:string[];readingPlan?:{readingQuestionCount:number;ordinaryQuestionCount:number;groups:PlanGroup[]};reviewPoints?:{id:string}[];marks?:{id:string;text:string}[];selectedText?:string;currentQuestion?:string;question?:Question;[key:string]:unknown};
type Reply=(payload:Payload,messages:Messages,serial:number)=>string|Promise<string>;
const options=[{id:'A',text:'説明を確かめてから行動する。'},{id:'B',text:'予定を全て取り消す。'},{id:'C',text:'すぐ帰って何もしない。'},{id:'D',text:'ほかの人に任せて忘れる。'}];
const normalized={title:'済む',kind:'word',reading:'すむ',meaning:'结束、办完。',focus:'掌握词典形、读音和搭配，不局限于済んで的て形。',note:'仕事が済む；これで済む。'};
function question(type:string,index:number,serial:number,pointId?:string){
  return {type,prompt:`演習${serial}問${index+1}：筆者がこの行動を選んだ理由は何ですか。`,...(type==='single'||type==='reading'?{options:structuredClone(options)}:{}),answer:type==='single'||type==='reading'?'A':'確認',acceptedAnswers:type==='fill'?['確認']:[],explanation:'本文では、説明を確認してから行動する必要があると述べている。Bは取消し、Cは帰宅、Dは他人任せという本文にない内容のため誤り。',knowledgePoints:['済む','理由と文脈'],points:10,rubric:'原文に合う選択肢Aを選ぶ。',...(pointId?{reviewPointIds:[pointId]}:{})};
}
function material(group:PlanGroup,index:number,serial:number){
  const head=`資料${serial}－${index+1}（${group.kind}）：🗾説明が済んでから、図書館へ行きます。`;
  const sentence='必要な条件を確認し、自分に合う方法を選びます。';
  const target=Math.max(group.minCharacters,Math.min(group.maxCharacters,group.targetCharacters));
  return Array.from(head+sentence.repeat(Math.ceil(target/sentence.length)+1)).slice(0,target).join('');
}
function generated(payload:Payload,serial:number){
  const points=payload.reviewPoints||[];let offset=0;
  const point=()=>points.length?points[offset++%points.length].id:undefined;
  if(!payload.readingPlan)return {questions:Array.from({length:payload.count||1},(_,index)=>({...question(payload.types?.[index%(payload.types?.length||1)]||'single',index,serial,point()),...(payload.types?.includes('reading')?{passage:`短い旧形式の文章${serial}。説明を確認します。`}:{})}))};
  const plan=payload.readingPlan,ordinaryTypes=payload.types!.filter(type=>type!=='reading');
  return {questions:Array.from({length:plan.ordinaryQuestionCount},(_,index)=>question(ordinaryTypes[index%ordinaryTypes.length],index,serial,point())),readingGroups:plan.groups.map((group,g)=>({title:`資料${serial}－${g+1}`,kind:group.kind,passage:material(group,g,serial),questions:Array.from({length:group.questionCount},(_,index)=>{const {type,...item}=question('reading',g*10+index,serial,point());return item;})}))};
}
const defaultReply:Reply=(payload,_messages,serial)=>{
  if(payload.marks)return JSON.stringify({explanations:payload.marks.map(mark=>({id:mark.id,reading:'すんで',meaning:'完成、结束后。',analysis:`「${mark.text}」需结合完整阅读材料理解。`,examples:[{ja:'仕事が済んでから帰ります。',zh:'工作结束后回去。'}],tip:'原形是済む。'}))});
  if(payload.selectedText)return JSON.stringify(normalized);
  if(payload.answerToReview!==undefined)return JSON.stringify({score:payload.answerToReview===(payload.question as any)?.referenceAnswer?10:0,feedback:'根据保存的完整材料及真实选项评阅。',suggestion:'对照材料中的理由理解。',reference:'A'});
  if(payload.currentQuestion)return '这处表达要结合整篇材料理解，说明先完成前项再进行后项。';
  return JSON.stringify(generated(payload,serial));
};
async function setup(t:TestContext,reply:Reply=defaultReply){
  const directory=mkdtempSync(join(tmpdir(),'japanese-reading-groups-http-')),db=openDatabase(':memory:');seedDatabase(db);
  const requests:{payload:Payload;messages:Messages;model?:string}[]=[];
  const provider:AIProvider={async generate(messages,model){const payload=JSON.parse(messages.find(message=>message.role==='user')!.content) as Payload;requests.push({payload:structuredClone(payload),messages:structuredClone(messages),model});return reply(payload,messages,requests.length);}};
  const service=new LearningService(db,provider,{backupDir:join(directory,'backups')});let extraBusy=false;
  const app=express(),server=app.listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  app.use(localBoundary(origin));app.use(express.json({limit:'15mb'}));app.use('/api',createLearningRouter(service,db,()=>extraBusy));app.use(errorHandler);
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  async function call(path:string,body?:unknown,method='POST'){
    const response=await fetch(origin+'/api'+path,body===undefined?undefined:{method,headers:{Origin:origin,'X-Study-Client':'local-web','Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,json:await response.json() as any};
  }
  const create=(extra:Record<string,unknown>={})=>call('/exams',{level:'N3',count:10,types:['reading'],source:'ai',mode:'exam',gradingMode:'mixed',readingMode:'grouped',...extra});
  const full=(id:string)=>JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json)) as Question[];
  const submit=async(id:string,answers?:Record<string,string>)=>{await call('/exams/'+id+'/answers',{answers:answers||Object.fromEntries(full(id).map(q=>[q.id,q.answer]))},'PUT');return call('/exams/'+id+'/submit',{});};
  return {db,service,requests,origin,call,create,full,submit,setExtraBusy:(value:boolean)=>{extraBusy=value;}};
}

test('grouped reading generation follows the level plan and counts independent subquestions for pure and mixed papers',async t=>{
  const {create,call,requests}=await setup(t);
  for(const config of [{level:'N3',count:10,types:['reading']},{level:'N4',count:12,types:['single','fill','reading']},{level:'N2',count:12,types:['reading']}]){
    const made=await create(config);assert.equal(made.status,200,JSON.stringify(made.json));
    const exam=(await call('/exams/'+made.json.id)).json;assert.equal(exam.questions.length,config.count);assert.equal(new Set(exam.questions.map((q:any)=>q.id)).size,config.count);
    const plan=requests.at(-1)!.payload.readingPlan!;assert.ok(plan);assert.equal(plan.readingQuestionCount+plan.ordinaryQuestionCount,config.count);
    const reading=exam.questions.filter((q:any)=>q.type==='reading');assert.equal(reading.length,plan.readingQuestionCount);
    assert.ok(config.types.every(type=>exam.questions.some((q:any)=>q.type===type)));
    const groups=new Map<string,any[]>();for(const q of reading){assert.ok(q.readingGroup);const members=groups.get(q.readingGroup.id)||[];members.push(q);groups.set(q.readingGroup.id,members);assert.equal(q.options.length,4);assert.equal(q.answer,undefined);assert.equal(q.explanation,undefined);assert.equal(q.rubric,undefined);}
    assert.equal(groups.size,plan.groups.length);assert.ok([...groups.values()].some(group=>group.length>1));
    for(const [index,members] of [...groups.values()].entries()){assert.equal(members.length,plan.groups[index].questionCount);assert.equal(members[0].readingGroup.kind,plan.groups[index].kind);assert.ok(members.every(q=>q.passage===members[0].passage&&q.readingGroup.title===members[0].readingGroup.title));}
    if(config.level==='N3')for(const kind of ['short','medium','long','information'])assert.ok(reading.some((q:any)=>q.readingGroup.kind===kind),kind);
    if(config.level==='N2')assert.ok(reading.some((q:any)=>q.readingGroup.kind==='integrated'));
  }
  assert.equal(requests.length,3,'each valid paper uses one generation, not one request per subquestion');
});

test('practice feedback reveals only the selected subquestion and mixed grading scores each group member independently',async t=>{
  const {create,call,full,requests}=await setup(t);const made=await create({level:'N4',count:5,mode:'practice'});assert.equal(made.status,200,JSON.stringify(made.json));
  const qs=full(made.json.id),first=qs.find(q=>qs.filter(other=>other.readingGroup!.id===q.readingGroup!.id).length>1)!,sibling=qs.find(q=>q.id!==first.id&&q.readingGroup!.id===first.readingGroup!.id)!;
  await call('/exams/'+made.json.id+'/answers',{answers:{[first.id]:'A',[sibling.id]:'B'}},'PUT');
  const feedback=await call('/exams/'+made.json.id+'/feedback',{questionId:first.id});assert.equal(feedback.status,200);assert.equal(feedback.json.grades[first.id].score,10);assert.equal(feedback.json.questions.find((q:any)=>q.id===first.id).answer,'A');
  for(const q of feedback.json.questions.filter((q:any)=>q.id!==first.id)){assert.equal(q.answer,undefined);assert.equal(q.acceptedAnswers,undefined);assert.equal(q.explanation,undefined);assert.equal(q.rubric,undefined);}
  const done=await call('/exams/'+made.json.id+'/submit',{});assert.equal(done.status,200);assert.equal(done.json.score,10);assert.equal(done.json.grades[sibling.id].score,0);assert.equal(done.json.maxScore,50);assert.equal(requests.length,1,'objective group feedback and submission remain local');
});

test('shared materials retain exact UTF-16 marks, deferred AI explanations, direct questions and automatic knowledge review',async t=>{
  const {create,call,full,requests,service}=await setup(t);const made=await create({count:8});assert.equal(made.status,200,JSON.stringify(made.json));const id=made.json.id,qs=full(id);
  const owner=qs.find(q=>qs.filter(other=>other.readingGroup!.id===q.readingGroup!.id).length>1)!,sibling=qs.find(q=>q.id!==owner.id&&q.readingGroup!.id===owner.readingGroup!.id)!;
  const anchors=[{questionId:owner.id,source:'passage',text:'済んで',start:owner.passage!.indexOf('済んで')},{questionId:sibling.id,source:'prompt',text:'理由',start:sibling.prompt.indexOf('理由')},{questionId:sibling.id,source:'option',optionId:'A',text:'説明',start:sibling.options![0].text.indexOf('説明')}];
  for(const anchor of anchors){const saved=await call('/exams/'+id+'/annotations',{...anchor,end:anchor.start+anchor.text.length});assert.equal(saved.status,200,JSON.stringify(saved.json));assert.equal(saved.json.item.text,anchor.text);assert.equal(saved.json.item.start,anchor.start);}
  const mark=anchors[0];assert.ok(owner.passage!.slice(0,mark.start).includes('🗾'),'the exact offset includes a surrogate pair before the mark');
  const point=await call('/review/points',{examId:id,...mark,end:mark.start+mark.text.length,scope:'broad',intent:'记住读法和整体用法。'});assert.equal(point.status,200,JSON.stringify(point.json));assert.equal(point.json.item.sources[0].context,owner.passage);
  const queued=await call('/exams/'+id+'/discussion',{questionId:sibling.id,text:'这篇材料里为什么先确认条件再行动？',clientRequestId:randomUUID()});assert.equal(queued.status,200);assert.equal(queued.json.item.status,'queued');
  assert.equal((await call('/exams/'+id+'/annotations/explain',{})).status,403);assert.equal((await call('/review/points/'+point.json.item.id+'/normalize',{})).status,403);assert.equal(requests.length,1);
  await call('/exams/'+id+'/answers',{answers:Object.fromEntries(qs.map(q=>[q.id,'A']))},'PUT');assert.equal((await call('/exams/'+id+'/feedback',{questionId:sibling.id})).status,403,'exam mode must not reveal any group answer before submission');
  const done=await call('/exams/'+id+'/submit',{});assert.equal(done.status,200);assert.equal(done.json.score,80);const grades=JSON.stringify(done.json.grades);
  const explained=await call('/exams/'+id+'/annotations/explain',{});assert.equal(explained.status,200);assert.ok(explained.json.items.every((item:any)=>item.status==='completed'));
  const markRequests=requests.filter(request=>request.payload.marks);assert.equal(markRequests.length,2);assert.equal(markRequests.find(request=>request.payload.question!.id===owner.id)!.payload.question!.passage,owner.passage);
  const answered=await call('/exams/'+id+'/discussion/'+queued.json.item.id+'/reply',{});assert.equal(answered.status,200);assert.equal(answered.json.item.status,'completed');assert.equal(requests.at(-1)!.payload.question!.passage,sibling.passage);
  const organized=await call('/review/points/'+point.json.item.id+'/normalize',{});assert.equal(organized.status,200,JSON.stringify(organized.json));assert.equal(organized.json.item.status,'active');assert.equal(organized.json.item.title,'済む');assert.equal(organized.json.item.sources[0].text,'済んで');assert.equal(organized.json.item.sources[0].start,mark.start);assert.equal(requests.at(-1)!.payload.context,owner.passage);
  assert.equal(JSON.stringify(service.getExam(id).grades),grades,'analysis and question discussion never regrade the paper');
  const backup=(await call('/backup')).json;assert.equal(backup.version,5);assert.doesNotThrow(()=>validateBackup(backup));assert.equal((await call('/restore',backup)).status,200);assert.equal((await call('/exams/'+id)).json.questions.find((q:any)=>q.id===owner.id).passage,owner.passage);
  assert.equal((await call('/review/points/'+organized.json.item.id,{},'DELETE')).status,200);assert.equal(service.getExam(id).questions.length,8);assert.ok(service.getExam(id).questions.every(q=>q.readingGroup));
});

test('group snapshots validate before restore writes and a single wrong subquestion can be repeated with its full material',async t=>{
  const {create,call,full,db,service}=await setup(t);const made=await create({count:8});assert.equal(made.status,200,JSON.stringify(made.json));const id=made.json.id,qs=full(id);
  await call('/exams/'+id+'/answers',{answers:Object.fromEntries(qs.map(q=>[q.id,'B']))},'PUT');assert.equal((await call('/exams/'+id+'/submit',{})).status,200);
  const backup=(await call('/backup')).json,grouped=qs.find(q=>qs.filter(other=>other.readingGroup!.id===q.readingGroup!.id).length>1)!,mate=qs.find(q=>q.id!==grouped.id&&q.readingGroup!.id===grouped.readingGroup!.id)!;
  const corruptions=[(questions:any[])=>{questions.find(q=>q.id===mate.id).passage+='違う原文';},(questions:any[])=>{questions.find(q=>q.id===mate.id).readingGroup.title='異なる題名';},(questions:any[])=>{questions.find(q=>q.id===mate.id).readingGroup.kind='invalid-kind';},(questions:any[])=>{const index=questions.findIndex(q=>q.id===mate.id);[questions[index],questions[index+1]]=[questions[index+1],questions[index]];}];
  for(const corrupt of corruptions){const bad=structuredClone(backup),row=bad.tables.exams.find((exam:any)=>exam.id===id),questions=JSON.parse(row.questions_json);corrupt(questions);row.questions_json=JSON.stringify(questions);const before=db.prepare('SELECT total_changes() AS n').get()!.n;assert.equal((await call('/restore',bad)).status,400);assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before,'bad group backup must fail before writes');}
  const repeated=await call('/exams',{level:'N3',count:1,types:['reading'],source:'builtin',questionIds:[mate.id],mode:'practice'});assert.equal(repeated.status,200,JSON.stringify(repeated.json));const paper=(await call('/exams/'+repeated.json.id)).json;assert.equal(paper.questions.length,1);assert.equal(paper.questions[0].passage,mate.passage);assert.equal(paper.questions[0].readingGroup,undefined);assert.equal(paper.questions[0].reviewPointIds,undefined);
  assert.doesNotThrow(()=>validateBackup(JSON.parse(readFileSync(service.createDeletionBackup(),'utf8'))));
  const whole=await call('/exams/'+id+'/repeat',{});assert.equal(whole.status,200,JSON.stringify(whole.json));assert.equal((await call('/exams/'+whole.json.id)).json.questions.length,qs.length);
});

test('malformed grouped model output gets one repair and never saves a partial paper',async t=>{
  for(const fault of ['length','kind','missing-group','subquestion-count','three-options','extra-field'] as const){
    const {create,db,requests}=await setup(t,(payload,_messages,serial)=>{const output=generated(payload,serial) as any,group=output.readingGroups[0];if(fault==='length')group.passage='短い。';if(fault==='kind')group.kind='integrated';if(fault==='missing-group')output.readingGroups.pop();if(fault==='subquestion-count')group.questions.push({...group.questions[0],prompt:'追加の不正な問題。'});if(fault==='three-options')group.questions[0].options.pop();if(fault==='extra-field')group.questions[0].readingGroup={id:'forged'};return JSON.stringify(output);});
    const before=db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n;const failed=await create();assert.equal(failed.status,502,`${fault}: ${JSON.stringify(failed.json)}`);assert.equal(requests.length,2,fault);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n,before,fault);
  }
});

test('new grouped papers reject historical materials even when their question prompts are changed',async t=>{
  const {create,db,requests}=await setup(t,(payload,_messages,serial)=>{const output=generated(payload,serial) as any;output.readingGroups.forEach((group:any,index:number)=>{group.passage=material(payload.readingPlan!.groups[index],index,1);});return JSON.stringify(output);});
  const first=await create();assert.equal(first.status,200,JSON.stringify(first.json));const repeated=await create();assert.equal(repeated.status,502,JSON.stringify(repeated.json));assert.equal(requests.length,3);assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n),1);
});

test('review papers can target shared reading groups while retaining exact concept coverage',async t=>{
  const {call,requests}=await setup(t);const points=[];
  for(const title of ['済む','確かめる']){const added=await call('/review/points',{text:title,level:'N3'});const saved=await call('/review/points/'+added.json.item.id+'/confirm',{...normalized,title});assert.equal(saved.status,200);points.push(saved.json.item);}
  const made=await call('/review/exams',{level:'N3',count:8,types:['reading'],mode:'exam',gradingMode:'mixed',pointIds:points.map(point=>point.id),readingMode:'grouped'});assert.equal(made.status,200,JSON.stringify(made.json));
  const exam=(await call('/exams/'+made.json.id)).json;assert.equal(exam.questions.length,8);assert.ok(exam.questions.every((q:any)=>q.readingGroup));assert.deepEqual(new Set(exam.questions.flatMap((q:any)=>q.reviewPointIds)),new Set(points.map(point=>point.id)));assert.equal(requests.length,1);
});

test('grouped reading keeps the forty-subquestion limit, Origin and busy guards, and old single-reading clients remain valid',async t=>{
  const {create,call,origin,requests,setExtraBusy}=await setup(t);
  const forbidden=await fetch(origin+'/api/exams',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:JSON.stringify({level:'N3',count:8,types:['reading'],source:'ai',readingMode:'grouped'})});assert.equal(forbidden.status,403);assert.equal(requests.length,0);
  for(const config of [{count:41},{level:'KANA'},{source:'builtin'}]){const bad=await create(config);assert.equal(bad.status,400,JSON.stringify(bad.json));assert.equal(requests.length,0);}
  const forty=await create({count:40});assert.equal(forty.status,200,JSON.stringify(forty.json));assert.equal((await call('/exams/'+forty.json.id)).json.questions.length,40);
  const old=await create({level:'N5',count:2,readingMode:'single'});assert.equal(old.status,200,JSON.stringify(old.json));const legacy=(await call('/exams/'+old.json.id)).json;assert.ok(legacy.questions.every((q:any)=>q.passage.length<100&&q.readingGroup===undefined));
  setExtraBusy(true);assert.equal((await call('/review/exams',{level:'N3',count:8,types:['reading'],readingMode:'grouped'})).status,409);setExtraBusy(false);assert.equal(requests.length,2);
});

test('all-AI grading receives each reading subquestion with the complete shared material and original option meanings',async t=>{
  const {create,call,full,requests}=await setup(t);const made=await create({level:'N4',count:5,gradingMode:'ai',model:'group-reading-test-model'});assert.equal(made.status,200,JSON.stringify(made.json));const id=made.json.id,qs=full(id);
  await call('/exams/'+id+'/answers',{answers:Object.fromEntries(qs.map((q,index)=>[q.id,index===0?'B':'A']))},'PUT');
  const done=await call('/exams/'+id+'/submit',{});assert.equal(done.status,200);assert.equal(done.json.status,'completed');assert.equal(done.json.score,40);assert.equal(requests.length,6);
  for(const [index,request] of requests.slice(1).entries()){const input=request.payload;assert.equal(input.question!.passage,qs[index].passage);assert.equal(input.question!.prompt,qs[index].prompt);assert.deepEqual(input.question!.options,qs[index].options);assert.equal((input.selectedOption as any).text,qs[index].options!.find(option=>option.id===(index===0?'B':'A'))!.text);assert.equal(request.model,'group-reading-test-model');}
});

test('a pending grouped generation keeps knowledge changes and destructive restore locked until its one model call finishes',async t=>{
  let release!:()=>void,began!:()=>void;const started=new Promise<void>(done=>{began=done;}),held=new Promise<void>(done=>{release=done;});
  const {create,call,requests,service}=await setup(t,async(payload,_messages,serial)=>{began();await held;return JSON.stringify(generated(payload,serial));});
  const backup=(await call('/backup')).json,flight=create({count:8});await started;
  try{assert.equal(service.isBusy(),true);assert.equal((await call('/review/points',{text:'図書館',level:'N3'})).status,409);assert.equal((await call('/data/delete-preview',{scope:'all'})).status,409);assert.equal((await call('/restore',backup)).status,409);assert.equal(requests.length,1);}finally{release();}
  const done=await flight;assert.equal(done.status,200,JSON.stringify(done.json));assert.equal(service.isBusy(),false);assert.equal(requests.length,1);assert.equal((await call('/exams/'+done.json.id)).json.questions.length,8);
});
