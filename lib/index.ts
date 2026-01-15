/**
 * Promise.all with automatic dependency optimization and full type inference
 *
 * Usage:
 * const { a, b, c } = await all({
 *   a() { return 1 },
 *   async b() { return 'hello' },
 *   async c() { return (await this.$.a) + 10 }
 * })
 */

// Extract the resolved return type from task functions
type TaskResult<T> = T extends (...args: any[]) => infer R ? Awaited<R> : never

// The $ proxy type - all task results as promises
type DepProxy<T extends Record<string, (...args: any[]) => any>> = {
  readonly [K in keyof T]: Promise<TaskResult<T[K]>>
}

// Context available to each task via `this`
type TaskContext<T extends Record<string, (...args: any[]) => any>> = {
  $: DepProxy<T>
}

// Result type - all tasks resolved to their return values
type AllResult<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: TaskResult<T[K]>
}

// Settled result types for allSettled
type SettledFulfilled<T> = {
  status: 'fulfilled'
  value: T
}

type SettledRejected = {
  status: 'rejected'
  reason: any
}

type SettledResult<T> = SettledFulfilled<T> | SettledRejected

// Result type for allSettled - all tasks as settled results
type AllSettledResult<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: SettledResult<TaskResult<T[K]>>
}

/**
 * Internal core implementation for executing tasks with automatic dependency resolution.
 * This is shared between `all` and `allSettled`.
 */
function executeTasksInternal<T extends Record<string, any>>(
  tasks: T,
  handleSettled: boolean
): Promise<any> {
  const taskNames = Object.keys(tasks) as (keyof T)[]
  const results = new Map<keyof T, any>()
  const errors = new Map<keyof T, any>()
  const resolvers = new Map<
    keyof T,
    [(value: any) => void, (reason?: any) => void][]
  >()
  const returnValue: Record<string, any> = {}

  // Track which tasks are waiting for which dependencies (for cycle detection)
  const waiting_for = new Map<string, Set<string>>()

  // Find cycle path using DFS, returns path if cycle found, null otherwise
  const findCyclePath = (from: string, to: string): string[] | null => {
    const visited = new Set<string>()
    const path: string[] = [to]

    const dfs = (current: string): boolean => {
      if (current === from) return true
      if (visited.has(current)) return false
      visited.add(current)

      const deps = waiting_for.get(current)
      if (deps) {
        for (const dep of deps) {
          path.push(dep)
          if (dfs(dep)) return true
          path.pop()
        }
      }
      return false
    }

    return dfs(to) ? path : null
  }

  // Create a dependency proxy for a specific task (knows caller identity)
  const createDepProxyFor = (task_name: string) => {
    return new Proxy({} as DepProxy<T>, {
      get(_, dep_name) {
        // Filter non-string and non-existent tasks
        if (typeof dep_name !== 'string' || !(dep_name in tasks)) {
          if (typeof dep_name === 'string') {
            return Promise.reject(new Error(`Unknown task "${dep_name}"`))
          }
          return undefined
        }

        // Check for circular dependency before waiting
        const cycle_path = findCyclePath(task_name, dep_name)
        if (cycle_path) {
          const cycle_str = [task_name, ...cycle_path].join(' -> ')
          return Promise.reject(
            new Error(`Circular dependency detected: ${cycle_str}`)
          )
        }

        // Record this dependency
        if (!waiting_for.has(task_name)) {
          waiting_for.set(task_name, new Set())
        }
        waiting_for.get(task_name)!.add(dep_name)

        // Wait for dependency and clean up when done
        return waitForDep(dep_name as keyof T).finally(() => {
          waiting_for.get(task_name)?.delete(dep_name)
        })
      },
    })
  }

  const waitForDep = (depName: keyof T): Promise<any> => {
    if (!(depName in tasks)) {
      return Promise.reject(new Error(`Unknown task "${String(depName)}"`))
    }
    if (results.has(depName)) {
      return Promise.resolve(results.get(depName))
    }
    if (errors.has(depName)) {
      return Promise.reject(errors.get(depName))
    }
    return new Promise((resolve, reject) => {
      if (!resolvers.has(depName)) {
        resolvers.set(depName, [])
      }
      resolvers.get(depName)!.push([resolve, reject])
    })
  }

  const handleResult = (name: keyof T, value: any) => {
    results.set(name, value)
    if (handleSettled) {
      returnValue[name as string] = { status: 'fulfilled', value }
    } else {
      returnValue[name as string] = value
    }
    if (resolvers.has(name)) {
      for (const [resolve] of resolvers.get(name)!) {
        resolve(value)
      }
    }
  }

  const handleError = (name: keyof T, err: any) => {
    errors.set(name, err)
    if (handleSettled) {
      returnValue[name as string] = { status: 'rejected', reason: err }
    }
    if (resolvers.has(name)) {
      for (const [, reject] of resolvers.get(name)!) {
        reject(err)
      }
    }
  }

  // Run all tasks in parallel, each with its own dependency proxy
  const promises = taskNames.map(async (name) => {
    try {
      const taskFn = tasks[name]
      if (typeof taskFn !== 'function') {
        throw new Error(`Task "${String(name)}" is not a function`)
      }

      // Create per-task context with proxy that knows caller identity
      const context: TaskContext<T> = { $: createDepProxyFor(String(name)) }
      const result = await taskFn.call(context)
      handleResult(name, result)
    } catch (err) {
      handleError(name, err)
      if (!handleSettled) {
        throw err
      }
    }
  })

  if (handleSettled) {
    // For allSettled, wait for all promises to settle (never rejects)
    return Promise.allSettled(promises).then(() => returnValue)
  } else {
    // For all, reject on first error (like Promise.all)
    return Promise.all(promises).then(() => returnValue)
  }
}

/**
 * Execute tasks with automatic dependency resolution.
 *
 * @example
 * const { a, b, c } = await all({
 *   async a() { return 1 },
 *   async b() { return 'hello' },
 *   async c() { return (await this.$.a) + 10 }
 * })
 */
export function all<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    }
): Promise<AllResult<T>> {
  return executeTasksInternal(tasks, false) as Promise<AllResult<T>>
}

/**
 * Execute tasks with automatic dependency resolution, returning settled results for all tasks.
 * Unlike `all`, this will never reject - failed tasks will be included in the result with their error.
 *
 * @example
 * const { a, b, c } = await allSettled({
 *   async a() { return 1 },
 *   async b() { throw new Error('failed') },
 *   async c() { return (await this.$.a) + 10 }
 * })
 * // a: { status: 'fulfilled', value: 1 }
 * // b: { status: 'rejected', reason: Error('failed') }
 * // c: { status: 'fulfilled', value: 11 }
 */
export function allSettled<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    }
): Promise<AllSettledResult<T>> {
  return executeTasksInternal(tasks, true) as Promise<AllSettledResult<T>>
}
