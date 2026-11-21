import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
const current = fs.readFileSync('native/js/wa-shim.js', 'utf8');
const baseline = execFileSync('git', ['show', 'c3f7c3e:native/js/wa-shim.js'], { encoding: 'utf8' });
function replay(source) {
  let time = 0;
  const events = [];
  const context = vm.createContext({ __wa: { sampleRate: 48000, time: () => time } });
  vm.runInContext(source, context);
  const later = (name, delay, callback = () => {}) => context.setTimeout(() => { events.push([name, time]); callback(); }, delay);
  const cancelled = later('cancelled', 10);
  context.clearTimeout(cancelled);
  later('first', 10, () => later('nested', 0));
  const alreadyDue = later('due-cancelled-during-callback', 10);
  later('canceller', 5, () => context.clearTimeout(alreadyDue));
  const interval = context.setInterval(() => events.push(['interval', time]), 7);
  let debounce;
  for (let i = 0; i < 10000; ++i) {
    context.clearTimeout(debounce);
    debounce = later('debounced', 300);
  }
  for (time of [0, .005, .01, .011, .014, .020, .300, .310]) {
    context.__runTimers();
    if (time === .020) context.clearInterval(interval);
  }
  // Preserve the existing due-list boundary, including cancellation of a timer
  // already captured as due, clearing oneself, and scheduling new callbacks.
  let second;
  later('due-first', 0, () => context.clearTimeout(second));
  second = later('due-second', 0);
  context.__runTimers();
  return events;
}
const result = replay(current);
assert.deepEqual(result, replay(baseline));
assert.equal(result.filter(e => e[0] === 'debounced').length, 1);
assert.equal(result.filter(e => e[0] === 'cancelled').length, 0);
console.log('PASS: timer cancellation parity, 10000 knob debounce events, due order, nested callbacks and intervals');

function cancellationFilters(source) {
  const context = vm.createContext({ __wa: { sampleRate: 48000, time: () => 0 } });
  vm.runInContext(source, context);
  return vm.runInContext(`
    let filters = 0;
    const originalFilter = Array.prototype.filter;
    Array.prototype.filter = function(...args) {
      filters++;
      return originalFilter.apply(this, args);
    };
    let previous;
    for (let i = 0; i < 10000; i++) {
      clearTimeout(previous);
      previous = setTimeout(() => {}, 300);
    }
    filters;
  `, context);
}
assert.equal(cancellationFilters(baseline), 10000);
assert.equal(cancellationFilters(current), 0);
console.log('PASS: cancellation creates 0 replacement filter arrays vs 10000 in baseline (timer objects still allocate)');
