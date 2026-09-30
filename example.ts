/**
 * @requires x >= 0
 * @ensures result > x
 */
function increment(x: number): number {
  return x + 1;
}

/**
 * @requires a >= 0
 * @requires b >= 0
 * @ensures result >= a
 * @ensures result >= b
 */
function add(a: number, b: number): number {
  return a + b;
}


/**
 * @requires x >= 0
 * @ensures result > x
 */
function incrementFail(x: number): number {
  return x - 1;
}
