import { runMigrations } from './migration-runner.js';

async function main() {
  const result = await runMigrations();
  console.log(
    `[db:migrate] applied ${result.applied.length} migration(s); discovered ${result.totalDiscovered}`
  );
}

main().catch((err) => {
  console.error('[db:migrate] failed:', err.message);
  process.exit(1);
});
