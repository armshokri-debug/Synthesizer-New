/** Direct processor test. Runs the actual worklet DSP in a minimal JS audio-worklet host,
 * not a browser or a complete Studio WAV bounce. No audio device or network needed.
 * Use the project's TypeScript dev dependency (or SY1_TYPESCRIPT_PATH for local testing).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require(process.env.SY1_TYPESCRIPT_PATH || 'typescript');
const sampleRate = 48000;
const frames = 128 * 188;
const results = [];
for (const name of ['fm', 'strings', 'vector']) {
  const source = fs.readFileSync(new URL(`../src/engine/worklet/${name}-processor.ts`, import.meta.url), 'utf8');
  assert.equal(source.split('Math.max(1 / 127, Math.min(1, e.vel))').length, 2, `${name}: expected precisely one velocity-floor change`);
  // Published 7.4A behavior: the identical processor with its original 0.05 minimum.
  const oldSource = source.replace('Math.max(1 / 127, Math.min(1, e.vel))', 'Math.max(0.05, Math.min(1, e.vel))');
  function compile(code) {
    return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  }
  const compiled = compile(source), baseline = compile(oldSource);
  function render(code, velocity) {
    let Processor;
    const host = vm.createContext({ sampleRate, currentTime: 0, exports: {},
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage() {} }; },
      registerProcessor(_name, ctor) { Processor = ctor; }
    });
    vm.runInContext(code, host);
    const p = new Processor();
    p.port.onmessage({data: { t: 'on', id: 1, midi: 60, cents: 0, vel: velocity / 127, at: 0 }});
    const l = new Float32Array(frames), r = new Float32Array(frames);
    for (let offset = 0; offset < frames; offset += 128) {
      host.currentTime = offset / sampleRate;
      p.process([], [[l.subarray(offset, offset+128), r.subarray(offset,offset+128)]]);
    }
    let sum = 0, peak = 0;
    for (const channel of [l,r]) for (const sample of channel) {
      assert.ok(Number.isFinite(sample), `${name}: non-finite sample`);
      sum += sample * sample; peak = Math.max(peak, Math.abs(sample));
    }
    return { l, r, rms: Math.sqrt(sum / (2 * frames)), peak };
  }
  const old1 = render(baseline,1), old6 = render(baseline,6);
  assert.deepEqual(old1.l,old6.l,`${name}: prior lower velocities were clamped`);
  assert.deepEqual(old1.r,old6.r);
  const levels = [1,6,20,64,127];
  const out = levels.map(v => render(compiled,v));
  for (let i=1;i<out.length;i++) assert.ok(out[i].rms > out[i-1].rms,`${name}: RMS does not increase at ${levels[i]}`);
  for (let i=2;i<levels.length;i++) {
    const previous = render(baseline,levels[i]);
    assert.deepEqual(previous.l,out[i].l,`${name}: changed normal-velocity sound at ${levels[i]}`);
    assert.deepEqual(previous.r,out[i].r);
  }
  const db = v => Number((20*Math.log10(Math.max(1e-12,v))).toFixed(3));
  results.push({ processor:name, oldLowVelocityEqual:true, normalVelocityBitIdentical:[20,64,127], rmsDb: Object.fromEntries(levels.map((v,i)=>[v,db(out[i].rms)])), peakDb: Object.fromEntries(levels.map((v,i)=>[v,db(out[i].peak)])) });
}
console.log(JSON.stringify({ok:true, sampleRate, frames, note:60, test:'Direct processor render; not complete Studio/WAV or physical device',results},null,2));
