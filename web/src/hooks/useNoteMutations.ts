import { useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { describeApiError } from '../utils/apiError'

/**
 * useNoteMutations encapsulates all note write operations (create / edit /
 * delete / move / pin) together with the retry-last mechanism.
 *
 * The `run` wrapper captures the last failed mutation so the ErrorBanner's
 * retry button can replay it instead of leaving the user with a silent
 * failure, and resolves to whether the operation SUCCEEDED: callers that
 * optimistically mutate state (e.g. handlePin's optimistic toggle) must roll
 * back based on this return value — the old pattern of checking lastOpRef
 * consulted a ref that any earlier failed operation left non-null, so every
 * subsequent successful pin was rolled back too.
 */
export interface NoteMutationsHandle {
  run: (op: () => Promise<void>, errMsg: string) => Promise<boolean>
  retryLast: () => void
  lastOpRef: React.MutableRefObject<(() => Promise<void>) | null>
}

export function useNoteMutations(setError: (msg: string) => void): NoteMutationsHandle {
  const { t } = useTranslation()
  const lastOpRef = useRef<(() => Promise<void>) | null>(null)

  const run = useCallback(async (op: () => Promise<void>, errMsg: string): Promise<boolean> => {
    setError('')
    try {
      await op()
      return true
    } catch (e) {
      lastOpRef.current = op
      setError(errMsg + describeApiError(t, e))
      return false
    }
  }, [setError, t])

  const retryLast = useCallback(() => {
    const op = lastOpRef.current
    if (op) { lastOpRef.current = null; void op() }
  }, [])

  return { run, retryLast, lastOpRef }
}
