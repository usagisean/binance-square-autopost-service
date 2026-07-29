const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

if (!scripts.length) throw new Error('web_script_not_found');
for (const [index, match] of scripts.entries()) {
  new vm.Script(match[1], { filename: `${file}#script-${index + 1}` });
}
console.log(`web script syntax ok (${scripts.length})`);
