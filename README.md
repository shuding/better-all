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
- **No hanging promises**: Avoids the uncaught dangling promises problem often seen in manual optimization
- **Debug mode with waterfall visualization**: See exactly how tasks execute with ASCII waterfall charts
- **Lightweight**: Minimal dependencies and small bundle size

## API

### `all(tasks, options?)`

Execute tasks with automatic dependency resolution.

- `tasks`: Object of async task functions
- `options`: Optional configuration object
  - `debug`: Set to `true` to output a waterfall chart showing task execution timeline
- Each task function receives `this.$` - an object with promises for all task results
- Returns a promise that resolves to an object with all task results
- Rejects if any task fails (like `Promise.all`)

### `allSettled(tasks, options?)`

Execute tasks with automatic dependency resolution, returning settled results for all tasks.

- `tasks`: Object of async task functions
- `options`: Optional configuration object
  - `debug`: Set to `true` to output a waterfall chart showing task execution timeline
- Each task function receives `this.$` - an object with promises for all task results
- Returns a promise that resolves to an object with all task results as `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }`
- Never rejects - failed tasks are included in the result (like `Promise.allSettled`)
- If a task depends on a failed task, the dependent task will also fail unless it catches the error

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

## Debug Mode

Enable debug mode to visualize task execution with a waterfall chart:

```typescript
const result = await all({
  async config() {
    await sleep(50)
    return { apiUrl: 'https://api.example.com' }
  },
  async user() {
    await sleep(120)
    return { id: 1, name: 'Alice' }
  },
  async posts() {
    const user = await this.$.user
    await sleep(200)
    return fetchPosts(user.id)
  },
  async profile() {
    const user = await this.$.user
    const config = await this.$.config
    await sleep(80)
    return fetchProfile(user.id, config.apiUrl)
  },
  async analytics() {
    const posts = await this.$.posts
    const profile = await this.$.profile
    await sleep(40)
    return computeAnalytics(posts, profile)
  }
}, { debug: true })
```

This outputs an ASCII waterfall chart showing:
- Task execution timeline
- Task duration in milliseconds
- Dependencies for each task
- Visual representation of parallel vs sequential execution

Example output:

```
╔════════════════════════════════════════════════════════════════════════════════╗
║                           Task Execution Waterfall                             ║
╠════════════════════════════════════════════════════════════════════════════════╣
║ Total Duration: 364.54ms                                                       ║
╚════════════════════════════════════════════════════════════════════════════════╝

Task      │ Deps           │ Duration │ Timeline
──────────┼────────────────┼──────────┼─────────────────────────────────────────────────────────────
config    │ -              │   51.4ms │ ████████                                                    
user      │ -              │  121.4ms │ ████████████████████                                        
posts     │ user           │  322.6ms │ ░░░░░░░░░░░░░░░░░░░░██████████████████████████████████████  
profile   │ user, config   │  202.9ms │ ░░░░░░░░░░░░░░░░░░░░███████████████████                     
analytics │ posts, profile │  364.4ms │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░███████

Legend: █ = active (fulfilled), ▓ = active (rejected), ░ = waiting on dependency
```

The enhanced waterfall visualization shows:
- **█** (solid bars) = Active execution time when the task is running its code
- **░** (light shade) = Waiting time when the task is blocked on a dependency
- **▓** (dashed bars) = Active execution for tasks that failed

This makes it easy to:
- Distinguish between active execution vs waiting on dependencies
- Identify which tasks are running in parallel
- See exactly how long each task actively executes vs waits
- Understand the dependency chain and blocking relationships
- Spot opportunities for optimization (e.g., tasks with long wait times)

## Error Handling

### With `all()`

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

### With `allSettled()`

All tasks complete and return their settled state, never rejecting:

```typescript
const result = await allSettled({
  async a() { return 1 },
  async b() { throw new Error('Task b failed') },
  async c() { return 3 }
})

// result.a: { status: 'fulfilled', value: 1 }
// result.b: { status: 'rejected', reason: Error('Task b failed') }
// result.c: { status: 'fulfilled', value: 3 }

if (result.a.status === 'fulfilled') {
  console.log(result.a.value) // 1
}

if (result.b.status === 'rejected') {
  console.error(result.b.reason) // Error: Task b failed
}
```

### Handling Dependency Failures with `allSettled()`

When a task depends on a failed task, it will also fail unless the error is caught:

```typescript
const result = await allSettled({
  async a() { throw new Error('a failed') },
  async b() {
    // This will fail because 'a' failed
    const aValue = await this.$.a
    return aValue + 10
  },
  async c() {
    // This handles the error and succeeds
    try {
      const aValue = await this.$.a
      return aValue + 10
    } catch (err) {
      return 'fallback value'
    }
  }
})

// result.a: { status: 'rejected', reason: Error('a failed') }
// result.b: { status: 'rejected', reason: Error('a failed') }
// result.c: { status: 'fulfilled', value: 'fallback value' }
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
