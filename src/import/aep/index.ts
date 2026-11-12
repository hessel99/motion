// after effects project (.aep) import. see parse.ts (raw tree) and convert.ts (to our model).
export { parseAep, parseGradientXml, child, childGroup, childStream } from './parse';
export type {
  AepProject, AepItem, AepFolder, AepComp, AepFootage, AepLayer, AepLayerKind, AepGroup, AepNode,
  AepStream, AepKeyframe, AepPathProp, AepPathValue, AepTextProp, AepGradientProp,
} from './parse';
export { aepToProject, aepProjectToProject, streamToProp, argbToRgba } from './convert';
export { readRifx, readChunks } from './riff';
