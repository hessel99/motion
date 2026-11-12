import { useEffect, useReducer } from 'preact/hooks';
import { editor } from '../app/editor';

/** re-render when any of the store/editor channels fire (coalesced to one render per frame) */
export function useChannels(storeChannels: string[], editorChannels: string[] = []) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let scheduled = false;
    const fn = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; force(0); });
    };
    const offs = [
      ...storeChannels.map(c => editor.store.on(c, fn)),
      ...editorChannels.map(c => editor.on(c, fn)),
    ];
    fn(); // catch events that fired before we subscribed
    return () => offs.forEach(o => o());
  }, []);
}
