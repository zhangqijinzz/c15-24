// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleScenario } from '../domain';
import { LocalEnergyRepository } from '../repository';
import { STORAGE_KEY } from '../services/storageService';
import type { EnergyDocument } from '../types';

const exampleDocument: EnergyDocument = { version: 1, scenarios: [exampleScenario], activeScenarioId: exampleScenario.id };

describe('LocalEnergyRepository cross-tab sync', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('notifies listeners when another tab writes via the storage event', () => {
    const repository = new LocalEnergyRepository();
    repository.load();
    const changes: Array<{ revision: number; document: EnergyDocument | null }> = [];
    repository.subscribe((change) => changes.push(change));

    const remote: EnergyDocument = {
      ...exampleDocument,
      scenarios: [{ ...exampleScenario, devices: exampleScenario.devices.map((device) => ({ ...device, watts: 222 })) }],
    };
    const other = new LocalEnergyRepository();
    other.load();
    other.save(remote, 0);

    // jsdom 不自动派发跨上下文 storage 事件，这里模拟浏览器行为
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: localStorage.getItem(STORAGE_KEY) }));

    expect(changes).toHaveLength(1);
    expect(changes[0].document?.scenarios[0].devices[0].watts).toBe(222);
    expect(changes[0].revision).toBe(1);
  });

  it('ignores storage events for unrelated keys', () => {
    const repository = new LocalEnergyRepository();
    const changes: unknown[] = [];
    repository.subscribe((change) => changes.push(change));
    window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key', newValue: '{}' }));
    expect(changes).toHaveLength(0);
  });

  it('reports a null document when another tab clears the storage', () => {
    const repository = new LocalEnergyRepository();
    const changes: Array<EnergyDocument | null> = [];
    repository.subscribe((change) => changes.push(change.document));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }));
    expect(changes).toEqual([null]);
  });
});
