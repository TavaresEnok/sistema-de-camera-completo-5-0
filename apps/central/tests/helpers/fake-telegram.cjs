// Test-only child-process preload. Not copied into any production image.
const original=global.fetch;
global.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://api.telegram.org/'))return original(url,options);
  console.log('[telegram-fixture] attempt');
  if(process.env.TEST_TELEGRAM_DELAY_MS)await new Promise(r=>setTimeout(r,Number(process.env.TEST_TELEGRAM_DELAY_MS)));
  return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200,headers:{'content-type':'application/json'}});
};
