#!/usr/bin/env ts-node
/**
 * Local devnet lifecycle CLI.
 *
 * Usage:
 *   devnet.ts start <env>
 *   devnet.ts stop <env>
 *   devnet.ts reset <env>
 *   devnet.ts status <env>
 */
import * as path from 'path';
import { DevnetManager } from '../runtime/devnet';
import { loadDefaultEnvFile } from '../config/env-file';

function main(): void {
  loadDefaultEnvFile();
  const [cmd, env] = process.argv.slice(2);
  if (!cmd || !env) {
    console.error('Usage: devnet.ts <start|stop|reset|status> <environment>');
    process.exit(2);
  }
  const manager = new DevnetManager({
    configDir: path.resolve(process.cwd(), 'config'),
  });

  (async () => {
    switch (cmd) {
      case 'start': {
        const a = await manager.start(env);
        console.log(`✅ devnet '${env}' running at ${a.url}`);
        break;
      }
      case 'stop': {
        const stopped = await manager.stop(env);
        console.log(
          stopped
            ? `✅ devnet '${env}' stopped (state persisted under .devnet/anvil/${env})`
            : `devnet '${env}' was not running`,
        );
        break;
      }
      case 'reset': {
        await manager.reset(env);
        console.log(`✅ devnet '${env}' reset to clean state`);
        break;
      }
      case 'status': {
        const s = await manager.status(env);
        console.log(`devnet '${env}': ${s.running ? 'RUNNING' : 'stopped'} at ${s.url}`);
        console.log(`  state: ${s.stateFile}`);
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(2);
    }
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

main();
