import { useEffect, useRef, useState } from 'react';
import { ParticleEngine } from '../particles/ParticleEngine';
import { setEngine } from '../particles/engineRef';
import { useAppStore } from '../store/useAppStore';

async function attachDevGui(engine: ParticleEngine): Promise<void> {
  const { default: GUI } = await import('lil-gui');
  const gui = new GUI({ title: 'particles' });
  const u = engine.uniforms;
  gui.add(engine.phys.uTurb, 'value', 0, 0.15, 0.001).name('turbulence');
  gui.add(engine.phys.uSpring, 'value', 1, 40, 0.5).name('spring');
  gui.add(engine.phys.uDamping, 'value', 0.5, 12, 0.1).name('damping');
  gui.add(u.uDepth, 'value', 0, 1.2, 0.01).name('depth');
  gui.add(u.uMouseRadius, 'value', 0, 0.5, 0.005).name('mouseRadius');
  gui.add(u.uFocusRadius, 'value', 0, 0.6, 0.005).name('focusRadius');
  gui.add(u.uFocusStrength, 'value', 0, 1.5, 0.05).name('focusStrength');
  gui.add(u.uPointScale, 'value', 0.0005, 0.02, 0.0002).name('pointScale');
  gui.add(u.uProgress, 'value', 0, 1, 0.01).name('progress').listen();
  gui.add(u.uGlobalAlpha, 'value', 0, 1, 0.01).name('alpha').listen();
  gui.add({ assemble: () => engine.assemble() }, 'assemble');
  gui.add({ condense: () => engine.condense() }, 'condense');
  gui.add({ dim: () => engine.dim() }, 'dim');
  gui.add({ undim: () => engine.undim() }, 'undim');
}

export function ParticleCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let engine: ParticleEngine;
    try {
      engine = new ParticleEngine(ref.current!);
    } catch (error) {
      console.warn('[particles] WebGL unavailable, continuing without the canvas', error);
      setFailed(true);
      return;
    }
    setEngine(engine);
    if (useAppStore.getState().view === 'timeline') engine.setDust(true);
    if (import.meta.env.DEV && location.search.includes('gui'))
      void attachDevGui(engine).catch((error) => console.warn('[particles] dev GUI failed', error));
    return () => {
      setEngine(null);
      engine.dispose();
    };
  }, []);

  return <canvas ref={ref} className={`particle-canvas${failed ? ' particle-canvas--disabled' : ''}`} aria-hidden="true" />;
}
