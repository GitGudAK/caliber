import { useCallback, useEffect, useState } from 'react'
import type { Health } from '../../shared/types'
import { api, errorMessage } from './api'

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setHealth(await api.health())
      setError(null)
    } catch (e) {
      setHealth(null)
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { health, error, loading, refresh }
}
