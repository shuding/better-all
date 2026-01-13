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

/**
 * Execute tasks with automatic dependency resolution.
 *
 * @example
 * const { a, b, c } = await all({
 *   a() { return 1 },
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
  const taskNames = Object.keys(tasks) as (keyof T)[]
  const results = new Map<keyof T, any>()
  const resolvers = new Map<
    keyof T,
    [(value: any) => void, (reason?: any) => void][]
  >()
  const returnValue: Record<string, any> = {}

  const waitForDep = (depName: keyof T): Promise<any> => {
    if (!(depName in tasks)) {
      return Promise.reject(new Error(`Unknown task "${String(depName)}"`))
    }
    if (results.has(depName)) {
      return Promise.resolve(results.get(depName))
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
    returnValue[name as string] = value
    if (resolvers.has(name)) {
      for (const [resolve] of resolvers.get(name)!) {
        resolve(value)
      }
    }
  }

  const handleError = (name: keyof T, err: any) => {
    if (resolvers.has(name)) {
      for (const [, reject] of resolvers.get(name)!) {
        reject(err)
      }
    }
  }

  // Create dep proxy
  const depProxy = new Proxy({} as DepProxy<T>, {
    get(_, depName: string) {
      return waitForDep(depName as keyof T)
    },
  })

  // Create context with $ proxy
  const context: TaskContext<T> = { $: depProxy }

  // Run all tasks in parallel
  const promises = taskNames.map(async (name) => {
    try {
      const taskFn = tasks[name]
      if (typeof taskFn !== 'function') {
        throw new Error(`Task "${String(name)}" is not a function`)
      }

      const result = await taskFn.call(context)
      handleResult(name, result)
    } catch (err) {
      handleError(name, err)
      throw err
    }
  })

  return Promise.all(promises).then(() => returnValue as AllResult<T>)
}

/**
 * Promise.allSettled
 *
 * Usage:
 * const { a, b, c } = await promiseAllWithSettle([
 *   Promise.resolve(1),
 *   Promise.resolve('hello'),
 *   Promise.resolve(true),
 * ])
 */

const defaultOnRejected = (_: PromiseRejectedResult) => {}

function isRejected(
  input: PromiseSettledResult<unknown>
): input is PromiseRejectedResult {
  return input.status === 'rejected'
}



export async function promiseAllWithSettle<T extends readonly unknown[] | []>(
  promises: T,
  onRejected: (result: PromiseRejectedResult) => void = defaultOnRejected
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settledPromises = await Promise.allSettled(promises)

  const rejectedPromises: PromiseRejectedResult[] = []
  const fulfilledPromises: any[] = []

  for (const promiseResult of settledPromises) {
    if (isRejected(promiseResult)) {
      onRejected(promiseResult)
      rejectedPromises.push(promiseResult)
    } else {
      fulfilledPromises.push(promiseResult.value)
    }
  }

  if (rejectedPromises.length > 0) {
    throw new AggregateError(
      rejectedPromises.map((p) => p.reason),
      'Promise rejection'
    )
  }

  return fulfilledPromises as { -readonly [P in keyof T]: Awaited<T[P]> }
}

