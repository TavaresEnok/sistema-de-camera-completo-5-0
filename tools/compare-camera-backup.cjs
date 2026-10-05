// pg_restore --data-only --table=Camera --file=- piped over stdin.
// Outputs ONLY changed field names, never camera addresses or secrets.
const fs=require('fs');
const {PrismaClient}=require('/app/apps/api/node_modules/@prisma/client');
const p=new PrismaClient();
function decode(s){return s.replace(/\\([0-7]{1,3}|.)/g,(_,c)=>/^[0-7]+$/.test(c)?String.fromCharCode(parseInt(c,8)):({t:'\t',n:'\n',r:'\r',b:'\b',f:'\f',v:'\v','\\':'\\'}[c]??c));}
(async()=>{
 const text=fs.readFileSync(0,'utf8'),m=/COPY public\."Camera" \((.*?)\) FROM stdin;\n([\s\S]*?)\n\\\./.exec(text);
 if(!m)throw Error('Camera COPY data missing');
 const cols=m[1].split(',').map(s=>s.trim().replace(/^"|"$/g,''));
 const before=m[2].split('\n').map(line=>Object.fromEntries(line.split('\t').map((x,i)=>[cols[i],x==='\\N'?null:decode(x)])));
 const after=await p.camera.findMany();const byId=new Map(after.map(x=>[x.id,x]));const fields={};
 for(const old of before){const now=byId.get(old.id);if(!now)throw Error('Camera missing');
  for(const [k,a] of Object.entries(old)){const b=now[k];let equal;
   if(a===null||b===null)equal=a===b;
   else if(b instanceof Date)equal=new Date(a).getTime()===b.getTime();
   else if(typeof b==='boolean')equal=(a==='t')===b;
   else if(Array.isArray(b)&&a.startsWith('[')){try{equal=JSON.stringify(JSON.parse(a))===JSON.stringify(b)}catch{equal=false}}
   else if(Array.isArray(b))equal=a==='{'+b.join(',')+'}';
   else if(typeof b==='object'){try{equal=JSON.stringify(JSON.parse(a))===JSON.stringify(b)}catch{equal=false}}
   else equal=a===String(b);
   if(!equal)fields[k]=(fields[k]||0)+1;
  }
 }
 console.log(JSON.stringify({before:before.length,after:after.length,changedFieldCounts:fields}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());
