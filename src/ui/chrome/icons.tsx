// the app's icon kit: Lucide (lucide-preact), 16px with a 1.5px stroke everywhere.
//
// - dom: import the icon components from here (one place to swap the kit). size and stroke come
//   from <IconProvider> at the app root, so call sites just write <Play />. pass `size` for the
//   few larger ones.
// - canvas (timeline rows, viewport): lucidePath(Icon) turns an icon's svg nodes into one
//   Path2D in the 24-unit icon box, cached; strokeIcon() draws it at any size with a pixel stroke.

import type { ComponentChildren } from 'preact';
import {
  LucideProvider, type LucideIcon, AudioLines as _Audio, Circle as _Circle, Clapperboard as _Clap, Frame as _Frame, Image as _Image,
  Spline as _Spline, Square as _Square, Type as _Type,
} from 'lucide-preact';
import type { LayerType } from '../../core/model';

export {
  ALargeSmall, Activity, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter,
  ArrowRightLeft, ArrowUp, ArrowUpRight, AudioLines, Bell, Clock, Bookmark, Brackets, ChevronsLeft, ChevronsRight, Maximize2, SkipForward, ZoomIn, ZoomOut, Blend, Bot, Box, Check, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, Circle, CircleCheck, CircleUser, CircleX, Clapperboard, Code, Component, Copy, Cpu, Diamond,
  Download, Upload, Palette, Ellipsis, ExternalLink, Eye, EyeOff, File, FileText, Film, Folder, Frame, Gauge, Hand, Hash, Hexagon,
  House, Image, Info, Keyboard, Plug, Layers, Link, Link2, LoaderCircle, Lock, LockOpen, Magnet, MessageSquare, Minus, Monitor,
  Moon, MousePointer2, MousePointerClick, ArrowDown, PanelLeft, PanelLeftClose, PanelLeftOpen, Pause, PenTool, Pentagon, Play, Plus, Redo2, RefreshCw, Repeat,
  RotateCcw, RotateCw, Rows3, Search, Settings, SkipBack, SlidersHorizontal, Sparkle, Sparkles, Spline, Square, SquareTerminal, Star,
  SquarePen, SquareRoundCorner, StepBack, StepForward, Sun, SwatchBook, Terminal, Type, Undo2, Unlink, User, Users, Variable, Workflow, X, Zap,
} from 'lucide-preact';
export type { LucideIcon };

/** icon defaults for the whole tree: 16px, 1.5px stroke (absolute: stays 1.5px at any size) */
export function IconProvider(props: { children: ComponentChildren }) {
  return <LucideProvider size={16} strokeWidth={1.5} absoluteStrokeWidth>{props.children}</LucideProvider>;
}

/** layer type -> icon (timeline rows, layer tree, mentions) */
export const LAYER_ICON: Record<LayerType, LucideIcon> = {
  rect: _Square, ellipse: _Circle, group: _Frame, text: _Type, image: _Image, path: _Spline, precomp: _Clap, audio: _Audio,
} as Record<LayerType, LucideIcon>;

// ---------------- canvas ----------------
type Node = [string, Record<string, string>];
const pathCache = new Map<LucideIcon, Path2D>();

/** the icon's svg node list (lucide-preact keeps it on the vnode the component returns) */
function iconNodes(Icon: LucideIcon): Node[] {
  try { return ((Icon as any)({}) as any)?.props?.icon?.node ?? []; } catch { return []; }
}

/** one Path2D (24×24 icon space) for a Lucide icon; cached */
export function lucidePath(Icon: LucideIcon): Path2D {
  let p = pathCache.get(Icon);
  if (p) return p;
  p = new Path2D();
  for (const [tag, a] of iconNodes(Icon)) {
    const n = (k: string) => +(a[k] ?? 0);
    switch (tag) {
      case 'path': p.addPath(new Path2D(a.d)); break;
      case 'circle': p.moveTo(n('cx') + n('r'), n('cy')); p.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2); break;
      case 'ellipse': p.moveTo(n('cx') + n('rx'), n('cy')); p.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2); break;
      case 'rect': {
        const sub = new Path2D();
        if (a.rx) sub.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx')); else sub.rect(n('x'), n('y'), n('width'), n('height'));
        p.addPath(sub);
        break;
      }
      case 'line': p.moveTo(n('x1'), n('y1')); p.lineTo(n('x2'), n('y2')); break;
      case 'polyline': case 'polygon': {
        const pts = (a.points ?? '').trim().split(/[\s,]+/).map(Number);
        for (let i = 0; i + 1 < pts.length; i += 2) i ? p.lineTo(pts[i], pts[i + 1]) : p.moveTo(pts[i], pts[i + 1]);
        if (tag === 'polygon') p.closePath();
        break;
      }
    }
  }
  pathCache.set(Icon, p);
  return p;
}

/** stroke a Lucide icon centered at (x, y), `size` css px, `stroke` px wide, in the current strokeStyle */
export function strokeIcon(g: CanvasRenderingContext2D, Icon: LucideIcon, x: number, y: number, size = 14, stroke = 1.25) {
  const k = size / 24;
  g.save();
  g.translate(x - size / 2, y - size / 2);
  g.scale(k, k);
  g.lineWidth = stroke / k;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke(lucidePath(Icon));
  g.restore();
}
