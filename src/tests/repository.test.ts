// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { exampleScenario } from '../domain';
import { LocalEnergyRepository } from '../repository';
import { readEnvelope, writeEnvelope } from '../services/storageService';
import type { EnergyDocument } from '../types';

const STORAGE_KEY = 'energy-lens.document.v1';

function makeDocument(name: string): EnergyDocument {
  const scenario = { ...structuredClone(exampleScenario), name };
  return { version: 1, scenarios: [scenario], activeScenarioId: scenario.id };
}

describe('LocalEnergyRepository multi-tab safety', () => {
  beforeEach(() => localStorage.clear());

  it('saves cleanly while no one else writes', () => {
    const repo = new LocalEnergyRepository();
    repo.load();
    expect(repo.save(makeDocument('a')).status).toBe('saved');
    expect(repo.save(makeDocument('b')).status).toBe('saved');
    expect(readEnvelope()?.document.scenarios[0].name).toBe('b');
  });

  it('reports a conflict instead of overwriting when another tab wrote after our load', () => {
    const repo = new LocalEnergyRepository();
    repo.load();
    writeEnvelope(makeDocument('other-tab'), 0);
    const outcome = repo.save(makeDocument('mine'));
    expect(outcome.status).toBe('conflict');
    expect(readEnvelope()?.document.scenarios[0].name).toBe('other-tab');
  });

  it('overwrite forces the local document after a conflict', () => {
    const repo = new LocalEnergyRepository();
    repo.load();
    writeEnvelope(makeDocument('other-tab'), 0);
    expect(repo.save(makeDocument('mine')).status).toBe('conflict');
    expect(repo.overwrite(makeDocument('mine')).status).toBe('saved');
    expect(readEnvelope()?.document.scenarios[0].name).toBe('mine');
  });

  it('syncs its revision from external writes so the next save does not conflict', () => {
    const repo = new LocalEnergyRepository();
    repo.load();
    const seen: EnergyDocument[] = [];
    const unsubscribe = repo.onExternalChange((document) => seen.push(document));
    writeEnvelope(makeDocument('other-tab'), 0);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    expect(seen[0]?.scenarios[0].name).toBe('other-tab');
    expect(repo.save(makeDocument('mine')).status).toBe('saved');
    unsubscribe();
  });
});
