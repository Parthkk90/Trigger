import { rollbackMigration } from './migration-runner.js';

async function main() {
  const result = await rollbackMigration();
  if (result.skipped) {
    console.log('[db:rollback] no applied migrations to rollback');
    return;
  }
  console.log(`[db:rollback] rolled back ${result.rolledBack}`);
}

main().catch((err) => {
  console.error('[db:rollback] failed:', err.message);
  process.exit(1);
});
