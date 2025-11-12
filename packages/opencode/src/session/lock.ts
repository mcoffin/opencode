import z from "zod"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { NamedError } from "../util/error"

export namespace SessionLock {
  const log = Log.create({ service: "session.lock" })

  export const LockedError = NamedError.create(
    "SessionLockedError",
    z.object({
      sessionID: z.string(),
      message: z.string(),
    }),
  )

  type LockState = {
    controller: AbortController
    created: number
  }

  const state = Instance.state(
    () => {
      const locks = new Map<string, LockState>()
      return {
        locks,
      }
    },
    async (current) => {
      log.debug("force abort cleanup starting", {
        lockCount: current.locks.size,
        sessionIDs: Array.from(current.locks.keys()),
      })
      for (const [sessionID, lock] of current.locks) {
        log.info("force abort", { sessionID })
        log.debug("force aborting session", {
          sessionID: sessionID,
          created: lock.created,
          elapsed: Date.now() - lock.created,
        })
        lock.controller.abort()
      }
      current.locks.clear()
      log.debug("force abort cleanup completed")
    },
  )

  function get(sessionID: string) {
    return state().locks.get(sessionID)
  }

  function unset(input: { sessionID: string; controller: AbortController }) {
    const lock = get(input.sessionID)
    if (!lock) return false
    if (lock.controller !== input.controller) return false
    state().locks.delete(input.sessionID)
    return true
  }

  export function acquire(input: { sessionID: string }) {
    const lock = get(input.sessionID)
    if (lock) {
      log.debug("session lock conflict", {
        sessionID: input.sessionID,
        existingLockCreated: lock.created,
      })
      throw new LockedError({
        sessionID: input.sessionID,
        message: `Session ${input.sessionID} is locked`,
      })
    }
    const controller = new AbortController()
    state().locks.set(input.sessionID, {
      controller,
      created: Date.now(),
    })
    log.info("locked", { sessionID: input.sessionID })
    log.debug("session lock acquired", {
      sessionID: input.sessionID,
      controller: controller,
    })
    return {
      signal: controller.signal,
      abort() {
        log.debug("session lock abort called", { sessionID: input.sessionID })
        controller.abort()
        unset({ sessionID: input.sessionID, controller })
      },
      async [Symbol.dispose]() {
        const removed = unset({ sessionID: input.sessionID, controller })
        if (removed) {
          log.info("unlocked", { sessionID: input.sessionID })
          log.debug("session lock disposed", { sessionID: input.sessionID })
        }
      },
    }
  }

  export function abort(sessionID: string) {
    const lock = get(sessionID)
    if (!lock) return false
    log.info("abort", { sessionID })
    log.debug("session abort triggered", {
      sessionID: sessionID,
      created: lock.created,
      elapsed: Date.now() - lock.created,
    })
    lock.controller.abort()
    state().locks.delete(sessionID)
    log.debug("session abort completed", { sessionID: sessionID })
    return true
  }

  export function isLocked(sessionID: string) {
    return get(sessionID) !== undefined
  }

  export function assertUnlocked(sessionID: string) {
    const lock = get(sessionID)
    if (!lock) return
    throw new LockedError({ sessionID, message: `Session ${sessionID} is locked` })
  }
}
