import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import YAML from 'yaml';
import { runAgentProcess } from '../../../dist/agent-runner.js';
import { AgentInputScanError, agentInputScanFailureExitCode } from '../../../dist/agent-input-scan.js';
import { writeExactReviewFailureDiagnostics } from '../../../dist/clawsweeper-review-failure-diagnostics.js';
import { TRUFFLEHOG_VERSION } from '../../../dist/review-tool-bootstrap.js';
import { inspectInputScanDiagnostic } from '../../../scripts/inspect-input-scan-diagnostic.mjs';

const output = resolve(process.argv[2] ?? '.artifacts/safe-refusal-diagnostics/behavior');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'diagnostic-behavior-'));
const oldPath = process.env.PATH;
try {
  const target = join(scratch, 'target'); const bin = join(scratch, 'bin');
  mkdirSync(target); mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const git = (...args) => execFileSync('git', args, { cwd: target, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic proof'); git('config', 'user.email', 'proof@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(target, 'example.txt'), 'Synthetic source for scanner attribution.\n');
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(target, 'example.txt'), 'Synthetic changed source for scanner attribution.\n');
  git('add', '.'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD');
  const calls = join(scratch, 'model-calls');
  const provider = join(bin, 'codex');
  writeFileSync(provider, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'called');\n`, { mode: 0o755 });
  // A controlled native-protocol scanner process, not a mocked runner or serializer.
  writeFileSync(join(bin, 'trufflehog'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (process.argv[2] === '--version') { console.log('trufflehog ${TRUFFLEHOG_VERSION}'); process.exit(0); }
for (const flag of ['--results=verified,unknown', '--fail', '--fail-on-scan-errors', '--no-update', '--json', '--no-color']) assert.ok(process.argv.includes(flag));
const dir = process.argv[3];
const name = fs.readdirSync(dir).find(n => /^[a-f0-9]{40}$/.test(n)); assert.ok(name);
console.log(JSON.stringify({ DetectorType: 3, DecoderName: 'PLAIN', Verified: false,
  Raw: 'SYNTHETIC_VALUE_CANARY', RawV2: 'SYNTHETIC_DECODED_CANARY',
  SourceMetadata: { Data: { Filesystem: { file: path.join(dir, name), line: 1 } } } }));
console.error(JSON.stringify({ level:'info-0', logger:'trufflehog', msg:'finished scanning', trufflehog_version:'${TRUFFLEHOG_VERSION}', chunks:1, bytes:100, verified_secrets:0, unverified_secrets:1 }));
process.exit(183);
`, { mode: 0o755 });
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
  let failure;
  try {
    runAgentProcess({ label:'synthetic-refusal', prompt:'Review synthetic source.', model:'unused', cwd:target,
      scanSource:{ kind:'committed', baseSha:base, headSha:head }, env:{ CODEX_BIN:provider }, timeoutMs:30000 });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof AgentInputScanError);
  assert.equal(agentInputScanFailureExitCode(failure), 79); assert.equal(failure.retryable, false);
  assert.equal(existsSync(calls), false);
  const identity = { repository:'openclaw/clawsweeper', itemKind:'pull_request', itemNumber:2057,
    sourceSha:head, runRepository:'openclaw/clawsweeper', runId:'123', runAttempt:'2' };
  const env = { GITHUB_REPOSITORY:identity.runRepository, GITHUB_RUN_ID:identity.runId, GITHUB_RUN_ATTEMPT:identity.runAttempt };
  const options = { artifactDir:join(scratch, 'after'), error:failure, prompt:'Review synthetic source.', model:'unused', classification:'agent_input_scan',
    repo:identity.repository, itemKind:identity.itemKind, itemNumber:identity.itemNumber, sourceSha:head, retryable:false, workflowExit:79, env };
  const manifestPath = join(writeExactReviewFailureDiagnostics(options), 'manifest.json');
  const result = inspectInputScanDiagnostic({ manifestPath, ...identity });
  assert.equal(result.diagnostic.failure.scan.kind, 'unclassified_finding');
  assert.equal(result.diagnostic.failure.scan.sourceCoordinates, 'not_proven');
  const args = ['--inspect', manifestPath, identity.repository, identity.itemKind, '2057', head, identity.runRepository, '123', '2'];
  const cli = spawnSync(process.execPath, ['scripts/inspect-input-scan-diagnostic.mjs', ...args], { encoding:'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), result.diagnostic);
  const summaryPath = join(scratch, 'summary.md');
  const step = YAML.parse(readFileSync('.github/workflows/sweep.yml', 'utf8')).jobs['event-review-apply'].steps.find(s => s.name === 'Link input-scan refusal diagnostics');
  const stepEnv = { ...process.env, ...env, GITHUB_STEP_SUMMARY:summaryPath, DIAGNOSTIC_REPO:identity.repository,
    DIAGNOSTIC_KIND:identity.itemKind, DIAGNOSTIC_NUMBER:'2057', DIAGNOSTIC_SHA:head,
    DIAGNOSTIC_ARTIFACT_URL:'https://github.com/openclaw/clawsweeper/actions/runs/123/artifacts/456' };
  mkdirSync(join(scratch, 'artifacts/event/failure-diagnostics'), { recursive:true });
  writeFileSync(join(scratch, 'artifacts/event/failure-diagnostics/manifest.json'), readFileSync(manifestPath));
  // Keep workflow relative paths intact, while pointing its script entry at this checkout.
  mkdirSync(join(scratch, 'scripts'));
  const inspectorPath = resolve('scripts/inspect-input-scan-diagnostic.mjs');
  writeFileSync(join(scratch, 'scripts/inspect-input-scan-diagnostic.mjs'),
    `process.argv[1] = ${JSON.stringify(inspectorPath)};\nawait import(${JSON.stringify(pathToFileURL(inspectorPath).href)});\n`);
  // Execute the literal workflow body. The PATH entry and import wrapper above
  // select this Node executable and checkout without interpolating shell source.
  const shell = step.run;
  const workflow = spawnSync('bash', ['-c', shell], { cwd:scratch, env:stepEnv, encoding:'utf8' });
  assert.equal(workflow.status, 0, workflow.stderr);
  const summary = readFileSync(summaryPath, 'utf8'); assert.match(summary, /artifacts\/456/);
  assert.doesNotMatch(summary, /literal_not_reviewed|scannerLine|detectorType/);
  const missing = spawnSync('bash', ['-c', shell], { cwd:scratch, env:{...stepEnv, DIAGNOSTIC_ARTIFACT_URL:''}, encoding:'utf8' });
  assert.equal(missing.status, 0); assert.match(readFileSync(summaryPath, 'utf8'), /diagnostics unavailable/);
  let baselineSource = execFileSync('git', ['show', '385ed215fa2cfd04e53ab11d6cf814b8a3226b85:src/clawsweeper-review-failure-diagnostics.ts'], { encoding:'utf8' });
  baselineSource = baselineSource.replaceAll(/from "\.\/([^"\n]+)"/g, (_, name) => `from ${JSON.stringify(pathToFileURL(resolve('dist', name)).href)}`);
  const baselinePath = join(scratch, 'baseline.mjs'); writeFileSync(baselinePath, stripTypeScriptTypes(baselineSource));
  const baseline = await import(pathToFileURL(baselinePath));
  const beforePath = join(baseline.writeExactReviewFailureDiagnostics({...options, artifactDir:join(scratch, 'before')}), 'manifest.json');
  assert.throws(() => inspectInputScanDiagnostic({ manifestPath:beforePath, ...identity }), /identity/);
  const before = 'Before (fresh upstream base): terminal findings / exit 79; manifest exists, no run/attempt provenance and no workflow discovery summary. Exact-run inspector rejects missing provenance.\n';
  const after = `After (synthetic run 123 attempt 2, not a live GitHub artifact):\n${cli.stdout}\n${summary}\nRefusal remains terminal (79), retryable=false, model calls=0.\n`;
  for (const text of [before, after]) assert.doesNotMatch(text, /SYNTHETIC_VALUE_CANARY|SYNTHETIC_DECODED_CANARY/);
  writeFileSync(join(output, 'operator-transcript.txt'), before + '\n' + after);
  writeFileSync(join(output, 'result.json'), JSON.stringify({ base:'385ed215fa2cfd04e53ab11d6cf814b8a3226b85',
    sourceHead:head, exit:79, retryable:false, modelCalls:0, baselineExactRunRejected:true,
    workflowPointer:true, missingArtifactReported:true, scanner:'controlled native-protocol process',
    limits:'No live scanner accuracy, hosted artifact access, queue service mutation, or model inference exercised.' }, null, 2)+'\n');
  console.log('PASS: terminal refusal -> existing manifest -> exact-run inspection -> pointer-only workflow summary; model calls=0.');
} finally { process.env.PATH = oldPath; rmSync(scratch, { recursive:true, force:true }); }
