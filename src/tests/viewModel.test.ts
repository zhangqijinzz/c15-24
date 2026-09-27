import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario } from '../domain';
import type { EnergyDocument } from '../types';
import { EnergyLensViewModel } from '../viewModel';
import { DocumentConflictError, type EnergyRepository, type RemoteChange } from '../repository';

interface FakeRepository {
  data: EnergyDocument | null;
  revision: number;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  forceSave: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  emit: (change: RemoteChange) => void;
}

function makeRepository(): FakeRepository {
  let data: EnergyDocument | null = { version: 1, scenarios: [structuredClone(exampleScenario)], activeScenarioId: exampleScenario.id };
  const listeners = new Set<(change: RemoteChange) => void>();
  let revision = 0;
  return {
    get data() { return data; },
    get revision() { return revision; },
    set revision(value: number) { revision = value; },
    load: vi.fn(() => ({ document: data, revision })),
    save: vi.fn((next: EnergyDocument, baseRevision: number) => {
      if (baseRevision !== revision) {
        throw new DocumentConflictError(data ? { revision, document: structuredClone(data), raw: '' } : null);
      }
      data = structuredClone(next);
      revision += 1;
      return { revision };
    }),
    forceSave: vi.fn((next: EnergyDocument, remoteRevision: number) => {
      data = structuredClone(next);
      revision = remoteRevision + 1;
      return { revision };
    }),
    subscribe: vi.fn((listener: (change: RemoteChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    emit: (change: RemoteChange) => {
      data = change.document ? structuredClone(change.document) : null;
      revision = change.revision;
      listeners.forEach((listener) => listener(change));
    },
  };
}

describe('EnergyLensViewModel', () => {
  let repository: FakeRepository;
  let vm: EnergyLensViewModel;
  beforeEach(() => { repository = makeRepository(); vm = new EnergyLensViewModel(repository as unknown as EnergyRepository); vm.initialize(); });

  it('initializes, persists edits, and recalculates results', () => {
    expect(vm.getState().status).toBe('ready');
    const before = vm.activeSummary?.total.monthlyKwh;
    vm.updateDevice('device-aircon', { dailyHours: 2 });
    expect(vm.activeSummary?.total.monthlyKwh).toBeLessThan(before ?? Infinity);
    expect(repository.save).toHaveBeenCalled();
    expect(vm.getState().status).not.toBe('conflict');
  });

  it('keeps invalid values out of the document and exposes an error notice', () => {
    vm.updateDevice('device-aircon', { watts: -50 });
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toBe('功率不能为负数');
    expect(vm.activeScenario?.devices[0].watts).toBe(1200);
  });

  it('duplicates a scenario and can recover a saved document', () => {
    vm.duplicateActive();
    expect(vm.getState().document?.scenarios).toHaveLength(2);
    const recovered = new EnergyLensViewModel(repository as unknown as EnergyRepository);
    recovered.initialize();
    expect(recovered.getState().document?.scenarios).toHaveLength(2);
  });

  it('surfaces persistence failure as a recoverable error', () => {
    repository.save.mockImplementation(() => { throw new Error('quota'); });
    vm.addDevice();
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toContain('保存失败');
  });

  it('silently follows another tab when this page has no pending edits', () => {
    const remote: EnergyDocument = {
      version: 1,
      activeScenarioId: exampleScenario.id,
      scenarios: [{ ...structuredClone(exampleScenario), devices: exampleScenario.devices.map((device) => ({ ...device, watts: 500 })) }],
    };
    repository.emit({ revision: 3, document: remote });
    expect(vm.getState().status).toBe('ready');
    expect(vm.getState().revision).toBe(3);
    expect(vm.activeScenario?.devices[0].watts).toBe(500);
    expect(vm.getState().notice).toBeNull();
  });

  it('asks the user to choose when another tab commits first, and adopts the remote version on request', () => {
    repository.save.mockImplementationOnce(() => {
      throw new DocumentConflictError({ revision: 4, document: {
        version: 1,
        activeScenarioId: exampleScenario.id,
        scenarios: [{ ...structuredClone(exampleScenario), devices: exampleScenario.devices.map((device) => ({ ...device, watts: 77 })) }],
      }, raw: '' });
    });

    vm.updateDevice('device-aircon', { watts: 5000 });
    const state = vm.getState();
    expect(state.status).toBe('conflict');
    expect(state.conflict?.base.scenarios[0].devices[0].watts).toBe(5000);
    expect(state.conflict?.remoteRevision).toBe(4);

    vm.resolveConflict('remote');
    expect(vm.activeScenario?.devices[0].watts).toBe(77);
    expect(vm.getState().status).not.toBe('conflict');
    expect(repository.forceSave).not.toHaveBeenCalled();
  });

  it('keeps this page version and broadcasts it when the user chooses local', () => {
    repository.save.mockImplementationOnce(() => {
      throw new DocumentConflictError({ revision: 2, document: {
        version: 1,
        activeScenarioId: exampleScenario.id,
        scenarios: [structuredClone(exampleScenario)],
      }, raw: '' });
    });
    vm.updateDevice('device-aircon', { watts: 4242 });
    vm.resolveConflict('local');

    expect(repository.forceSave).toHaveBeenCalledTimes(1);
    expect(vm.activeScenario?.devices[0].watts).toBe(4242);
    expect(vm.getState().revision).toBe(3);
  });

  it('refuses edits while a conflict is pending', () => {
    repository.save.mockImplementationOnce(() => {
      throw new DocumentConflictError({ revision: 5, document: { version: 1, activeScenarioId: exampleScenario.id, scenarios: [structuredClone(exampleScenario)] }, raw: '' });
    });
    vm.updateDevice('device-aircon', { watts: 1 });
    expect(vm.getState().conflict).not.toBeNull();
    vm.updateDevice('device-fridge', { watts: 999});
    expect(vm.getState().conflict).not.toBeNull();
    expect(vm.activeScenario?.devices.find((device) => device.id === 'device-fridge')?.watts).toBe(150);
  });

  it('turns a quota failure plus a later remote write into a conflict instead of overwriting it', () => {
    repository.save.mockImplementationOnce(() => { throw new Error('quota'); });
    vm.addDevice();
    expect(vm.getState().status).toBe('error');

    repository.emit({ revision: 2, document: { version: 1, activeScenarioId: exampleScenario.id, scenarios: [structuredClone(exampleScenario)] } });
    expect(vm.getState().status).toBe('conflict');
  });
});
