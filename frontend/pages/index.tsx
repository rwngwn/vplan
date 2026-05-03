import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import useSWR from 'swr'

import { createNote, fetchNotes } from '../lib/api'
import { t } from '../lib/i18n'

export default function Home() {
  const router = useRouter()
  const { data: notes, isLoading } = useSWR('notes', fetchNotes)
  const didRun = useRef(false)

  useEffect(() => {
    if (didRun.current) return
    if (isLoading || !notes) return
    didRun.current = true

    const run = async () => {
      if (notes.length > 0) {
        await router.replace(`/wiki/${notes[0].id}`)
        return
      }
      const created = await createNote(t('app.quickNoteTitle'))
      await router.replace(`/wiki/${created.id}`)
    }

    run()
  }, [isLoading, notes, router])

  return (
    <main className="min-h-screen grid place-items-center bg-[#11111a] text-slate-300">
      <p className="text-sm">{t('app.loadingWorkspace')}</p>
    </main>
  )
}
