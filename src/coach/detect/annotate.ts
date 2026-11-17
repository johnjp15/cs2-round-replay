/** Small builders for evidence annotations and windows (world coordinates, demo ticks). */
import type { Annotation, ColorRole, Evidence } from '../model/report';

type P3 = [number, number, number];

export function line(from: P3, to: P3, tick0: number, tick1: number, role: ColorRole, label?: string, dashed = false): Annotation {
  return { kind: 'line', from: r3(from), to: r3(to), tick0, tick1, role, ...(label !== undefined ? { label } : {}), ...(dashed ? { dashed } : {}) };
}

export function label(at: P3, text: string, tick0: number, tick1: number, role: ColorRole): Annotation {
  return { kind: 'label', at: r3(at), text, tick0, tick1, role };
}

export function circle(center: P3, radius: number, tick0: number, tick1: number, role: ColorRole, lbl?: string): Annotation {
  return { kind: 'circle', center: r3(center), radius, tick0, tick1, role, ...(lbl !== undefined ? { label: lbl } : {}) };
}

export function path(points: P3[], ticks: number[], tick0: number, tick1: number, role: ColorRole, lbl?: string): Annotation {
  return { kind: 'path', points: points.map(r3), ticks: [...ticks], tick0, tick1, role, ...(lbl !== undefined ? { label: lbl } : {}) };
}

export function evidence(kind: Evidence['kind'], round: number, focus: number, before: number, after: number, players: number[], annotations: Annotation[], caption: string): Evidence {
  return { kind, round, tick0: focus - before, tick1: focus + after, focus, players: [...new Set(players)].filter((p) => p >= 0), annotations, caption };
}

function r3(p: P3): P3 {
  return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 10) / 10];
}
