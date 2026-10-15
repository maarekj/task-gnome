import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEnv, parseEnvAssignment, UsageError } from '../src/cli/ops.ts';
import { shq } from '../src/terminal.ts';
import { fmtDuration, parseDuration, validateCron } from '../src/util.ts';

describe('parseDuration', () => {
  const cases: [string, number][] = [['90', 90], ['90s', 90], ['30m', 1800], ['2h', 7200], ['1h30m', 5400], ['1h 30m', 5400], ['0', 0]];
  for (const [input, seconds] of cases) {
    it(`${input} -> ${seconds}s`, () => {
      assert.equal(parseDuration(input), seconds);
    });
  }
  for (const bad of ['', 'abc', '10x', '1h foo']) {
    it(`refuse « ${bad} »`, () => {
      assert.throws(() => parseDuration(bad));
    });
  }
});

it('fmtDuration', () => {
  assert.deepEqual([fmtDuration(5000), fmtDuration(65_000), fmtDuration(3_720_000)], ['5s', '1m05s', '1h02m']);
});

it('validateCron', () => {
  assert.doesNotThrow(() => {
    validateCron('0 9 * * 1-5');
  });
  assert.doesNotThrow(() => {
    validateCron('@daily');
  });
  assert.throws(() => {
    validateCron('nope');
  }, /Expression cron invalide/u);
});

describe('variables d\'environnement', () => {
  it('KEY=VAL, la valeur peut contenir =', () => {
    assert.deepEqual(parseEnvAssignment('A=1=2'), ['A', '1=2']);
  });
  it('refuse un nom invalide', () => {
    assert.throws(() => parseEnvAssignment('1A=x'), UsageError);
    assert.throws(() => parseEnvAssignment('noequal'), UsageError);
  });
  it('KEY= supprime la variable', () => {
    assert.deepEqual(applyEnv({ A: '1', B: '2' }, [['A', ''], ['C', '3']]), { B: '2', C: '3' });
  });
});

it('shq (citation shell)', () => {
  assert.equal(shq('/home/x/projet'), '/home/x/projet');
  assert.equal(shq("it's"), String.raw`'it'\''s'`);
  assert.equal(shq('a b'), "'a b'");
});
