# prove

Statically prove that TypeScript functions satisfy their JSDoc contracts, using the [Z3](https://github.com/Z3Prover/z3) SMT solver.

```ts
/**
 * @requires x >= 0
 * @ensures result > x
 */
function increment(x: number): number {
  return x + 1;
}
```

```
$ prove example.ts

increment
  parameter: x: number
  requires: x >= 0
  ensures: result > x
  returns: x + 1
  PASS

incrementFail
  ...
  FAIL: @ensures result > x can be violated when x = 0.0, result = (- 1.0)

1 function(s) failed verification
```

Exit code is `0` when every contract holds and `1` otherwise, so it can gate CI.

## Install

Requires Node 22+.

```sh
npm install
npm link        # builds (via `prepare`) and puts `prove` on your PATH
prove <file.ts>
```

After editing `src/`, run `npm run build` to refresh the linked CLI.

## How it works

1. **Parse** (`src/parse.ts`) — TypeScript 7 has no standalone parser, so the file is loaded through a throwaway project using `typescript/unstable/sync`.
2. **Extract** (`src/index.ts`) — every named `function` declaration is collected with its parameters, `@requires` / `@ensures` tags, and its first top-level `return` expression.
3. **Translate** (`src/verify.ts`) — contract and return expressions are re-parsed as TS expressions and translated to Z3 terms. `result` is bound to the return value.
4. **Check** — for each `@ensures E`, Z3 is asked whether `requires ∧ result = <return expr> ∧ ¬E` is satisfiable. `unsat` means the guarantee is proved; `sat` yields a concrete counterexample.

## Current support

| Area | Supported |
| --- | --- |
| Parameter types | `number` (as mathematical reals), `boolean` |
| Literals | numeric |
| Operators | `+ - * /`, unary `- + !`, `< <= > >=`, `== === != !==`, `&& \|\|`, parentheses |
| Function body | a single top-level `return <expr>` (other statements are ignored) |
| Contracts | `@requires` (preconditions, all conjoined) and `@ensures` (each checked independently) |

### Known limitations

- **`number` is modelled as ℝ**, not IEEE-754: no `NaN`, `Infinity`, overflow, or rounding. A contract proved here can still fail at runtime at those edges.
- Division by zero is not flagged (Z3 treats `x / 0` as an unconstrained value).
- Only the first top-level `return` is analysed — statements before it (locals, `if`, loops) are not modelled, so results for such functions are unsound.
- No function calls, methods, property access, strings, arrays, objects, or generics.
- Arrow functions, methods, and class members are not discovered.

## Roadmap

Work is ordered so each step broadens what can be *soundly* verified before adding new types.

### 1. Sound function bodies

Before adding types, stop ignoring code:

- Translate `const`/`let` declarations and reassignments into SSA form.
- Handle `if`/`else`, ternaries, and early `return`s by computing a path condition per return (or weakest preconditions), so `result` is the right value on every path.
- Reject (rather than silently ignore) any statement we can't model.
- Discover arrow functions, function expressions, and class methods.

### 2. Numeric precision

- `@type int` annotation / `bigint` → Z3 `Int` sort, enabling `%`, integer division, and exact integer reasoning.
- Opt-in `--float` mode using Z3's floating-point theory (`FP` sort, `Float64`) to model real IEEE-754 behaviour, including `NaN` and overflow.
- Emit proof obligations for division by zero and `Number.isInteger`-style guards.

### 3. Richer types

Each TS type maps to a Z3 sort; the translator dispatches on the declared type.

| TS type | Z3 encoding | Contract features enabled |
| --- | --- | --- |
| `string` | `String` sort (sequence theory) | `s.length`, `+` concat, `startsWith`, `includes`, `===` |
| literal unions (`"a" \| "b"`), `enum` | enumeration datatype | exhaustiveness, equality |
| `T[]` / `readonly T[]` | `Seq<T>` (or `Array<Int, T>` + length) | `a.length`, `a[i]`, bounds obligations |
| `interface` / object type | algebraic datatype with one field per property | `p.x`, nested access, object literals in returns |
| `T \| undefined`, `T \| null`, `x?: T` | `Option<T>` datatype | null-safety obligations on property access |
| discriminated unions | datatype with one constructor per variant | narrowing via `kind === "..."` |
| generics `<T>` | uninterpreted sort per type parameter | parametric contracts (e.g. `result === x` for identity) |

Type information will come from the checker rather than raw annotation text, so aliases, inferred return types, and imported types resolve correctly.

### 4. Calls and modularity

- Calls to other annotated functions are verified *modularly*: assert the callee's `@requires` at the call site, then assume its `@ensures` for the result — no inlining.
- Pure, unannotated helpers can be inlined up to a depth limit.
- Allowlisted built-ins (`Math.max`, `Math.abs`, `Math.min`, …) get hand-written models.

### 5. Loops and quantifiers

- `@invariant` on `for`/`while` loops, checked for initiation and preservation; `@decreases` for termination.
- Quantified contracts, e.g. `@ensures result.every((x) => x >= 0)` or a `forall(i, ...)` helper, translated to Z3 quantifiers.
- `old(x)` for referring to pre-state once mutation is supported.

### 6. Tooling

- Glob / directory input and a tsconfig-aware mode (`prove -p tsconfig.json`).
- `--json` output and source locations (`file:line:col`) on failures.
- Test suite of passing/failing fixtures per feature.
- Editor integration via diagnostics.
