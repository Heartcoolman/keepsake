import type { ParticleEngine } from './ParticleEngine';

let engine: ParticleEngine | null = null;

export function setEngine(e: ParticleEngine | null): void {
  engine = e;
}

export function getEngine(): ParticleEngine | null {
  return engine;
}
