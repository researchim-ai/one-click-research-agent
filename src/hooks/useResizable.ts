import { useState, useCallback, useRef, useEffect } from 'react'

type Direction = 'left' | 'right' | 'up' | 'down'

interface UseResizableOptions {
  direction: Direction
  initialSize: number
  minSize: number
  maxSize: number
  collapsedSize?: number
  collapseThreshold?: number
  onDragStart?: () => void
}

const isHorizontal = (d: Direction) => d === 'left' || d === 'right'

export function useResizable({
  direction,
  initialSize,
  minSize,
  maxSize,
  collapsedSize = 0,
  collapseThreshold = 0,
  onDragStart,
}: UseResizableOptions) {
  const [size, setSize] = useState(initialSize)
  const [collapsed, setCollapsed] = useState(false)
  const dragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      startPos.current = isHorizontal(direction) ? e.clientX : e.clientY
      startSize.current = collapsed ? minSize : size
      document.body.style.cursor = isHorizontal(direction) ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      onDragStart?.()
    },
    [size, collapsed, minSize, direction, onDragStart],
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const pos = isHorizontal(direction) ? e.clientX : e.clientY
      const delta = (direction === 'left' || direction === 'up')
        ? pos - startPos.current
        : startPos.current - pos
      const next = startSize.current + delta

      if (collapseThreshold > 0 && next < collapseThreshold) {
        setCollapsed(true)
        setSize(minSize)
      } else {
        setCollapsed(false)
        setSize(Math.max(minSize, Math.min(maxSize, next)))
      }
    }

    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [direction, minSize, maxSize, collapseThreshold])

  const effectiveSize = collapsed ? collapsedSize : size

  return { size: effectiveSize, collapsed, setCollapsed, onMouseDown }
}
