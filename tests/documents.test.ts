// window tabs + agent runs: a run belongs to its document. while its tab is in the background the
// run edits that document's own store (docStore), and switching back brings those edits, with
// their undo history, into the editor.
import { describe, it, expect } from 'vitest';
import { editor } from '../src/app/editor';
import { setupDocuments, newDocument, switchTo, documents, activeDoc, docStore, isDocDirty, closeDoc, setDocBusy, isDocBusy, openProject } from '../src/app/documents';
import { addLayer } from '../src/core/commands';
import { createProject } from '../src/core/model';

(globalThis as any).navigator ??= { webdriver: true };
setupDocuments();

describe('documents: runs in background tabs', () => {
  it('edits through docStore land in the background document, never in the visible one', () => {
    newDocument({ name: 'A' });
    const a = activeDoc()!;
    expect(docStore(a)).toBe(editor.store);
    const startA = editor.store.topEntryId;
    newDocument({ name: 'B' });
    const b = activeDoc()!;
    expect(b).not.toBe(a);
    const bgA = docStore(a)!;
    expect(bgA).not.toBe(editor.store);
    expect(docStore(a)).toBe(bgA); // one store per background document
    addLayer(bgA, 'rect', { name: 'from the agent' });
    addLayer(bgA, 'ellipse', { name: 'second' });
    // the visible document (B) is untouched
    expect(editor.store.project.name).toBe('B');
    expect(editor.store.comp.root.length).toBe(0);
    expect(isDocDirty(a)).toBe(true);
    // back to A: the run's edits are there, with their undo steps (review cards stay valid)
    switchTo(a.id);
    expect(editor.store.project.name).toBe('A');
    expect(editor.store.comp.root.map(id => editor.store.layer(id)!.name)).toEqual(['from the agent', 'second']);
    expect(editor.store.historyLength).toBe(2);
    expect(docStore(a)).toBe(editor.store);
    expect(editor.store.undoToEntry(startA)).toBe(2);
    expect(editor.store.comp.root.length).toBe(0);
    switchTo(b.id);
    expect(docStore(a)).not.toBe(editor.store);
  });

  it('a busy tab is not reused by an opened file; a closed tab has no store', () => {
    newDocument({ name: 'C' });
    const c = activeDoc()!;
    setDocBusy(c.id, true);
    expect(isDocBusy(c)).toBe(true);
    openProject(createProject('D'));
    expect(activeDoc()).not.toBe(c);
    expect(documents()).toContain(c);
    setDocBusy(c.id, false);
    closeDoc(c.id, { force: true });
    expect(docStore(c)).toBeNull();
  });
});
