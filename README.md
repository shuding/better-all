# better-all

Promise.all with automatic dependency optimization and full type inference.

## Why?

When you have tasks with dependencies, the common `Promise.all` pattern is sometimes inefficient:

```typescript
// Common pattern: Sequential execution wastes time
const [a, b] = await Promise.all([getA(), getB()])  // a: 1s, b: 10s → takes 10s
const c = await getC(a)                             // c: 10s → takes 10s
// Total: 20 seconds
```

You could optimize this manually by parallelizing `b` and `c`:

```typescript
const a = await getA()               // a: 1s -> takes 1s
const [b, c] = await Promise.all([   // b: 10s, c: 10s -> takes 10s
  getB(),
  getC(a)
])
// Total: 11 seconds
```

But what if the durations of these methods change (i.e. unstable network latency)? Say `getA()` now takes 10 seconds and `getC()` takes 1 second. The previous manual optimization becomes suboptimal again, compared to the naive approach:

```typescript
const a = await getA()              // a: 10s -> takes 10s
const [b, c] = await Promise.all([  // b: 10s, c: 1s -> takes 10s
  getB(),
  getC(a)
])
// Total: 20 seconds

// Naive approach:
const [a, b] = await Promise.all([getA(), getB()])  // a: 10s, b: 10s → takes 10s
const c = await getC(a)                             // c: 1s → takes 1s
// Total: 11 seconds
```

To correctly optimize such cases using `Promise.all`, you'd have to _manually analyze and declare the dependency graph_:

```typescript
const [[a, c], b] = await Promise.all([
  getA().then(a => getC(a).then(c => [a, c])),
  getB()
])
```

This quickly becomes unmanageable in real-world scenarios with many tasks and complex dependencies, not to mention the loss of readability.

## Better `Promise.all`

**This library solves it automatically:**

```typescript
import { all } from 'better-all'

const { a, b, c } = await all({
  async a() { return getA() },               // 1s
  async b() { return getB() },               // 10s
  async c() { return getC(await this.$.a) }  // 10s (waits for a)
})
// Total: 11 seconds - optimal parallelization!
```

`all` automatically kicks off all tasks immediately, and when hitting an `await this.$.dependency`, it waits for that specific task to complete.

The magical `this.$` object gives you access to all other task results as promises, allowing you to express dependencies naturally.

The library ensures maximal parallelization automatically.

## Installation

```bash
npm install better-all
# or
pnpm add better-all
# or
bun add better-all
# or
yarn add better-all
```

## Features

- **Full type inference**: Both results and dependencies are fully typed
- **Automatic maximal parallelization**: Independent tasks run in parallel
- **Object-based API**: Minimal cognitive load, easy to read
- **Lightweight**: Minimal dependencies and small bundle size

## API

### `all(tasks)`

Execute tasks with automatic dependency resolution.

- `tasks`: Object of async task functions
- Each task function receives `this.$` - an object with promises for all task results
- Returns a promise that resolves to an object with all task results

## Examples

### Basic Parallel Execution

```typescript
const { a, b, c } = await all({
  async a() { await sleep(1000); return 1 },
  async b() { await sleep(1000); return 2 },
  async c() { await sleep(1000); return 3 }
})

// All three run in parallel
// Returns { a: 1, b: 2, c: 3 }
```

### With Dependencies

```typescript
const { user, profile, settings } = await all({
  async user() { return fetchUser(1) },
  async profile() { return fetchProfile((await this.$.user).id) },
  async settings() { return fetchSettings((await this.$.user).id) }
})

// User runs first, then profile and settings run in parallel
```

## Type Safety

Full TypeScript support with automatic type inference:

```typescript
const result = await all({
  async num() { return 42 },
  async str() { return 'hello' },
  async combined() {
    const n = await this.$.num  // n: number (auto-inferred!)
    const s = await this.$.str  // s: string (auto-inferred!)
    return `${s}: ${n}`
  }
})

result.num       // number
result.str       // string
result.combined  // string
```

### Complex Dependency Graph

```typescript
const { a, b, c, d, e } = await all({
  async a() { return 1 },
  async b() { return 2 },
  async c() { return (await this.$.a) + 10 },
  async d() { return (await this.$.b) + 20 },
  async e() { return (await this.$.c) + (await this.$.d) }
})

// a and b run in parallel
// c waits for a, d waits for b (c and d can overlap)
// e waits for both c and d

// { a: 1, b: 2, c: 11, d: 22, e: 33 }
console.log({ a, b, c, d, e })
```

### Stepped Dependency Chain

In this example, the `postsWithAuthor` task calls `await this.$.user` and `await this.$.posts` sequentially but there won't be any actual delays. The `all` function will always kick off all tasks as early as possible, so `posts` was already running while we awaited `this.$.user`:

```typescript
const result = await all({
  async user() {
    return fetchUser(1)
  },
  async posts() {
    return fetchPosts((await this.$.user).id)
  },
  async postsWithAuthor() {
    const user = await this.$.user
    console.log(`Fetched user: ${user.name}`)
    const posts = await this.$.posts
    return posts.map(post => ({ ...post, author: user.name }))
  },
})
```

This still gives optimal parallelization.

## Error Handling

Errors propagate to dependent tasks automatically, similar to `Promise.all`:

```typescript
try {
  await all({
    async a() { throw new Error('Failed') },
    async b() { return (await this.$.a) + 1 }
  })
} catch (err) {
  console.error(err) // Error: Failed
}
```

## Development

```bash
pnpm install     # Install dependencies
pnpm test        # Run tests
pnpm build       # Build
```

## Author

[Shu Ding](https://shud.in)

## License

MIT
