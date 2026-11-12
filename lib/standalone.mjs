import {startServer} from './server.mjs';
const app=await startServer({port:Number(process.env.MELETE_PORT)||3497});
console.log('Melete local service ready on port '+app.port);
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>app.close().then(()=>process.exit(0)));
