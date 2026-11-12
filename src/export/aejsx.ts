// "send to after effects": an ExtendScript (.jsx) file that rebuilds the active composition in
// after effects (File > Scripts > Run Script File…).
//
// the mapping is the lottie exporter's (lottie *is* after effects' own data model): the script
// embeds that json and a small es3 interpreter that turns it into real ae layers:
//  - shape layers with rect / ellipse / path groups, fills and strokes
//  - nulls for groups (parents), box text, precomps (recursive), embedded images
//  - keyframes with temporal ease (lottie bezier handles -> ae speed/influence), hold, linear,
//    spatial tangents; expressions; springs arrive baked as linear keys
// es3 only: extendscript has no let/const/arrows/array helpers.

import type { Project } from '../core/model';
import { projectToLottie } from './lottie';

const RUNTIME = String.raw`
var fr = DATA.fr;
function n(x) { return typeof x === 'number' ? x : x[0]; }
function arr(x) { return (x instanceof Array) ? x : [x]; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function exprText(x) {
  var m = /^var \$bm_rt = ([^;]*);$/.exec(x);
  if (m) return m[1];
  return x.indexOf('$bm_rt') >= 0 ? x + '\n$bm_rt;' : x;
}

// lottie bezier ease (normalized handles) -> ae temporal ease of the segment a -> b
function easeCount(prop) {
  var t = prop.propertyValueType;
  if (t === PropertyValueType.TwoD) return 2;
  if (t === PropertyValueType.ThreeD) return 3;
  return 1;
}
function segSpeed(a, b, dt, dims, d) {
  if (dt <= 0) return 0;
  if (dims === 1 && a.length > 1) {
    var s = 0;
    for (var i = 0; i < a.length; i++) { var q = (b[i] || 0) - (a[i] || 0); s += q * q; }
    return Math.sqrt(s) / dt;
  }
  return ((b[d] || 0) - (a[d] || 0)) / dt;
}
function setProp(prop, lp, conv) {
  if (!prop || !lp) return;
  conv = conv || function (v) { return v; };
  var single = function (v) { var c = conv(arr(v)); return c.length === 1 ? c[0] : c; };
  if (!lp.a) { try { prop.setValue(single(lp.k)); } catch (e) {} }
  else {
    var ks = lp.k, i, d;
    for (i = 0; i < ks.length; i++) prop.setValueAtTime(ks[i].t / fr, single(ks[i].s));
    var dims = easeCount(prop);
    for (i = 0; i < ks.length; i++) {
      var k = ks[i], idx = i + 1, prev = ks[i - 1], next = ks[i + 1];
      var inE = [], outE = [];
      for (d = 0; d < dims; d++) {
        // incoming: the previous key's "i" handle describes how this segment arrives
        if (prev && prev.i && !prev.h) {
          var ix = n(prev.i.x), iy = n(prev.i.y);
          var vin = segSpeed(arr(prev.s), arr(k.s), (k.t - prev.t) / fr, dims, d);
          var infIn = clamp((1 - ix) * 100, 0.1, 100);
          inE.push(new KeyframeEase(1 - ix > 1e-4 ? vin * (1 - iy) / (1 - ix) : vin, infIn));
        } else inE.push(new KeyframeEase(0, 33.33));
        if (next && k.o && !k.h) {
          var ox = n(k.o.x), oy = n(k.o.y);
          var vout = segSpeed(arr(k.s), arr(next.s), (next.t - k.t) / fr, dims, d);
          outE.push(new KeyframeEase(ox > 1e-4 ? vout * oy / ox : vout, clamp(ox * 100, 0.1, 100)));
        } else outE.push(new KeyframeEase(0, 33.33));
      }
      try { prop.setTemporalEaseAtKey(idx, inE, outE); } catch (e) {}
      var linOut = k.o && n(k.o.x) === 0 && n(k.o.y) === 0 && next && k.i && n(k.i.x) === 1 && n(k.i.y) === 1;
      var linIn = prev && prev.o && n(prev.o.x) === 0 && n(prev.o.y) === 0 && prev.i && n(prev.i.x) === 1 && n(prev.i.y) === 1;
      var I = KeyframeInterpolationType;
      var tin = prev && prev.h ? I.HOLD : linIn ? I.LINEAR : I.BEZIER;
      var tout = k.h ? I.HOLD : linOut ? I.LINEAR : I.BEZIER;
      try { prop.setInterpolationTypeAtKey(idx, tin, tout); } catch (e) {}
      if (k.to && next) { try { prop.setSpatialTangentsAtKey(idx, prev && prev.ti ? prev.ti : [0, 0], k.to); } catch (e) {} }
      else if (prev && prev.ti) { try { prop.setSpatialTangentsAtKey(idx, prev.ti, [0, 0]); } catch (e) {} }
    }
  }
  if (lp.x) { try { prop.expression = exprText(lp.x); } catch (e) {} }
}
var to3 = function (v) { return [v[0], v[1], 100]; };

function makeShape(s) {
  var sh = new Shape();
  sh.vertices = s.v; sh.inTangents = s.i; sh.outTangents = s.o; sh.closed = !!s.c;
  return sh;
}
function addItems(vecs, items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i], p;
    if (it.ty === 'gr') {
      var g = vecs.addProperty('ADBE Vector Group');
      g.name = it.nm || 'Group';
      addItems(g.property('ADBE Vectors Group'), it.it);
    } else if (it.ty === 'rc') {
      p = vecs.addProperty('ADBE Vector Shape - Rect');
      setProp(p.property('ADBE Vector Rect Size'), it.s);
      setProp(p.property('ADBE Vector Rect Position'), it.p);
      setProp(p.property('ADBE Vector Rect Roundness'), it.r);
    } else if (it.ty === 'el') {
      p = vecs.addProperty('ADBE Vector Shape - Ellipse');
      setProp(p.property('ADBE Vector Ellipse Size'), it.s);
      setProp(p.property('ADBE Vector Ellipse Position'), it.p);
    } else if (it.ty === 'sh') {
      p = vecs.addProperty('ADBE Vector Shape - Group');
      var pk = it.ks;
      if (pk.a) {
        var sp = p.property('ADBE Vector Shape');
        for (var j = 0; j < pk.k.length; j++) sp.setValueAtTime(pk.k[j].t / fr, makeShape(pk.k[j].s[0]));
      } else p.property('ADBE Vector Shape').setValue(makeShape(pk.k));
    } else if (it.ty === 'fl') {
      p = vecs.addProperty('ADBE Vector Graphic - Fill');
      setProp(p.property('ADBE Vector Fill Color'), it.c);
      setProp(p.property('ADBE Vector Fill Opacity'), it.o);
      try { p.property('ADBE Vector Fill Rule').setValue(it.r === 2 ? 2 : 1); } catch (e) {}
    } else if (it.ty === 'st') {
      p = vecs.addProperty('ADBE Vector Graphic - Stroke');
      setProp(p.property('ADBE Vector Stroke Color'), it.c);
      setProp(p.property('ADBE Vector Stroke Opacity'), it.o);
      setProp(p.property('ADBE Vector Stroke Width'), it.w);
      try { p.property('ADBE Vector Stroke Line Cap').setValue(it.lc || 2); p.property('ADBE Vector Stroke Line Join').setValue(it.lj || 2); } catch (e) {}
    }
  }
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64decode(s) {
  var out = [], buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var c = B64.indexOf(s.charAt(i));
    if (c < 0) continue;
    buf = (buf << 6) | c; bits += 6;
    if (bits >= 8) { bits -= 8; out.push(String.fromCharCode((buf >> bits) & 255)); }
  }
  return out.join('');
}
var imported = {};
function importAsset(a) {
  if (imported[a.id]) return imported[a.id];
  var m = /^data:image\/(\w+);base64,/.exec(a.p || '');
  if (!m) return null;
  var f = new File(Folder.temp.fsName + '/motion_' + a.id + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]));
  f.encoding = 'BINARY';
  f.open('w'); f.write(b64decode(a.p.substring(m[0].length))); f.close();
  var item = app.project.importFile(new ImportOptions(f));
  imported[a.id] = item;
  return item;
}

var comps = {};
function assetById(id) { for (var i = 0; i < DATA.assets.length; i++) if (DATA.assets[i].id === id) return DATA.assets[i]; return null; }
function buildComp(name, w, h, dur, layers) {
  var comp = app.project.items.addComp(name, w, h, 1, dur, fr);
  var made = {}, i, ld, L;
  // ae adds new layers on top: create bottom-most first
  for (i = layers.length - 1; i >= 0; i--) {
    ld = layers[i]; L = null;
    if (ld.ty === 4) {
      L = comp.layers.addShape();
      addItems(L.property('ADBE Root Vectors Group'), ld.shapes || []);
    } else if (ld.ty === 5) {
      var doc = ld.t.d.k[0].s;
      L = doc.sz ? comp.layers.addBoxText(doc.sz, doc.t) : comp.layers.addText(doc.t);
      var tp = L.property('ADBE Text Properties').property('ADBE Text Document');
      var td = tp.value;
      try { td.fontSize = doc.s; } catch (e) {}
      try { td.applyFill = true; td.fillColor = doc.fc; } catch (e) {}
      try { td.font = doc.f; } catch (e) {}
      try { td.justification = doc.j === 1 ? ParagraphJustification.RIGHT_JUSTIFY : doc.j === 2 ? ParagraphJustification.CENTER_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY; } catch (e) {}
      try { td.tracking = doc.tr; } catch (e) {}
      try { td.autoLeading = false; td.leading = doc.lh; } catch (e) {}
      try { tp.setValue(td); } catch (e) {}
      // box text: put the box's top-left on the layer origin (ae 2023+ can set this; older keeps it centered)
      try { td = tp.value; td.boxTextPos = [0, 0]; tp.setValue(td); } catch (e) {}
    } else if (ld.ty === 0) {
      var asset = assetById(ld.refId);
      if (asset) {
        if (!comps[ld.refId]) comps[ld.refId] = buildComp(asset.nm || ld.nm, ld.w, ld.h, dur, asset.layers);
        L = comp.layers.add(comps[ld.refId]);
        L.startTime = (ld.st || 0) / fr;
      }
    } else if (ld.ty === 2) {
      var ia = assetById(ld.refId), item = null;
      if (ia) { try { item = importAsset(ia); } catch (e) {} }
      if (item) L = comp.layers.add(item);
    }
    if (!L) { L = comp.layers.addNull(); L.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0]); }
    L.name = ld.nm || L.name;
    made[ld.ind] = { L: L, d: ld };
  }
  // parent first (with jump: keep the child's values as they are), then transforms
  for (var key in made) {
    var e = made[key];
    if (e.d.parent && made[e.d.parent]) {
      if (typeof e.L.setParentWithJump === 'function') e.L.setParentWithJump(made[e.d.parent].L);
      else e.L.parent = made[e.d.parent].L;
    }
  }
  for (key in made) {
    e = made[key]; ld = e.d; L = e.L;
    var tr = L.property('ADBE Transform Group'), ks = ld.ks;
    setProp(tr.property('ADBE Anchor Point'), ks.a);
    setProp(tr.property('ADBE Position'), ks.p);
    setProp(tr.property('ADBE Scale'), ks.s, to3);
    setProp(tr.property('ADBE Rotate Z'), ks.r);
    setProp(tr.property('ADBE Opacity'), ks.o);
    try { L.inPoint = ld.ip / fr; L.outPoint = ld.op / fr; } catch (e2) {}
    if (ld.hd) L.enabled = false;
  }
  return comp;
}

app.beginUndoGroup('Import from Motion');
try {
  var main = buildComp(DATA.nm, DATA.w, DATA.h, (DATA.op - DATA.ip) / fr, DATA.layers);
  if (DATA.bg) {
    var bg = main.layers.addSolid(DATA.bg, 'Background', DATA.w, DATA.h, 1);
    bg.moveToEnd();
  }
  main.openInViewer();
} catch (err) {
  alert('Motion import failed: ' + err.toString() + (err.line ? ' (line ' + err.line + ')' : ''));
}
app.endUndoGroup();
`;

/** extendscript source that rebuilds the active composition in after effects */
export function projectToAeScript(project: Project): string {
  const data = projectToLottie(project);
  const comp = project.comps[project.activeComp] ?? Object.values(project.comps)[0];
  const bg = comp?.background;
  if (bg && bg[3] > 0) data.bg = [bg[0], bg[1], bg[2]];
  // json is valid es3 except for the two js line separators
  const json = JSON.stringify(data).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `// generated by Motion: rebuilds "${String(data.nm).replace(/[\r\n]/g, ' ')}" in After Effects.\n// After Effects: File > Scripts > Run Script File…\n(function () {\nvar DATA = ${json};\n${RUNTIME}\n})();\n`;
}
