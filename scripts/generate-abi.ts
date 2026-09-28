import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { renderContractAbi } from './contract-abi.js';

const contracts = process.env.SMART_CONTRACT_DIR;
if (!contracts) throw new Error('SMART_CONTRACT_DIR is required: a checkout of the commit in contracts/source.json, built with forge build');

const { commit } = JSON.parse(await readFile('contracts/source.json', 'utf8')) as { commit: string };
const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: contracts });
if (stdout.trim() !== commit) throw new Error(`SMART_CONTRACT_DIR is at ${stdout.trim()}, contracts/source.json pins ${commit}`);

await writeFile('src/contract-abi.ts', await renderContractAbi(contracts, commit));
console.log('src/contract-abi.ts written');
