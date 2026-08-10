/** Shapes the ops 模型 panel reads out of the inference modules.
 *
 *  This file is public and is NOT mirrored into the private core submodule, which is the
 *  whole point: depth.ts and face.ts each exist in two versions (public stub / real core)
 *  and both import these types, so the two can never drift into incompatible shapes.
 *  A stub reports `available: false` and empty state; it never throws for these. */

export type ModelBackend = 'sidecar' | 'local' | 'unavailable';

export interface MattingDescription {
  backend: ModelBackend;
  sidecarUrl: string | null;
  modelFile: string | null;
  version: string | null;
  warm: boolean;
  partsWarm: boolean;
}

export interface InferenceDescription {
  /** false in the public stub build — no weights ship there */
  available: boolean;
  depth: {
    backend: ModelBackend;
    sidecarUrl: string | null;
    tiles: number;
    gridSize: number;
    modelFile: string | null;
    outputVersion: string;
    warm: boolean;
  };
  /** folded in here because matting.ts has no public stub — ops must never import it */
  matting: MattingDescription;
}

export interface FaceModelState {
  file: string;
  present: boolean;
  warm: boolean;
}

export interface FaceDescription {
  available: boolean;
  modelVersion: string;
  thumbVersion: string;
  det: FaceModelState;
  rec: FaceModelState;
}
