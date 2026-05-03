const { initStore } = require('./store');
const { runOnce } = require('./workflow');

initStore();
const arg = process.argv[2] || 'dry-run';
const mode = arg === 'publish' || arg === 'publish-once' ? 'publish' : 'dry-run';
runOnce(mode, { trigger: 'cli' }).then(row => {
  process.stdout.write(JSON.stringify(row, null, 2) + '\n');
  process.exit(row.status === 'error' ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
