#!/usr/bin/env node
// The knowledge base, by hand — see bridge/knowledgeAdmin.mjs for what each command does
// and why the ones that confirm knowledge only run in an interactive terminal.
//
//   node scripts/kb.mjs help        (or: npm run kb -- help)

import { createInterface } from 'node:readline/promises';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { openKnowledge } from '../bridge/knowledge.mjs';
import { runKb } from '../bridge/knowledgeAdmin.mjs';

// A person is at a terminal only if both ends are one. A pipe on either side is not a person.
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;

let kb;
try {
  kb = openKnowledge();
} catch (err) {
  console.error(`База знаний не открылась: ${err.message}`);
  process.exit(1);
}

const code = await runKb(process.argv.slice(2), {
  kb,
  io: {
    tty,
    ask: (q) => (rl ? rl.question(q) : Promise.resolve('')),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    readFile: (path) => ({ size: statSync(path).size, text: readFileSync(path, 'utf8') }),
    // 0600: an export is personal data.
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  },
});
rl?.close();
kb.close();
process.exit(code);
