import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, LATE_MS } from '../src/schedule.ts';

const at = (iso: string): number => Date.parse(iso);
const task = (over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] => ({
  enabled: true,
  cron: '0 9 * * *',
  last_fire_at: '2026-10-15T05:00:00.000Z',
  created_at: '2026-10-01T00:00:00.000Z',
  catch_up: true,
  ...over,
});
// cron is evaluated in local time: build the expected 9:00 local
const nineLocal = new Date('2026-10-15T09:00:00');

describe('decide', () => {
  it('attend avant l\'échéance', () => {
    assert.deepEqual(decide(task(), nineLocal.getTime() - 1000), { action: 'wait' });
  });

  it('lance à l\'heure (planifié)', () => {
    assert.deepEqual(decide(task(), nineLocal.getTime() + 15_000), { action: 'run', trigger: 'schedule' });
  });

  it('rattrape une échéance manquée de plus de LATE_MS', () => {
    assert.deepEqual(decide(task(), nineLocal.getTime() + LATE_MS + 1000), { action: 'run', trigger: 'catchup' });
  });

  it('saute une échéance manquée si le rattrapage est désactivé', () => {
    assert.deepEqual(decide(task({ catch_up: false }), nineLocal.getTime() + LATE_MS + 1000), { action: 'skip' });
  });

  it('ne lance qu\'une fois plusieurs échéances manquées (PC éteint plusieurs jours)', () => {
    const d = decide(task({ last_fire_at: '2026-10-10T05:00:00.000Z' }), nineLocal.getTime() + 3600_000);
    assert.deepEqual(d, { action: 'run', trigger: 'catchup' });
  });

  it('n\'agit pas sur une tâche désactivée', () => {
    assert.deepEqual(decide(task({ enabled: false }), at('2027-01-01T00:00:00Z')), { action: 'wait' });
  });

  it('part de la date de création si la tâche n\'a jamais été lancée', () => {
    const t = task({ last_fire_at: null, created_at: new Date('2026-10-15T08:59:00').toISOString() });
    assert.deepEqual(decide(t, nineLocal.getTime() + 1000), { action: 'run', trigger: 'schedule' });
  });

  it('n\'agit pas sur une expression cron invalide', () => {
    assert.deepEqual(decide(task({ cron: 'nope' }), at('2027-01-01T00:00:00Z')), { action: 'wait' });
  });
});
