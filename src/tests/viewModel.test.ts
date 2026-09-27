import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario } from '../domain';
import type { EnergyDocument } from '../types';
import { EnergyLensViewModel } from '../viewModel';
import type { SaveOutcome } from '../repository';

function makeRepository() {
  const data: EnergyDocument = { version: 1, scenarios: [structuredClone(exampleScenario)], activeScenarioId: exampleScenario.id };
  const externalListeners = new Set<(document: EnergyDocument) => void>();
  const apply = (next: EnergyDocument): SaveOutcome => {
    data.scenarios = next.scenarios;
    data.activeScenarioId = next.activeScenarioId;
    return { status: 'saved' };
  };
  return {
    data,
    load: () => data,
    save: vi.fn(apply),
    overwrite: vi.fn(apply),
    onExternalChange: (listener: (document: EnergyDocument) => void) => {
      externalListeners.add(listener);
      return () => { externalListeners.delete(listener); };
    },
    emitExternal(document: EnergyDocument) {
      externalListeners.forEach((listener) => listener(document));
    },
  };
}

function remoteDocument(name: string, airconHours: number): EnergyDocument {
  const scenario = structuredClone(exampleScenario);
  scenario.name = name;
  scenario.devices[0].dailyHours = airconHours;
  return { version: 1, scenarios: [scenario], activeScenarioId: scenario.id };
}

describe('EnergyLensViewModel', () => {
  let repository: ReturnType<typeof makeRepository>;
  let vm: EnergyLensViewModel;
  beforeEach(() => { repository = makeRepository(); vm = new EnergyLensViewModel(repository); vm.initialize(); });

  it('initializes, persists edits, and recalculates results', () => {
    expect(vm.getState().status).toBe('ready');
    const before = vm.activeSummary?.total.monthlyKwh;
    vm.updateDevice('device-aircon', { dailyHours: 2 });
    expect(vm.activeSummary?.total.monthlyKwh).toBeLessThan(before ?? Infinity);
    expect(repository.save).toHaveBeenCalled();
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
    const recovered = new EnergyLensViewModel(repository);
    recovered.initialize();
    expect(recovered.getState().document?.scenarios).toHaveLength(2);
  });

  it('surfaces persistence failure as a recoverable error', () => {
    repository.save.mockImplementation(() => { throw new Error('quota'); });
    vm.addDevice();
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toContain('保存失败');
  });
});

describe('multi-tab conflict handling', () => {
  let repository: ReturnType<typeof makeRepository>;
  let vm: EnergyLensViewModel;
  beforeEach(() => { repository = makeRepository(); vm = new EnergyLensViewModel(repository); vm.initialize(); });

  it('keeps local edits and asks the user when another tab has saved newer data', () => {
    const remote = remoteDocument('别处的方案', 9);
    repository.save.mockReturnValueOnce({ status: 'conflict', current: remote });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    const state = vm.getState();
    expect(state.conflict?.remote).toBe(remote);
    expect(state.document?.scenarios[0].devices[0].dailyHours).toBe(3);
    expect(repository.data.scenarios[0].devices[0].dailyHours).toBe(6);
  });

  it('resolveConflict local forces the local document through overwrite', () => {
    repository.save.mockReturnValueOnce({ status: 'conflict', current: remoteDocument('别处的方案', 9) });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    vm.resolveConflict('local');
    expect(repository.overwrite).toHaveBeenCalledTimes(1);
    expect(vm.getState().conflict).toBeNull();
    expect(vm.getState().document?.scenarios[0].devices[0].dailyHours).toBe(3);
    expect(repository.data.scenarios[0].devices[0].dailyHours).toBe(3);
  });

  it('resolveConflict remote adopts the other tab document and drops local edits', () => {
    const remote = remoteDocument('别处的方案', 9);
    repository.save.mockReturnValueOnce({ status: 'conflict', current: remote });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    vm.resolveConflict('remote');
    expect(vm.getState().document).toBe(remote);
    expect(vm.getState().conflict).toBeNull();
    expect(vm.activeScenario?.devices[0].dailyHours).toBe(9);
  });

  it('follows external writes while the page has no unsaved changes', () => {
    const remote = remoteDocument('别处的方案', 9);
    repository.emitExternal(remote);
    expect(vm.getState().document).toBe(remote);
    expect(vm.getState().conflict).toBeNull();
    expect(vm.getState().notice?.kind).toBe('info');
  });

  it('turns an external write into a conflict when the page has unsaved changes', () => {
    repository.save.mockImplementationOnce(() => { throw new Error('quota'); });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    const remote = remoteDocument('别处的方案', 9);
    repository.emitExternal(remote);
    expect(vm.getState().conflict?.remote).toBe(remote);
    expect(vm.getState().document?.scenarios[0].devices[0].dailyHours).toBe(3);
  });

  it('keeps editing in memory without touching storage while a conflict is pending', () => {
    repository.save.mockReturnValueOnce({ status: 'conflict', current: remoteDocument('别处的方案', 9) });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    repository.save.mockClear();
    vm.updateDevice('device-aircon', { dailyHours: 5 });
    expect(repository.save).not.toHaveBeenCalled();
    expect(vm.getState().document?.scenarios[0].devices[0].dailyHours).toBe(5);
    expect(vm.getState().conflict).not.toBeNull();
  });

  it('refreshes the remote version if the other tab writes again during a conflict', () => {
    repository.save.mockReturnValueOnce({ status: 'conflict', current: remoteDocument('第一版', 8) });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    const newer = remoteDocument('第二版', 10);
    repository.emitExternal(newer);
    expect(vm.getState().conflict?.remote).toBe(newer);
    expect(vm.getState().document?.scenarios[0].devices[0].dailyHours).toBe(3);
  });

  it('stops listening to external writes after dispose', () => {
    vm.dispose();
    repository.emitExternal(remoteDocument('别处的方案', 9));
    expect(vm.getState().document?.scenarios[0].name).toBe(exampleScenario.name);
  });
});
