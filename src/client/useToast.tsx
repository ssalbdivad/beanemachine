import { useCallback, useRef, useState } from "react"

export type Toast = { message: string; bad: boolean } | null

export const useToast = () => {
	const [toast, setToast] = useState<Toast>(null)
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

	const show = useCallback((message: string, bad = false) => {
		clearTimeout(timer.current)
		setToast({ message, bad })
		timer.current = setTimeout(() => setToast(null), bad ? 6500 : 2600)
	}, [])

	return { toast, show }
}
