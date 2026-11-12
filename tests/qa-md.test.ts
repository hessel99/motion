// regressions from the motion-designer QA (docs/next-up.md, MD-xx)
import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store';
import { addLayer, setProp, toggleAnimated, toggleKeyAtTime } from '../src/core/commands';

describe('MD-13: property shortcuts never wipe an animation', () => {
  it('Alt+Shift+<prop> toggles one key at the playhead, keeps the others', () => {
    const s = new Store();
    const l = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100 });
    toggleAnimated(s, [l.id], 'position');
    s.setTime(1); setProp(s, l.id, 'position', [300, 0]);
    s.setTime(2); setProp(s, l.id, 'position', [600, 0]);
    const kf = () => s.layer(l.id)!.props.position!.kf ?? [];
    expect(kf().length).toBe(3);
    // on a key: only that key goes
    s.setTime(1); toggleKeyAtTime(s, [l.id], 'position');
    expect(kf().map(k => k.t)).toEqual([0, 2]);
    // between keys: a key with the current value is added
    s.setTime(0.5); toggleKeyAtTime(s, [l.id], 'position');
    expect(kf().map(k => k.t)).toEqual([0, 0.5, 2]);
    s.undo(); s.undo();
    expect(kf().length).toBe(3);
    // a static property: starts animating with one key
    toggleKeyAtTime(s, [l.id], 'opacity');
    expect(s.layer(l.id)!.props.opacity!.kf!.length).toBe(1);
  });
  it('the stopwatch (toggleAnimated) is one named, undoable step', () => {
    const s = new Store();
    const l = addLayer(s, 'rect');
    toggleAnimated(s, [l.id], 'rotation');
    s.setTime(1); setProp(s, l.id, 'rotation', [90]);
    toggleAnimated(s, [l.id], 'rotation');
    expect(s.layer(l.id)!.props.rotation!.kf).toBeUndefined();
    s.undo();
    expect(s.layer(l.id)!.props.rotation!.kf!.length).toBe(2);
  });
});
