import { readFile } from 'node:fs/promises';
import { databasePool, errorCode, secret } from '../../../packages/database/src/connection.js';
import { Auth } from '../../../packages/auth/src/index.js';
import { migrate, requireSchema } from '../../../packages/database/src/migrations.js';
import { Repository, validateInput, type MonitorInput } from '../../../packages/database/src/repository.js';

const [command, argument] = process.argv.slice(2);
const commands = ['migrate', 'admin', 'add', 'list', 'inspect', 'pause', 'resume', 'check'];
if (!command || !commands.includes(command) || (['admin', 'add', 'inspect', 'pause', 'resume', 'check'].includes(command) && !argument)) {
  console.error('Usage: pnpm db migrate|list|admin <email>|add <file.json>|inspect <id>|pause <id>|resume <id>|check <id>');
  process.exitCode = 2;
} else {
  let pool: ReturnType<typeof databasePool> | undefined;
  try {
    let input: MonitorInput | undefined;
    if (command === 'add') {
      input = JSON.parse(await readFile(argument!, 'utf8')) as MonitorInput;
      validateInput(input);
    }
    pool = databasePool();
    if (command === 'migrate') { await migrate(pool); console.log('Database migrations applied.'); }
    else {
      await requireSchema(pool);
      const repository = new Repository(pool);
      if (command === 'admin') {
        const password = secret('ADMIN_PASSWORD');
        if (!password) throw new Error('ADMIN_PASSWORD or ADMIN_PASSWORD_FILE is required');
        await new Auth(pool).setAdmin(argument!, password);
        console.log('Admin account saved; existing sessions revoked.');
      }
      if (command === 'add') console.log(JSON.stringify({ id: await repository.createMonitor(input!) }));
      if (command === 'list') console.log(JSON.stringify(await repository.list(), null, 2));
      if (command === 'inspect') console.log(JSON.stringify(await repository.inspect(argument!), null, 2));
      if (command === 'pause' || command === 'resume') await repository.setEnabled(argument!, command === 'resume');
      if (command === 'check') await repository.checkNow(argument!);
    }
  } catch (error) {
    // Connector errors may include SQL and credentials. Only print their code.
    console.error(error && typeof error === 'object' && 'sql' in error ? errorCode(error) : error instanceof Error ? error.message : 'Command failed');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
