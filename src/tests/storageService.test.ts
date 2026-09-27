// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { exampleScenario } from '../domain';
import { LocalEnergyRepository } from '../repository';
import { STORAGE_KEY, DocumentConflictError, commitStoredDocument, parseStoredRaw, readStoredDocument } from '../services/storageService';
import type { EnergyDocument } from '../types';

const exampleDocument: EnergyDocument = { version: 1, scenarios: [exampleScenario], activeScenarioId: exampleScenario.id };

function nextDocument(document: EnergyDocument, watts: number): EnergyDocument {
  return { ...document, scenarios: document.scenarios.map((scenario) => ({ ...scenario, devices: scenario.devices.map((device) => ({ ...device, watts })) })) };
}

describe('local persistence recovery', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to a valid example when saved JSON is damaged', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scenarios: [null], activeScenarioId: 'missing' }));
    const recovered = new LocalEnergyRepository().load();
    expect(recovered.document.activeScenarioId).toBe(exampleScenario.id);
    expect(recovered.document.scenarios[0].devices.length).toBeGreaterThan(0);
  });

  it('migrates the legacy bare-document format and keeps editing working', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exampleDocument));
    const legacy = readStoredDocument();
    expect(legacy?.revision).toBe(0);
    expect(legacy?.document.activeScenarioId).toBe(exampleScenario.id);

    const committed = commitStoredDocument(nextDocument(exampleDocument, 900), legacy!.raw, 0);
    expect(committed.entry.revision).toBe(1);
    expect(parseStoredRaw(localStorage.getItem(STORAGE_KEY))?.revision).toBe(1);
  });
});

describe('optimistic document storage', () => {
  beforeEach(() => localStorage.clear());

  it('commits on an empty store from revision 0 and bumps the revision', () => {
    const result = commitStoredDocument(exampleDocument, null, 0);
    expect(result.entry.revision).toBe(1);
    expect(readStoredDocument()?.document).toEqual(exampleDocument);
  });

  it('rejects the commit when another tab wrote first, exposing the remote version', () => {
    const first = commitStoredDocument(exampleDocument, null, 0);
    const remote = nextDocument(exampleDocument, 300);
    commitStoredDocument(remote, first.raw, 1); // 模拟另一个标签页先写入 revision 2

    try {
      commitStoredDocument(nextDocument(exampleDocument, 800), first.raw, 1);
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentConflictError);
      expect((error as DocumentConflictError).remote?.revision).toBe(2);
      expect((error as DocumentConflictError).remote?.document).toEqual(remote);
    }
    // 冲突提交不能触碰存储内容，杜绝内容错乱
    expect(readStoredDocument()?.document).toEqual(remote);
  });

  it('does not treat an identical raw payload as a conflict (single-tab fast path)', () => {
    const first = commitStoredDocument(exampleDocument, null, 0);
    const second = commitStoredDocument(nextDocument(exampleDocument, 400), first.raw, 1);
    expect(second.entry.revision).toBe(2);
  });

  it('returns null when storage holds damaged JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    expect(readStoredDocument()).toBeNull();
  });
});
