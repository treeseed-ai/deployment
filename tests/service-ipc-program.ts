import {ServiceWorkerClient} from '@treeseed-cordis/deployment';
class ObserverProgram{static async run():Promise<void>{try{const client=new ServiceWorkerClient({installationDirectory:process.argv[2]!}),status=await client.status();process.stdout.write(JSON.stringify({ready:status.ready,formatVersion:status.formatVersion,services:status.services.length})+'\n');}catch{process.stderr.write('Observer failed.\n');process.exitCode=1;}}}
await ObserverProgram.run();
