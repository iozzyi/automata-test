// Provided. Maps run-relative milliseconds onto pixels.
import { scaleLinear } from 'd3-scale'

export function timeScale(t0: number, t1: number, width: number) {
  const span = Math.max(t1 - t0, 1000)
  return scaleLinear()
    .domain([t0, t0 + span])
    .range([0, width])
    .clamp(true)
}

export function ticks(t0: number, t1: number, count = 6): number[] {
  return timeScale(t0, t1, 1).ticks(count)
}
