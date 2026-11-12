import {startServer} from './lib/server.mjs';
let started;
export default {id:'melete',server:async(_input,options)=>{
  if(!started){const port=Number(options?.port)||3497;started=(async()=>{for(let i=0;i<30;i++){try{return await startServer({port});}catch(e){if(e.code!=='EADDRINUSE')throw e;await new Promise(r=>setTimeout(r,1000));}}throw new Error('Melete port unavailable');})();started.catch(()=>console.error('[melete] Local service unavailable.'));}
  await started;
  return {};
}};
