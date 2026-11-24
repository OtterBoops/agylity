// `toPrecision(12)` kills binary-float drift (0.29 * 100 = 28.999999999999996) before flooring.
export const toPercentFloor = (fraction: number): number =>
  Math.floor(Number((fraction * 100).toPrecision(12)));
