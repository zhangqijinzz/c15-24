// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario } from '../domain';
import { LocalEnergyRepository } from '../repository';
import { forceWriteEnvelope, readEnvelope, subscribeToExternalWrites, writeEnvelope } from '../services/storageService';
import type { EnergyDocument } from '../types';

const STORAGE_KEY = 'energy-lens.document.v1';

function makeDocument(name: string): EnergyDocument {
  const scenario = { ...structuredClone(exampleScenario), name };
  return { version: 1, scenarios: [scenario], activeScenarioId: scenario.id };
}

describe('local persistence recovery', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to a valid example when saved JSON is damaged', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scenarios: [null], activeScenarioId: 'missing' }));
    const recovered = new LocalEnergyRepository().load();
    expect(recovered.activeScenarioId).toBe(exampleScenario.id);
    expect(recovered.scenarios[0].devices.length).toBeGreaterThan(0);
  });
});

describe('envelope revisioning', () => {
  beforeEach(() => localStorage.clear());

  it('wraps documents with increasing revisions', () => {
    expect(writeEnvelope(makeDocument('a'), 0)).toMatchObject({ status: 'saved', revision: 1 });
    expect(writeEnvelope(makeDocument('b'), 1)).toMatchObject({ status: 'saved', revision: 2 });
    expect(readEnvelope()?.document.scenarios[0].name).toBe('b');
  });

  it('reads legacy plain documents as revision 0', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeDocument('legacy')));
    const envelope = readEnvelope();
    expect(envelope?.revision).toBe(0);
    expect(envelope?.document.scenarios[0].name).toBe('legacy');
  });

  it('refuses to overwrite newer data and reports a conflict instead', () => {
    writeEnvelope(makeDocument('first'), 0);
    const stale = writeEnvelope(makeDocument('stale'), 0);
    expect(stale.status).toBe('conflict');
    expect(readEnvelope()?.document.scenarios[0].name).toBe('first');
  });

  it('detects a simultaneous write that lands between check and verify', () => {
    // 模拟另一标签页在同一瞬间写入：本页 setItem 之后立刻被别人的完整内容顶替
    const original = Storage.prototype.setItem;
    let sabotaged = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      original.call(this, key, value);
      if (!sabotaged && key === STORAGE_KEY) {
        sabotaged = true;
        original.call(this, key, JSON.stringify({ revision: 1, writeId: 'other-tab', document: makeDocument('other') }));
      }
    });
    const result = writeEnvelope(makeDocument('mine'), 0);
    expect(result.status).toBe('conflict');
    const stored = readEnvelope();
    expect(stored?.writeId).toBe('other-tab');
    expect(stored?.document.scenarios[0].name).toBe('other');
    vi.restoreAllMocks();
  });

  it('forceWriteEnvelope writes on top of whatever is stored', () => {
    writeEnvelope(makeDocument('first'), 0);
    expect(forceWriteEnvelope(makeDocument('forced')).status).toBe('saved');
    expect(readEnvelope()?.document.scenarios[0].name).toBe('forced');
  });

  it('notifies subscribers about writes from other tabs only', () => {
    writeEnvelope(makeDocument('stored'), 0);
    const seen: EnergyDocument[] = [];
    const unsubscribe = subscribeToExternalWrites((envelope) => seen.push(envelope.document));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }));
    expect(seen).toHaveLength(0);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    expect(seen).toHaveLength(1);
    expect(seen[0].scenarios[0].name).toBe('stored');
    unsubscribe();
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    expect(seen).toHaveLength(1);
  });
});
