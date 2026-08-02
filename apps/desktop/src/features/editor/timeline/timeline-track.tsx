import { useState } from "react"
import type { TimelineTrack } from "@recordforge/contracts"
import { createUpdateTrackCommand, trackKindDisplayName } from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { TimelineClipView } from "./timeline-clip"
import { PipControls } from "./pip-controls"

interface TimelineTrackProps {
  track: TimelineTrack
  laneWidth: number
  selectedClipId: string | null
  onSelectClip: (id: string) => void
}

// Mute, solo, lock, volume and PiP controls for a track.
export function TimelineTrack({
  track,
  laneWidth,
  selectedClipId,
  onSelectClip,
}: TimelineTrackProps) {
  const store = useTimelineStore()
  const [showPip, setShowPip] = useState(false)

  function toggleMuted() {
    store.execute(createUpdateTrackCommand(track.id, { muted: !track.muted }))
  }

  function toggleSolo() {
    store.execute(createUpdateTrackCommand(track.id, { solo: !track.solo }))
  }

  function toggleLocked() {
    store.execute(createUpdateTrackCommand(track.id, { locked: !track.locked }))
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const volume = Number.parseFloat(e.target.value)
    if (!Number.isNaN(volume)) {
      store.execute(createUpdateTrackCommand(track.id, { volume }))
    }
  }

  return (
    <div className="flex flex-col border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 bg-background px-2 py-1.5 text-xs">
        <span className="w-20 truncate font-medium">
          {track.name || trackKindDisplayName(track.kind)}
        </span>

        <button
          type="button"
          onClick={toggleMuted}
          className={`rounded px-1.5 py-0.5 ${track.muted ? "bg-red-100 text-red-700" : "bg-muted hover:bg-primary/10"}`}
        >
          M
        </button>
        <button
          type="button"
          onClick={toggleSolo}
          className={`rounded px-1.5 py-0.5 ${track.solo ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"}`}
        >
          S
        </button>
        <button
          type="button"
          onClick={toggleLocked}
          className={`rounded px-1.5 py-0.5 ${track.locked ? "bg-yellow-100 text-yellow-700" : "bg-muted hover:bg-primary/10"}`}
        >
          L
        </button>

        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={track.volume}
          onChange={handleVolumeChange}
          className="w-20"
          aria-label={`${track.name} volume`}
        />

        {track.kind === "camera" ? (
          <button
            type="button"
            onClick={() => setShowPip((prev) => !prev)}
            className="ml-auto rounded bg-muted px-1.5 py-0.5 hover:bg-primary/10"
          >
            PiP
          </button>
        ) : null}
      </div>

      <div className="relative h-12 bg-muted/30" style={{ width: `${laneWidth}px` }}>
        {track.clips.map((clip) => (
          <TimelineClipView
            key={clip.id}
            clip={clip}
            selected={clip.id === selectedClipId}
            onSelect={onSelectClip}
          />
        ))}
      </div>

      {showPip && track.kind === "camera" ? (
        <PipControls
          track={track}
          selectedClipId={selectedClipId}
          onClose={() => setShowPip(false)}
        />
      ) : null}
    </div>
  )
}
